// SMTP 发件 Edge Function（Deno 原生实现，不依赖 nodemailer）
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendMail } from "../_shared/smtp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) {
      return new Response(JSON.stringify({ error: "未登录" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { email_id, content, subject_override, idempotency_key } = await req.json();
    if (!email_id || !content) {
      return new Response(JSON.stringify({ error: "缺少 email_id 或 content" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: email, error: emailErr } = await admin
      .from("emails")
      .select("*, mailboxes(*)")
      .eq("id", email_id)
      .single();
    if (emailErr || !email) throw new Error("邮件不存在");

    const mb = email.mailboxes;
    if (!mb) throw new Error("该邮件没有关联邮箱配置，无法发送");
    if (!mb.smtp_host || !mb.smtp_port) throw new Error("邮箱未配置 SMTP 服务器");

    const sendKey = idempotency_key ?? `manual:${email_id}:${userData.user.id}:${await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)).then((buf) => Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join(""))}`;
    const { data: existingLog } = await admin
      .from("email_send_logs")
      .select("id, status, message_id, retry_count")
      .eq("idempotency_key", sendKey)
      .maybeSingle();
    if (existingLog?.status === "sent") {
      return new Response(
        JSON.stringify({ success: true, messageId: existingLog.message_id, deduped: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: linkRows } = await admin
      .from("email_order_links")
      .select("order_id")
      .eq("email_id", email_id)
      .limit(1);

    const replySubject = subject_override
      || (email.subject?.startsWith("Re:") ? email.subject : `Re: ${email.subject ?? ""}`);

    let messageId = "";
    let sendError: string | null = null;
    try {
      messageId = await sendMail(mb, {
        to: email.from_email,
        subject: replySubject,
        text: content,
        inReplyTo: email.message_id ?? undefined,
        references: email.message_id ?? undefined,
      });
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }

    // 写入发送日志（无论成功失败）
    const sendLogPayload = {
      email_id,
      mailbox_id: mb.id,
      order_id: linkRows?.[0]?.order_id ?? null,
      to_email: email.from_email,
      from_email: mb.email_address,
      subject: replySubject,
      content,
      send_type: "manual",
      status: sendError ? "failed" : "sent",
      error_message: sendError,
      smtp_response: sendError ? null : "250 accepted",
      message_id: messageId || null,
      sent_by: userData.user.id,
      retry_count: existingLog ? (existingLog.retry_count ?? 0) + 1 : 0,
      idempotency_key: sendKey,
    };
    const { error: sendLogError } = existingLog
      ? await admin.from("email_send_logs").update(sendLogPayload).eq("id", existingLog.id)
      : await admin.from("email_send_logs").insert(sendLogPayload);

    if (sendLogError) {
      console.error("email_send_logs write failed:", sendLogError);
    }

    if (sendError) throw new Error(sendError);

    await admin
      .from("emails")
      .update({ status: "replied", processing_status: "manual_replied", assigned_to: userData.user.id })
      .eq("id", email_id);

    await admin.from("email_processing_events").insert({
      email_id,
      event_type: "reply_sent",
      actor_type: "user",
      actor_id: userData.user.id,
      title: "客服已发送回复",
      metadata: { message_id: messageId },
    });

    const { data: latestDraft } = await admin
      .from("ai_drafts")
      .select("id")
      .eq("email_id", email_id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestDraft?.id) {
      await admin.from("ai_drafts").update({ is_used: true }).eq("id", latestDraft.id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        messageId,
        warning: sendLogError ? "邮件已发送，但发送日志写入失败，请联系管理员检查 email_send_logs 表结构或权限。" : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("send-reply error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
