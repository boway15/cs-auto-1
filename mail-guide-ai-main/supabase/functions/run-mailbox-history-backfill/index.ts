import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  isAuthorizedMailSyncWorkerToken,
  parseEnvPositiveInt,
} from "../_shared/mail-sync-worker-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_KEY = Deno.env.get("CRON_SERVICE_ROLE_KEY");

const WALL_MS = parseEnvPositiveInt("MAIL_HISTORY_BACKFILL_WALL_MS", 120_000);

type SyncMailboxResult = {
  remaining?: number;
  inserted?: number;
  error?: string;
  mode?: string;
};

async function callHistoryBackfill(mailboxId: string): Promise<SyncMailboxResult | null> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/sync-mailbox`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mailbox_id: mailboxId,
      force_bulk: true,
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
      return new Response(JSON.stringify({ error: "仅允许服务角色执行历史邮件后台回补" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const nowIso = new Date().toISOString();
    const { data: mailboxes, error: mbErr } = await admin
      .from("mailboxes")
      .select("id, email_address, history_backfill_auto_continue")
      .eq("is_active", true)
      .eq("history_backfill_auto_continue", true);
    if (mbErr) throw mbErr;

    const results: Record<string, unknown>[] = [];

    for (const mb of mailboxes ?? []) {
      const mailboxStarted = Date.now();
      let rounds = 0;
      let remaining = 1;
      let totalInserted = 0;
      let lastError: string | undefined;

      while (remaining > 0 && Date.now() - mailboxStarted < WALL_MS) {
        const row = await callHistoryBackfill(mb.id);
        rounds++;
        remaining = typeof row?.remaining === "number" ? row.remaining : 0;
        totalInserted += Number(row?.inserted ?? 0);
        if (row?.error) {
          lastError = row.error;
          break;
        }
      }

      await admin.from("mailboxes").update({
        history_backfill_last_at: nowIso,
      }).eq("id", mb.id);

      results.push({
        mailbox_id: mb.id,
        email: mb.email_address,
        rounds,
        remaining,
        inserted: totalInserted,
        error: lastError,
        wall_ms: Date.now() - mailboxStarted,
      });
    }

    return new Response(JSON.stringify({
      mailbox_count: mailboxes?.length ?? 0,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("run-mailbox-history-backfill error:", error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : "未知错误",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
