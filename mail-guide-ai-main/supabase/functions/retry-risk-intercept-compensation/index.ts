import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  getRiskAutoInterceptEnabled,
  isEmailWithinCustomerAutomationAge,
  MAX_COMPENSATION_ATTEMPTS,
} from "../_shared/auto-risk-intercept-policy.ts";
import { notifyAutoInterceptFinalFromLogRow } from "../_shared/automation-intercept-alerts.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const corsJsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function mergeErrorMessage(msg: string | null | undefined, tag: string): string {
  const m = String(msg ?? "").trim();
  const t = tag.trim();
  if (!m) return t;
  if (m.includes(t)) return m;
  return `${m} ${t}`;
}

async function failLogWithPolicyTag(
  admin: ReturnType<typeof createClient>,
  log: {
    id: string;
    error_message?: string | null;
    email_id?: string | null;
    order_id?: string | null;
    referenced_order_no?: string | null;
  },
  tag: string,
  reason: string,
): Promise<boolean> {
  const { error: upErr } = await admin
    .from("risk_intercept_logs")
    .update({
      status: "failed",
      auto_compensation_eligible: false,
      next_compensation_at: null,
      retrying_started_at: null,
      error_message: mergeErrorMessage(log.error_message, tag),
    })
    .eq("id", log.id);
  if (upErr) return false;
  await notifyAutoInterceptFinalFromLogRow(
    admin,
    { ...log, error_message: mergeErrorMessage(log.error_message, tag) },
    reason,
  );
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token !== SERVICE_KEY) {
    return new Response(JSON.stringify({ error: "仅允许服务角色" }), {
      status: 401,
      headers: corsJsonHeaders,
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    const enabled = await getRiskAutoInterceptEnabled(admin);

    if (!enabled) {
      const { data: stuck, error: selErr } = await admin
        .from("risk_intercept_logs")
        .select("id, email_id, order_id, referenced_order_no, error_message")
        .eq("status", "retrying")
        .eq("auto_compensation_eligible", true);
      if (selErr) throw selErr;
      let closed = 0;
      for (const row of stuck ?? []) {
        if (await failLogWithPolicyTag(admin, row as { id: string; error_message?: string | null; email_id?: string | null; order_id?: string | null; referenced_order_no?: string | null }, "[policy:disabled]", "policy_disabled")) {
          closed++;
        }
      }
      return new Response(JSON.stringify({ ok: true, policy_disabled_closed: closed }), {
        headers: corsJsonHeaders,
      });
    }

    const nowIso = new Date().toISOString();
    const { data: logs, error: logErr } = await admin
      .from("risk_intercept_logs")
      .select("*")
      .eq("status", "retrying")
      .eq("auto_compensation_eligible", true)
      .lt("compensation_attempts_done", MAX_COMPENSATION_ATTEMPTS)
      .lte("next_compensation_at", nowIso)
      .order("next_compensation_at", { ascending: true })
      .limit(20);
    if (logErr) throw logErr;

    const results: Record<string, unknown>[] = [];

    for (const log of logs ?? []) {
      const logId = String(log.id);
      const emailId = log.email_id ? String(log.email_id) : null;

      if (!emailId) {
        if (await failLogWithPolicyTag(admin, log, "[policy:no_email]", "no_email")) {
          results.push({ id: logId, result: "failed_no_email" });
        }
        continue;
      }

      const { data: em, error: emErr } = await admin
        .from("emails")
        .select("received_at")
        .eq("id", emailId)
        .maybeSingle();
      if (emErr || !em) {
        if (await failLogWithPolicyTag(admin, log, "[policy:stale_email]", "stale_email")) {
          results.push({ id: logId, result: "failed_email_missing" });
        }
        continue;
      }
      const receivedAt = (em as { received_at?: string | null }).received_at;
      if (!isEmailWithinCustomerAutomationAge(receivedAt ?? null)) {
        if (await failLogWithPolicyTag(admin, log, "[policy:stale_email]", "stale_email")) {
          results.push({ id: logId, result: "failed_stale_email" });
        }
        continue;
      }

      const orderId = log.order_id ? String(log.order_id) : "";
      const refNo = log.referenced_order_no ? String(log.referenced_order_no).trim() : "";
      const action = String(log.action ?? "hold") === "release" ? "release" : "hold";
      const body: Record<string, unknown> = {
        email_id: emailId,
        action,
        intercept_reason: log.intercept_reason,
        reason_category: log.reason_category,
        trigger_source: "retry",
        idempotency_key: log.idempotency_key,
      };
      if (orderId) {
        body.order_id = orderId;
      } else if (refNo) {
        body.order_no = refNo;
      } else {
        if (await failLogWithPolicyTag(admin, log, "[policy:no_order_ref]", "no_order_ref")) {
          results.push({ id: logId, result: "failed_no_order_ref" });
        }
        continue;
      }

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/risk-intercept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      let parsed: { ok?: boolean; skipped?: boolean; reason?: string; error?: string } | null = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (resp.ok && parsed?.skipped) {
        results.push({ id: logId, result: "skipped", reason: parsed.reason });
        continue;
      }
      if (!resp.ok) {
        results.push({ id: logId, result: "http_error", status: resp.status, body: text.slice(0, 500) });
        continue;
      }
      results.push({ id: logId, result: "invoked" });
    }

    return new Response(
      JSON.stringify({ ok: true, processed: results.length, results }),
      { headers: corsJsonHeaders },
    );
  } catch (e) {
    console.error("retry-risk-intercept-compensation:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: corsJsonHeaders,
    });
  }
});
