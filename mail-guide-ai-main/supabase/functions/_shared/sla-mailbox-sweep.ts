import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { enqueueBodyRepairTask, triggerPostRepairProcessing } from "./email-body-repair-queue.ts";
import { hasReadableEmailBody } from "./mime-parse.ts";

const DEFAULT_SLA_HOURS = 12;

function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isBodyEmpty(bodyText: unknown, bodyHtml: unknown): boolean {
  return !hasReadableEmailBody(
    typeof bodyText === "string" ? bodyText : String(bodyText ?? ""),
    typeof bodyHtml === "string" ? bodyHtml : String(bodyHtml ?? ""),
  );
}

export type SlaSweepResult = {
  empty_body_enqueued: number;
  analysis_triggered: number;
  analysis_failed: number;
};

/** 12h 窗内：空正文入 interactive 队列；有正文未分析则触发 process-email */
export async function sweepSlaMailbox(
  admin: ReturnType<typeof createClient>,
  mailboxId: string,
  supabaseUrl: string,
  serviceKey: string,
  slaHours: number = parseEnvPositiveInt("MAIL_SLA_SYNC_HOURS", DEFAULT_SLA_HOURS),
): Promise<SlaSweepResult> {
  const sinceIso = new Date(Date.now() - slaHours * 3600 * 1000).toISOString();
  const emptyLimit = parseEnvPositiveInt("MAIL_SLA_SWEEP_EMPTY_BODY_LIMIT", 20);
  const analyzeLimit = parseEnvPositiveInt("MAIL_SLA_SWEEP_ANALYZE_LIMIT", 10);

  const result: SlaSweepResult = {
    empty_body_enqueued: 0,
    analysis_triggered: 0,
    analysis_failed: 0,
  };

  const { data: emptyRows } = await admin
    .from("emails")
    .select("id, body_text, body_html")
    .eq("mailbox_id", mailboxId)
    .gte("received_at", sinceIso)
    .order("received_at", { ascending: false })
    .limit(emptyLimit * 2);

  for (const row of emptyRows ?? []) {
    if (result.empty_body_enqueued >= emptyLimit) break;
    if (!isBodyEmpty(row.body_text, row.body_html)) continue;
    const { enqueued } = await enqueueBodyRepairTask(
      admin,
      row.id,
      "sla_12h_empty_body",
      "interactive",
    );
    if (enqueued) result.empty_body_enqueued++;
  }

  const { data: analyzeRows } = await admin
    .from("emails")
    .select("id, body_text, body_html, ai_analyzed_at")
    .eq("mailbox_id", mailboxId)
    .gte("received_at", sinceIso)
    .is("ai_analyzed_at", null)
    .order("received_at", { ascending: false })
    .limit(analyzeLimit * 2);

  let triggered = 0;
  for (const row of analyzeRows ?? []) {
    if (triggered >= analyzeLimit) break;
    if (isBodyEmpty(row.body_text, row.body_html)) continue;
    const post = await triggerPostRepairProcessing(supabaseUrl, serviceKey, row.id);
    if (post.ok) {
      result.analysis_triggered++;
      triggered++;
    } else {
      result.analysis_failed++;
    }
  }

  return result;
}
