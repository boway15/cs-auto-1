// 人工结案：将邮件 status 置为 closed（业务上的「已处理」）
// 与 send-reply 完成的「已回复」自动结案区分；要求 staff 鉴权
// 写入 email_processing_events + audit_logs

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

async function getStaffActor(req: Request, admin: any) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Response(JSON.stringify({ error: "未授权" }), { status: 401, headers: corsHeaders });
  if (token === SERVICE_KEY) return { userId: null, isService: true };
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data } = await userClient.auth.getUser();
  if (!data.user) throw new Response(JSON.stringify({ error: "未登录" }), { status: 401, headers: corsHeaders });
  const { data: isStaff } = await admin.rpc("is_staff", { _user_id: data.user.id });
  if (!isStaff) throw new Response(JSON.stringify({ error: "权限不足" }), { status: 403, headers: corsHeaders });
  return { userId: data.user.id, isService: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    const actor = await getStaffActor(req, admin);
    const { email_id, reason } = await req.json();
    if (!email_id) {
      return new Response(JSON.stringify({ error: "缺少 email_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: before } = await admin
      .from("emails")
      .select("id, status, closed_at, closed_by")
      .eq("id", email_id)
      .single();
    if (!before) {
      return new Response(JSON.stringify({ error: "邮件不存在" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (before.status === "closed") {
      return new Response(JSON.stringify({ ok: true, deduped: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const nowIso = new Date().toISOString();
    const { data: after, error: updErr } = await admin
      .from("emails")
      .update({
        status: "closed",
        processing_status: "closed",
        closed_at: nowIso,
        closed_by: actor.userId,
        sla_bucket: null,
      })
      .eq("id", email_id)
      .select("id, status, closed_at, closed_by")
      .single();
    if (updErr) throw updErr;

    await admin.from("email_processing_events").insert({
      email_id,
      event_type: "status_closed_by_user",
      actor_type: actor.isService ? "system" : "user",
      actor_id: actor.userId,
      title: "客服已结案（已处理）",
      detail: reason ?? null,
      metadata: { reason: reason ?? null },
    });

    await admin.from("audit_logs").insert({
      actor_id: actor.userId,
      target_table: "emails",
      target_id: email_id,
      action: "close_email",
      before_data: before,
      after_data: after,
    });

    return new Response(JSON.stringify({ ok: true, email: after }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("close-email error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
