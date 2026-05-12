import { FunctionsHttpError } from "@supabase/supabase-js";

/** 将 Edge 返回 JSON 里的 error / message 等字段转成可读字符串（避免 [object Object]） */
export function formatInvokeBodyField(value: unknown, maxLen = 1200): string {
  if (value == null) return "";
  if (typeof value === "string") return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.message === "string") {
      const m = o.message;
      return m.length > maxLen ? `${m.slice(0, maxLen)}…` : m;
    }
    if (typeof o.msg === "string") return formatInvokeBodyField(o.msg, maxLen);
    try {
      const s = JSON.stringify(value);
      return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 将 functions.invoke 的错误转为可读文案（含 HTTP 状态与 Edge 返回的 JSON body）。
 * 默认仅 FunctionsHttpError.message 为「Edge Function returned a non-2xx status code」，不利于排障。
 */
export async function formatFunctionsInvokeError(error: unknown): Promise<string> {
  if (!error) return "未知错误";
  if (error instanceof FunctionsHttpError) {
    const status = error.context.status;
    try {
      const text = await error.context.clone().text();
      let parsed: { error?: unknown; message?: unknown } | null = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
        } catch {
          parsed = null;
        }
      }
      const fromError = parsed ? formatInvokeBodyField(parsed.error) : "";
      const fromMessage = parsed ? formatInvokeBodyField(parsed.message) : "";
      const detail =
        fromError ||
        fromMessage ||
        (text?.trim() ? (text.trim().length > 1200 ? `${text.trim().slice(0, 1200)}…` : text.trim()) : "");
      if (detail) return `HTTP ${status}：${detail}`;
      return `HTTP ${status}（${error.message}）`;
    } catch {
      return `HTTP ${status}（${error.message}）`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
