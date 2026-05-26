import { supabase } from "@/lib/supabase";
import { formatFunctionsInvokeError } from "@/lib/format-functions-invoke-error";

export function isEmailBodyEmpty(email: {
  body_text?: string | null;
  body_html?: string | null;
}): boolean {
  return !String(email.body_text ?? "").trim() && !String(email.body_html ?? "").trim();
}

function looksLikeQuotedPrintable(s: string): boolean {
  return /=([0-9A-Fa-f]{2})(?![0-9A-Fa-f])/.test(s) || /=\r?\n/.test(s);
}

/** 展示前解码 quoted-printable（兼容历史入库脏数据） */
export function decodeQuotedPrintableLoose(input: string): string {
  if (!looksLikeQuotedPrintable(input)) return input;
  const buf: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "=") {
      if (i + 2 < input.length) {
        if (input[i + 1] === "\r" && input[i + 2] === "\n") {
          i += 2;
          continue;
        }
        if (input[i + 1] === "\n") {
          i += 1;
          continue;
        }
        const hex = input.substring(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          buf.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
    } else if (input[i] !== "\r" && input[i] !== "\n") {
      buf.push(input.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(buf));
  } catch {
    return input;
  }
}

function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 判断字符串是否像 HTML 邮件正文（Gmail 等常把 HTML 落在 body_text） */
export function looksLikeHtmlEmailContent(s: string): boolean {
  if (!s?.trim()) return false;
  return /<(html|head|body|div|p|table|tr|td|th|span|a|br|img|ul|ol|li|h[1-6]|blockquote|strong|em|pre|code|hr|style|meta|font|center)\b[\s>]/i.test(
    s,
  );
}

/** 将 body_text/body_html 规范为可展示内容（解码 QP、优先 HTML） */
export function normalizeEmailBodyForDisplay(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): { text: string; html: string | null } {
  let html = bodyHtml?.trim() ? bodyHtml.trim() : null;
  let text = bodyText?.trim() ?? "";

  if (html && looksLikeQuotedPrintable(html)) {
    html = decodeQuotedPrintableLoose(html);
  }
  if (!html && text && looksLikeQuotedPrintable(text)) {
    const decoded = decodeQuotedPrintableLoose(text);
    if (looksLikeHtmlEmailContent(decoded)) {
      html = decoded;
      text = htmlToPlainText(decoded);
    } else {
      text = decoded;
    }
  }
  if (!html && text && looksLikeHtmlEmailContent(text)) {
    html = text;
    text = htmlToPlainText(text);
  }
  if (html && !text) {
    text = htmlToPlainText(html);
  }
  return { text, html };
}

/** 供 EmailBody 单字段入参使用 */
export function normalizeEmailBodyContent(content: string | null | undefined): {
  text: string;
  html: string | null;
} {
  const raw = content?.trim() ?? "";
  if (!raw) return { text: "", html: null };
  return normalizeEmailBodyForDisplay(raw, null);
}

export const BODY_REPAIR_COOLDOWN_MS = 8 * 60 * 1000;

export type BodyRepairUiStatus =
  | "idle"
  | "quick"
  | "queued"
  | "not_found_retrying"
  | "failed"
  | "failed_terminal"
  | "done";

export type RepairEmailBodyResult =
  | { ok: true; repaired: true }
  | { ok: true; repaired: false; skipped: true }
  | { ok: true; repaired: false; queued: true; queueReason?: string }
  | { ok: false; errorMessage: string; terminal?: boolean };

type SyncRepairRow = {
  error?: string;
  skipped?: boolean;
  repaired?: number;
  queued?: boolean;
  queue_reason?: string;
  terminal?: boolean;
};

/** 将 sync-mailbox repair_email_id 单行结果映射为前端类型 */
export function mapSyncRepairRow(row: SyncRepairRow | undefined): RepairEmailBodyResult {
  if (!row) {
    return { ok: false, errorMessage: "未获取到补正文结果" };
  }
  if (row.queued) {
    return {
      ok: true,
      repaired: false,
      queued: true,
      queueReason: row.queue_reason,
    };
  }
  if (row.skipped) {
    return { ok: true, repaired: false, skipped: true };
  }
  if ((row.repaired ?? 0) > 0) {
    return { ok: true, repaired: true };
  }
  if (row.error) {
    return {
      ok: false,
      errorMessage: row.error,
      terminal: row.terminal === true,
    };
  }
  return { ok: false, errorMessage: "未能补拉正文" };
}

function isWorkerCancelledMessage(msg: string): boolean {
  return /WorkerRequestCancelled|request has been cancelled/i.test(msg);
}

function isUidNotFoundMessage(msg: string): boolean {
  return /skip_no_uid|uid_not_found|Message-ID 未命中|无法在邮箱中找到/i.test(msg);
}

/** 从 IMAP 为单封已入库邮件补拉正文（轻量限时，失败自动入队） */
export async function invokeRepairEmailBody(emailId: string): Promise<RepairEmailBodyResult> {
  const { data, error } = await supabase.functions.invoke("sync-mailbox", {
    body: { repair_email_id: emailId },
  });
  if (error) {
    const raw = await formatFunctionsInvokeError(error);
    if (isWorkerCancelledMessage(raw)) {
      return {
        ok: true,
        repaired: false,
        queued: true,
        queueReason: "worker_request_cancelled",
      };
    }
    return { ok: false, errorMessage: raw };
  }
  if (data?.error) {
    const msg = String(data.error);
    if (isWorkerCancelledMessage(msg)) {
      return { ok: true, repaired: false, queued: true, queueReason: "worker_request_cancelled" };
    }
    return { ok: false, errorMessage: msg };
  }
  return mapSyncRepairRow(data?.results?.[0] as SyncRepairRow | undefined);
}

/** 有正文但未分析时补偿触发 process-email */
export async function invokeProcessEmailAfterBodyRepair(
  emailId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("process-email", {
    body: { email_id: emailId, after_body_repair: true },
  });
  if (error) {
    return { ok: false, error: await formatFunctionsInvokeError(error) };
  }
  if (data?.error) {
    return { ok: false, error: String(data.error) };
  }
  return { ok: true };
}

export type BodyRepairTaskRow = {
  status: string;
  last_error?: string | null;
  repaired_at?: string | null;
  post_processed_at?: string | null;
  next_run_at?: string | null;
  attempt_count?: number | null;
};

/** 由任务行推导 UI 状态 */
export function deriveBodyRepairUiStatusFromTask(
  task: BodyRepairTaskRow | null,
): BodyRepairUiStatus {
  if (!task) return "idle";
  if (task.status === "failed") return "failed_terminal";
  if (task.status === "resolved" || task.status === "skipped") return "done";
  if (task.status === "pending" || task.status === "running") {
    if (isUidNotFoundMessage(task.last_error ?? "")) return "not_found_retrying";
    return "queued";
  }
  return "idle";
}

/** 查询后台正文补拉任务状态（员工 RLS 只读） */
export async function fetchBodyRepairTaskStatus(
  emailId: string,
): Promise<BodyRepairTaskRow | null> {
  const { data, error } = await supabase
    .from("email_body_repair_tasks")
    .select("status, last_error, repaired_at, post_processed_at, next_run_at, attempt_count")
    .eq("email_id", emailId)
    .maybeSingle();
  if (error) {
    console.warn("[fetchBodyRepairTaskStatus]", error.message);
    return null;
  }
  return data as BodyRepairTaskRow | null;
}

export function formatBodyRepairTaskHint(task: BodyRepairTaskRow | null): string | null {
  if (!task) return null;
  if (task.status === "failed") {
    return task.last_error ?? "补拉失败，请检查邮箱中是否仍存在该邮件";
  }
  if (task.status === "pending" || task.status === "running") {
    const parts: string[] = ["后台约每 3 分钟处理"];
    if (task.attempt_count != null && task.attempt_count > 0) {
      parts.push(`第 ${task.attempt_count} 次尝试`);
    }
    if (isUidNotFoundMessage(task.last_error ?? "")) {
      parts.push("正在重新定位原邮件");
    }
    return parts.join(" · ");
  }
  return null;
}
