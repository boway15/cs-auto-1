import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  isAuthorizedMailSyncWorkerToken,
  parseEnvPositiveInt,
} from "../_shared/mail-sync-worker-auth.ts";
import { sweepSlaMailbox } from "../_shared/sla-mailbox-sweep.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_KEY = Deno.env.get("CRON_SERVICE_ROLE_KEY");

const SLA_HOURS = parseEnvPositiveInt("MAIL_SLA_SYNC_HOURS", 12);
const MAILBOX_WALL_MS = parseEnvPositiveInt("MAIL_SLA_MAILBOX_WALL_MS", 90_000);

type SyncMailboxResult = {
  remaining?: number;
  sla_scan_offset?: number;
  inserted?: number;
  error?: string;
  mode?: string;
};

async function callSlaSync(
  mailboxId: string,
  slaScanOffset: number,
): Promise<SyncMailboxResult | null> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/sync-mailbox`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mailbox_id: mailboxId,
      sync_sla_hours: SLA_HOURS,
      sla_scan_offset: slaScanOffset,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text.slice(0, 500));
  }
  const body = await resp.json().catch(() => ({}));
  const row = Array.isArray(body?.results) ? body.results[0] : null;
  return row as SyncMailboxResult | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!isAuthorizedMailSyncWorkerToken(token, SERVICE_KEY, CRON_KEY)) {
      return new Response(JSON.stringify({ error: "仅允许服务角色执行 SLA 邮箱补扫" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: mailboxes, error: mbErr } = await admin
      .from("mailboxes")
      .select("id, email_address, sla_resync_scan_offset")
      .eq("is_active", true);
    if (mbErr) throw mbErr;

    const results: Record<string, unknown>[] = [];

    for (const mb of mailboxes ?? []) {
      const mailboxStarted = Date.now();
      let rounds = 0;
      let remaining = 1;
      let scanOffset = typeof mb.sla_resync_scan_offset === "number"
        ? Math.max(0, Math.floor(mb.sla_resync_scan_offset))
        : 0;
      let lastInserted = 0;
      let lastError: string | undefined;

      while (remaining > 0 && Date.now() - mailboxStarted < MAILBOX_WALL_MS) {
        const row = await callSlaSync(mb.id, scanOffset);
        rounds++;
        remaining = typeof row?.remaining === "number" ? row.remaining : 0;
        lastInserted += Number(row?.inserted ?? 0);
        if (typeof row?.sla_scan_offset === "number") {
          scanOffset = row.sla_scan_offset;
        }
        if (row?.error) {
          lastError = row.error;
          break;
        }
      }

      const sweep = await sweepSlaMailbox(
        admin,
        mb.id,
        SUPABASE_URL,
        SERVICE_KEY,
        SLA_HOURS,
      );

      results.push({
        mailbox_id: mb.id,
        email: mb.email_address,
        rounds,
        remaining,
        scan_offset: scanOffset,
        inserted: lastInserted,
        error: lastError,
        sweep,
        wall_ms: Date.now() - mailboxStarted,
      });
    }

    return new Response(JSON.stringify({
      sla_hours: SLA_HOURS,
      mailbox_count: mailboxes?.length ?? 0,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-sla-mailbox-sync error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "未知错误",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
