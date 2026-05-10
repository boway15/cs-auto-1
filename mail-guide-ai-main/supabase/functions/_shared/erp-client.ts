/**
 * ERP HTTP 单出口：OAuth2 Token、OMS QueryOrderInfo、Java 网关订单拦截。
 * 凭据仅来自 Deno.env；日志禁止打印完整 JWT。
 */

import { orderNoFromOmsInner } from "./erp-order-sync.ts";

const CONNECT_MS = 8_000;
const READ_MS = 12_000;

type TokenCache = { token: string; expiresAtMs: number };
let tokenCache: TokenCache | null = null;

export type ErpEnvelope = {
  success?: boolean;
  code?: number;
  businessCode?: number;
  traceId?: string;
  data?: Record<string, unknown>;
};

function hasCommonErpAuthConfig(): boolean {
  return !!(
    Deno.env.get("ERP_TOKEN_URL")?.trim() &&
    Deno.env.get("ERP_USERNAME")?.trim() &&
    Deno.env.get("ERP_PASSWORD")?.trim() &&
    Deno.env.get("ERP_CLIENT_ID")?.trim()
  );
}

export function isErpOmsConfigured(): boolean {
  return !!(hasCommonErpAuthConfig() && Deno.env.get("ERP_OMS_BASE")?.trim());
}

export function isErpHttpConfigured(): boolean {
  return !!(hasCommonErpAuthConfig() && Deno.env.get("ERP_GATEWAY_BASE")?.trim());
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), CONNECT_MS + READ_MS);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchErpAccessToken(): Promise<string> {
  const skewMs = 60_000;
  if (tokenCache && tokenCache.expiresAtMs > Date.now() + skewMs) {
    return tokenCache.token;
  }

  const tokenUrl = Deno.env.get("ERP_TOKEN_URL")!.trim();
  const username = Deno.env.get("ERP_USERNAME")!.trim();
  const password = Deno.env.get("ERP_PASSWORD")!.trim();
  const clientId = Deno.env.get("ERP_CLIENT_ID")!.trim();
  const rawPwdField = Deno.env.get("ERP_TOKEN_PASSWORD_FIELD")?.trim().toLowerCase();
  const pwdField = rawPwdField === "pw" ? "pw" : "password";

  const body = new URLSearchParams();
  body.set("username", username);
  body.set(pwdField, password);
  body.set("grant_type", "password");
  body.set("client_id", clientId);

  const res = await fetchWithTimeout(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("ERP token HTTP error:", res.status, text.slice(0, 200));
    throw new Error(`ERP 鉴权失败 HTTP ${res.status}`);
  }
  let json: { access_token?: string; expires_in?: number };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("ERP 鉴权响应非 JSON");
  }
  if (!json.access_token) {
    throw new Error("ERP 鉴权未返回 access_token");
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  tokenCache = {
    token: json.access_token,
    expiresAtMs: Date.now() + Math.max(60, expiresIn) * 1000,
  };
  return json.access_token;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Java 网关等：不做 Pascal 归一化。 */
function parseEnvelope(text: string): ErpEnvelope {
  const p = parseJsonObject(text);
  return (p ?? {}) as unknown as ErpEnvelope;
}

/** OMS QueryOrderInfo：归一化 .NET PascalCase 与 Java 外壳两种形态。 */
function parseOmsEnvelope(text: string): ErpEnvelope {
  const p = parseJsonObject(text);
  if (!p) return {};
  return normalizeOmsQueryResponseToEnvelope(p);
}

/**
 * 将 OMS / 网关实际返回统一为 ErpEnvelope（小写 data + data.success），兼容：
 * - Java 网关外壳：{ success, code, traceId, data: { orderId, success, message } }
 * - .NET 常见包：{ Success, ErrorCode, Msg, Data: { data: [...], total, page } }
 */
function normalizeOmsQueryResponseToEnvelope(parsed: Record<string, unknown>): ErpEnvelope {
  const hasPascalData = parsed.Data != null && typeof parsed.Data === "object" && !Array.isArray(parsed.Data);

  if (hasPascalData) {
    const successRaw = parsed.Success ?? parsed.success;
    const errRaw = parsed.ErrorCode ?? parsed.errorCode ?? parsed.error_code;
    const msgTop = String(parsed.Msg ?? parsed.msg ?? "");
    const dataBlock = parsed.Data as Record<string, unknown>;
    const list =
      dataBlock?.data ??
      dataBlock?.Data ??
      dataBlock?.items ??
      dataBlock?.Items ??
      dataBlock?.rows ??
      dataBlock?.Rows;
    let rows = Array.isArray(list) ? list : [];
    // 无数组时：订单字段可能直接挂在 Data 对象上（非 data[]）
    if (
      rows.length === 0 &&
      dataBlock &&
      typeof dataBlock === "object" &&
      !Array.isArray(dataBlock) &&
      orderNoFromOmsInner(dataBlock as Record<string, unknown>)
    ) {
      rows = [dataBlock];
    }
    const outerOk =
      (successRaw === true || String(successRaw).toLowerCase() === "true") &&
      (errRaw === undefined || errRaw === null || Number(errRaw) === 0);

    if (outerOk && rows.length > 0) {
      const first = rows[0];
      if (first && typeof first === "object") {
        return {
          success: true,
          code: 200,
          traceId: (parsed.TraceId ?? parsed.traceId) as string | undefined,
          data: { ...(first as Record<string, unknown>), success: true },
        };
      }
    }

    if (outerOk && rows.length === 0) {
      return {
        success: true,
        code: 200,
        traceId: (parsed.TraceId ?? parsed.traceId) as string | undefined,
        data: {
          success: false,
          message: msgTop || "未查询到订单信息",
        },
      };
    }

    if (!outerOk) {
      return {
        success: false,
        code: Number(errRaw) === 0 ? 500 : Number(errRaw),
        traceId: (parsed.TraceId ?? parsed.traceId) as string | undefined,
        data: { success: false, message: msgTop || "OMS 请求未成功" },
      };
    }
  }

  return parsed as unknown as ErpEnvelope;
}

function coerceOuterCodeOk(code: unknown): boolean {
  if (code == null) return true;
  return Number(code) === 200 || String(code) === "200";
}

function coerceInnerSuccess(v: unknown): boolean | undefined {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return undefined;
}

function innerHasOrderId(d: Record<string, unknown>): boolean {
  return orderNoFromOmsInner(d) != null;
}

/**
 * OMS QueryOrderInfo：在 HTTP 成功前提下解析业务是否「有单」。
 * 兼容：code 为字符串、data.success 为字符串、成功时未返回 data.success 但有 orderId 等字段（与 Apifox 实包常见差异）。
 */
export function erpEnvelopeOmsQuerySucceeded(env: ErpEnvelope): boolean {
  if (!coerceOuterCodeOk(env.code)) return false;
  if (env.success === false) return false;
  const d = env.data;
  if (!d || typeof d !== "object") return false;
  if (erpEnvelopeNoOrderMessage(env)) return false;
  const inner = coerceInnerSuccess(d.success);
  if (inner === true) return true;
  if (inner === false) return false;
  const msg = String(d.message ?? "").toLowerCase();
  if (msg.includes("未查询") || msg.includes("not found") || msg.includes("不存在")) return false;
  if (innerHasOrderId(d as Record<string, unknown>)) return true;
  return false;
}

/** 网关拦截等：仍要求 data.success 为真（拦截成功语义以 ERP 为准，保持相对严格）。 */
/** 网关拦截：沿用 Java 网关 data.success 布尔语义（normalize 后已与查单分流）。 */
export function erpEnvelopeBusinessOk(env: ErpEnvelope): boolean {
  if (!coerceOuterCodeOk(env.code)) return false;
  if (env.success === false) return false;
  const d = env.data;
  if (!d || typeof d !== "object") return false;
  return coerceInnerSuccess(d.success) === true;
}

export function erpEnvelopeNoOrderMessage(env: ErpEnvelope): boolean {
  const raw = env as unknown as Record<string, unknown>;
  const msg = String(env.data?.message ?? raw.Msg ?? raw.msg ?? "");
  return /未查询到订单信息/i.test(msg) || /无结果|未查到|empty/i.test(msg);
}

export type QueryOrderInfoResult = {
  ok: boolean;
  envelope: ErpEnvelope;
  rawText: string;
  httpStatus: number;
};

async function postQueryOrderInfo(
  token: string,
  email: string,
  ebayOrderId: string,
): Promise<{ res: Response; rawText: string; envelope: ErpEnvelope }> {
  const omsBase = Deno.env.get("ERP_OMS_BASE")!.trim();
  const url = joinUrl(omsBase, "/AukeysOrder/OrderInfo/QueryOrderInfo");
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      email: email || "",
      ebayOrderId: ebayOrderId ?? "",
    }),
  });
  const rawText = await res.text();
  const envelope = parseOmsEnvelope(rawText);
  return { res, rawText, envelope };
}

/**
 * OMS 查单：先按传入的 email + ebayOrderId；
 * - 若未命中且二者均非空，再仅传 ebayOrderId（常见 Apifox 单号查询）。
 */
export async function queryOrderInfo(email: string, ebayOrderId: string): Promise<QueryOrderInfoResult> {
  const token = await fetchErpAccessToken();
  let { res, rawText, envelope } = await postQueryOrderInfo(token, email, ebayOrderId);
  let ok = res.ok && erpEnvelopeOmsQuerySucceeded(envelope);

  const idTrim = (ebayOrderId ?? "").trim();
  const emTrim = (email ?? "").trim();

  if (!ok && res.ok && idTrim.length > 0 && emTrim.length > 0) {
    const second = await postQueryOrderInfo(token, "", idTrim);
    res = second.res;
    rawText = second.rawText;
    envelope = second.envelope;
    ok = res.ok && erpEnvelopeOmsQuerySucceeded(envelope);
  }

  // Amazon 等站点单号常带连字符；部分 OMS 库只存无连字符形态
  if (!ok && res.ok && idTrim.length > 0) {
    const stripped = idTrim.replace(/-/g, "");
    if (stripped !== idTrim && stripped.length >= 8) {
      const third = await postQueryOrderInfo(token, emTrim, stripped);
      res = third.res;
      rawText = third.rawText;
      envelope = third.envelope;
      ok = res.ok && erpEnvelopeOmsQuerySucceeded(envelope);
      if (!ok && emTrim.length > 0) {
        const fourth = await postQueryOrderInfo(token, "", stripped);
        res = fourth.res;
        rawText = fourth.rawText;
        envelope = fourth.envelope;
        ok = fourth.res.ok && erpEnvelopeOmsQuerySucceeded(envelope);
      }
    }
  }

  return { ok, envelope, rawText, httpStatus: res.status };
}

export type BlockOrderResult = {
  ok: boolean;
  envelope: ErpEnvelope;
  rawText: string;
  httpStatus: number;
};

export async function blockOrderByOrderId(orderId: string): Promise<BlockOrderResult> {
  const token = await fetchErpAccessToken();
  const gwBase = Deno.env.get("ERP_GATEWAY_BASE")!.trim();
  const path = "/report/website/orders/order-blocking-by-order-ids";
  const url = `${joinUrl(gwBase, path)}?orderId=${encodeURIComponent(orderId)}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const rawText = await res.text();
  const envelope = parseEnvelope(rawText);
  const ok = res.ok && erpEnvelopeBusinessOk(envelope);
  return { ok, envelope, rawText, httpStatus: res.status };
}
