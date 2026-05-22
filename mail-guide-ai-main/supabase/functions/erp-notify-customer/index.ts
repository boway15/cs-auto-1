// ERP 订单拦截 — 客户通知邮件（API Key 鉴权，无 inbound 邮件）
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendMail } from "../_shared/smtp.ts";
import { renderErpNotifyTemplate } from "../_shared/erp-template-render.ts";
import { appendMailboxSignature } from "../_shared/mail-signature.ts";
import {
  erpNotifyJson,
  getErpNotifyCorsHeaders,
  verifyErpNotifyApiKey,
} from "../_shared/erp-notify-auth.ts";

const VALID_CODES = new Set(["risk_shopify", "risk_payoneer", "risk_qty_ge_4"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  const cors = getErpNotifyCorsHeaders();
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    if (!verifyErpNotifyApiKey(req)) {
      return erpNotifyJson(
        { success: false, error: { code: "UNAUTHORIZED", message: "鉴权失败" } },
        401,
      );
    }

    const body = await req.json();
    const template_code = String(body?.template_code ?? "").trim();
    const order_no = String(body?.order_no ?? "").trim();
    const to_email = String(body?.to_email ?? "").trim().toLowerCase();
    const idempotency_key = String(body?.idempotency_key ?? "").trim();

    if (!template_code || !order_no || !to_email || !idempotency_key) {
      return erpNotifyJson(
        { success: false, error: { code: "INVALID_REQUEST", message: "缺少必填字段" } },
        400,
      );
    }
    if (!VALID_CODES.has(template_code)) {
      return erpNotifyJson(
        { success: false, error: { code: "INVALID_TEMPLATE", message: "template_code 无效" } },
        400,
      );
    }
    if (!EMAIL_RE.test(to_email)) {
      return erpNotifyJson(
        { success: false, error: { code: "INVALID_REQUEST", message: "to_email 格式无效" } },
        400,
      );
    }
    if (idempotency_key.length > 128) {
      return erpNotifyJson(
        { success: false, error: { code: "INVALID_REQUEST", message: "idempotency_key 过长" } },
        400,
      );
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: existingLog } = await admin
      .from("email_send_logs")
      .select("id, status, message_id, send_no, from_email, to_email, subject, metadata")
      .eq("idempotency_key", idempotency_key)
      .maybeSingle();

    if (existingLog?.status === "sent") {
      const meta = (existingLog.metadata ?? {}) as Record<string, unknown>;
      return erpNotifyJson({
        success: true,
        deduped: true,
        send_log_id: existingLog.id,
        send_no: existingLog.send_no,
        template_code: meta.template_code ?? template_code,
        order_no: meta.order_no ?? order_no,
        from_email: existingLog.from_email,
        to_email: existingLog.to_email,
        subject: existingLog.subject,
        message_id: existingLog.message_id,
      });
    }

    const { data: tpl, error: tplErr } = await admin
      .from("erp_notify_templates")
      .select("*")
      .eq("template_code", template_code)
      .single();

    if (tplErr || !tpl) {
      return erpNotifyJson(
        { success: false, error: { code: "INVALID_TEMPLATE", message: "模板不存在" } },
        400,
      );
    }
    if (!tpl.is_active) {
      return erpNotifyJson(
        { success: false, error: { code: "TEMPLATE_DISABLED", message: "模板已停用" } },
        404,
      );
    }

    const senderEmail = (tpl.sender_email ?? "").trim();
    if (!senderEmail) {
      return erpNotifyJson(
        {
          success: false,
          error: { code: "SENDER_NOT_CONFIGURED", message: "该场景未配置发件邮箱" },
        },
        422,
      );
    }

    const { data: mb, error: mbErr } = await admin
      .from("mailboxes")
      .select("*")
      .eq("email_address", senderEmail)
      .eq("is_active", true)
      .maybeSingle();

    if (mbErr || !mb) {
      return erpNotifyJson(
        {
          success: false,
          error: { code: "SENDER_NOT_CONFIGURED", message: "发件邮箱未找到或未启用" },
        },
        422,
      );
    }
    if (!mb.smtp_host || !mb.smtp_port) {
      return erpNotifyJson(
        {
          success: false,
          error: { code: "MAILBOX_SMTP_MISSING", message: "发件邮箱未配置 SMTP" },
        },
        422,
      );
    }

    const subject = renderErpNotifyTemplate(tpl.subject_template ?? "", { order_no });
    let content = renderErpNotifyTemplate(tpl.body_template ?? "", { order_no });
    content = appendMailboxSignature(content, mb);

    let messageId = "";
    let sendError: string | null = null;
    try {
      messageId = await sendMail(mb, { to: to_email, subject, text: content });
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
    }

    const { data: orderRow } = await admin
      .from("orders")
      .select("id")
      .eq("order_no", order_no)
      .maybeSingle();

    const metadata = {
      source: "erp",
      template_code,
      order_no,
      erp_template_id: tpl.id,
    };

    const sendLogPayload = {
      email_id: null,
      mailbox_id: mb.id,
      template_id: null,
      order_id: orderRow?.id ?? null,
      to_email,
      from_email: mb.email_address,
      subject,
      content,
      send_type: "erp_notify",
      status: sendError ? "failed" : "sent",
      error_message: sendError,
      smtp_response: sendError ? null : "250 accepted",
      message_id: messageId || null,
      sent_by: null,
      retry_count: existingLog ? ((existingLog as { retry_count?: number }).retry_count ?? 0) + 1 : 0,
      idempotency_key,
      metadata,
    };

    let send_log_id: string;
    let send_no: string | null = null;
    if (existingLog?.id) {
      const { data: updated, error: upErr } = await admin
        .from("email_send_logs")
        .update(sendLogPayload)
        .eq("id", existingLog.id)
        .select("id, send_no")
        .single();
      if (upErr) throw upErr;
      send_log_id = updated.id;
      send_no = updated.send_no;
    } else {
      const { data: inserted, error: insErr } = await admin
        .from("email_send_logs")
        .insert(sendLogPayload)
        .select("id, send_no")
        .single();
      if (insErr) throw insErr;
      send_log_id = inserted.id;
      send_no = inserted.send_no;
    }

    if (sendError) {
      return erpNotifyJson(
        {
          success: false,
          send_log_id,
          error: { code: "SMTP_SEND_FAILED", message: sendError },
        },
        500,
      );
    }

    return erpNotifyJson({
      success: true,
      deduped: false,
      send_log_id,
      send_no,
      template_code,
      order_no,
      from_email: mb.email_address,
      to_email,
      subject,
      message_id: messageId,
    });
  } catch (e) {
    console.error("erp-notify-customer error:", e);
    return erpNotifyJson(
      {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: e instanceof Error ? e.message : "未知错误",
        },
      },
      500,
    );
  }
});
