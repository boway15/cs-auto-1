// 自动草稿调度（每 30 分钟由 pg_cron 触发，仅服务角色可调用）
// 业务规则：
//   - 仅处理 status in (pending, processing) 且当前无非空草稿的邮件
//   - 仅处理 received_at 在 24 小时内的邮件，>=24h（库内查不到）仅人工本地生成
//   - <1h：不自动出草稿（留给同步/分类；避免刚入库就反复打 Dify）
//   - 1h-6h：调用 Dify 长草稿（每 30 分钟 tick 仍会跑；已有草稿的邮件会被排除）
//   - 6h-24h：本地短草稿
//   - 失败：写事件 draft_auto_failed（不告警；属低危）

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  buildLocalDraft,
  callDifyDraftWorkflow,
  insertDraft,
  type EmailRow,
  type OrderRow,
} from "../_shared/draft.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BATCH_LIMIT = Number(Deno.env.get("DRAFT_SCHEDULE_BATCH") ?? "50");

async function recordEvent(admin: any, emailId: string, event_type: string, title: string, detail?: string, metadata: Record<string, unknown> = {}) {
  await admin.from("email_processing_events").insert({
    email_id: emailId,
    event_type,
    title,
    detail: detail ?? null,
    metadata,
  });
}

async function loadOrders(admin: any, emailId: string): Promise<OrderRow[]> {
  const { data: links } = await admin
    .from("email_order_links")
    .select("orders(*)")
    .eq("email_id", emailId);
  return ((links ?? []).map((l: any) => l.orders).filter(Boolean)) as OrderRow[];
}

interface Candidate { id: string; received_at: string; ageMs: number; }

async function pickCandidates(admin: any): Promise<Candidate[]> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // 取近 24h 待处理/处理中且无非空草稿的邮件
  // 用两步：先拉候选，再过滤已有草稿（避免在 PostgREST 中复杂 join）
  const { data: emails, error } = await admin
    .from("emails")
    .select("id, received_at")
    .in("status", ["pending", "processing"])
    .gte("received_at", sinceIso)
    .order("received_at", { ascending: false })
    .limit(BATCH_LIMIT * 4); // 留一些冗余以便过滤
  if (error) throw error;
  if (!emails?.length) return [];

  const ids = emails.map((e: any) => e.id);
  const { data: drafts } = await admin
    .from("ai_drafts")
    .select("email_id, draft_content")
    .in("email_id", ids);
  const haveDraft = new Set<string>();
  for (const d of drafts ?? []) {
    if (d.draft_content && String(d.draft_content).trim().length > 0) {
      haveDraft.add(d.email_id);
    }
  }

  const now = Date.now();
  const minAgeMs = 60 * 60 * 1000; // 满 1 小时才参与自动草稿
  return emails
    .filter((e: any) => !haveDraft.has(e.id))
    .map((e: any) => ({
      id: e.id,
      received_at: e.received_at,
      ageMs: now - new Date(e.received_at).getTime(),
    }))
    .filter((c: Candidate) => Number.isFinite(c.ageMs) && c.ageMs >= minAgeMs)
    .slice(0, BATCH_LIMIT);
}

async function generateForCandidate(admin: any, candidate: Candidate) {
  const { data: emailRow } = await admin
    .from("emails")
    .select("id, subject, body_text, from_email, from_name, ai_summary")
    .eq("id", candidate.id)
    .single();
  if (!emailRow) return { id: candidate.id, status: "skipped", reason: "邮件不存在" };

  const orders = await loadOrders(admin, candidate.id);
  const ageHour = candidate.ageMs / 3_600_000;
  // 1h≤age<6h：Dify；6h≤age<24h：本地（候选已在 pickCandidates 中保证 ≥1h）
  const useDify = ageHour < 6;

  try {
    let content: string;
    let model: string;
    if (useDify) {
      content = await callDifyDraftWorkflow(emailRow as EmailRow, orders);
      model = "dify-workflow";
    } else {
      content = buildLocalDraft(emailRow as EmailRow, orders, emailRow.ai_summary);
      model = "pipeline-local";
    }
    const version = await insertDraft(admin, candidate.id, content, model, null, null);
    await recordEvent(
      admin,
      candidate.id,
      useDify ? "draft_auto_generated_dify" : "draft_auto_generated_local",
      `自动草稿 v${version} 已生成（${useDify ? "Dify" : "本地"}）`,
      undefined,
      { age_hours: Math.round(ageHour * 10) / 10, model },
    );
    return { id: candidate.id, status: "ok", model, version };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[schedule-draft] generate failed:", candidate.id, msg);
    await recordEvent(
      admin,
      candidate.id,
      "draft_auto_failed",
      `自动草稿生成失败（${useDify ? "Dify" : "本地"}）`,
      msg,
      { age_hours: Math.round(ageHour * 10) / 10, channel: useDify ? "dify" : "local" },
    );
    return { id: candidate.id, status: "failed", error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (token !== SERVICE_KEY) {
      return new Response(JSON.stringify({ error: "仅允许服务角色调用" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const candidates = await pickCandidates(admin);

    if (candidates.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ id: string; status: string; model?: string; version?: number; error?: string; reason?: string }> = [];
    for (const c of candidates) {
      results.push(await generateForCandidate(admin, c));
    }

    return new Response(
      JSON.stringify({
        ok: true,
        processed: results.length,
        succeeded: results.filter((r) => r.status === "ok").length,
        failed: results.filter((r) => r.status === "failed").length,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("schedule-draft-generation error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
