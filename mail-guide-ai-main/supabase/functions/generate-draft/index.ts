// 人工触发的草稿生成 Edge Function
// 业务规则：
//   - 本接口服务「人工再生成」，默认走 Dify 工作流（callDifyDraftWorkflow），
//     传入用户「指导思想」（guidance），由工作流结合邮件与订单上下文生成草稿
//   - 当 Dify 未配置 / 调用失败时：
//       * mode === 'dify'（默认）+ GENERATE_DRAFT_FALLBACK_LOCAL=true → 回落本地，model=pipeline-local-fallback
//       * 否则直接 502，让用户感知问题（避免悄悄退化为关键词模板）
//   - 客户端可强制 mode='local' 跳过 Dify（保留旧能力作为兜底开关）
//   - 自动草稿（1-6h Dify、6-24h 本地）由 schedule-draft-generation（pg_cron 每 4 分钟自第 2 分起）负责

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { buildLocalDraft, callDifyDraftWorkflow, insertDraft } from "../_shared/draft.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function envBool(key: string, defaultValue: boolean): boolean {
  const v = Deno.env.get(key);
  if (v == null || v === "") return defaultValue;
  return !/^(false|0|off|no)$/i.test(v.trim());
}

type DraftMode = "dify" | "local";

function normalizeMode(raw: unknown): DraftMode {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "local") return "local";
  return "dify";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return new Response(JSON.stringify({ error: "未登录" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = await req.json().catch(() => ({}));
    const email_id = payload?.email_id;
    const guidance: string | null = payload?.guidance ?? null;
    const mode = normalizeMode(payload?.mode);
    const guidanceLen =
      typeof guidance === "string" ? guidance.trim().length : 0;
    console.log(
      `[generate-draft] email_id=${email_id} guidance_field_present=${Object.prototype.hasOwnProperty.call(payload, "guidance")} guidance_len=${guidanceLen}`,
    );

    if (!email_id) {
      return new Response(JSON.stringify({ error: "缺少 email_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: email, error: emailErr } = await supabase
      .from("emails")
      .select("id, subject, body_text, from_email, from_name, ai_summary, ai_language, ai_sentiment, status")
      .eq("id", email_id)
      .single();
    if (emailErr || !email) throw new Error("邮件不存在");

    const { data: links } = await supabase
      .from("email_order_links")
      .select("orders(*)")
      .eq("email_id", email_id);
    const orders = (links ?? []).map((l: any) => l.orders).filter(Boolean);

    let content: string;
    let model: string;
    let usedFallback = false;
    let difyError: string | null = null;

    if (mode === "dify") {
      try {
        content = await callDifyDraftWorkflow(
          email as any,
          orders,
          guidance,
        );
        model = "dify-workflow";
      } catch (e) {
        difyError = e instanceof Error ? e.message : String(e);
        console.error("[generate-draft] Dify 调用失败:", difyError);

        const allowFallback = envBool("GENERATE_DRAFT_FALLBACK_LOCAL", true);
        if (!allowFallback) {
          await supabase.from("email_processing_events").insert({
            email_id,
            event_type: "draft_manual_dify_failed",
            actor_type: "user",
            actor_id: userData.user.id,
            title: "人工生成草稿（Dify）失败",
            detail: difyError,
            metadata: { mode, allow_fallback: false },
          });
          return new Response(
            JSON.stringify({ error: `Dify 工作流调用失败：${difyError}` }),
            { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        content = buildLocalDraft(email as any, orders, email.ai_summary);
        model = "pipeline-local-fallback";
        usedFallback = true;
      }
    } else {
      content = buildLocalDraft(email as any, orders, email.ai_summary);
      model = "pipeline-local";
    }

    const version = await insertDraft(
      supabase,
      email_id,
      content,
      model,
      guidance,
      userData.user.id,
    );

    await supabase
      .from("emails")
      .update({ status: "processing" })
      .eq("id", email_id)
      .eq("status", "pending");

    const eventType = usedFallback
      ? "draft_manual_generated_local_fallback"
      : mode === "dify"
      ? "draft_manual_generated_dify"
      : "draft_manual_generated_local";
    const eventTitle = usedFallback
      ? `人工生成草稿 v${version}（Dify 失败，本地兜底）`
      : mode === "dify"
      ? `人工生成草稿 v${version}（Dify 工作流）`
      : `人工生成草稿 v${version}（本地）`;

    await supabase.from("email_processing_events").insert({
      email_id,
      event_type: eventType,
      actor_type: "user",
      actor_id: userData.user.id,
      title: eventTitle,
      detail: guidance ?? null,
      metadata: {
        mode,
        model,
        dify_error: difyError,
      },
    });

    return new Response(
      JSON.stringify({
        draft: { email_id, version, draft_content: content, model },
        used_fallback: usedFallback,
        dify_error: difyError,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("generate-draft error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
