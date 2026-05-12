import { supabase } from "@/lib/supabase";

export type GetOrderApiJson = {
  error?: string;
  found?: boolean;
  source?: string;
  erp_message?: string;
  erp_error?: string;
};

export type InvokeGetOrderByEmailResult =
  | { kind: "auth" }
  | { kind: "bad_request"; message: string }
  | { kind: "error"; message: string }
  | { kind: "not_found"; description?: string }
  | { kind: "success"; source?: string };

/**
 * 调用 Edge `get-order-by-email`：默认先本地后 OMS；`refresh: true` 时在已配置 OMS 下强制走查询并回写本地。
 */
export async function invokeGetOrderByEmail(
  orderNo: string,
  buyerEmail: string,
  opts?: { refresh?: boolean },
): Promise<InvokeGetOrderByEmailResult> {
  const on = orderNo.trim();
  const em = buyerEmail.trim();
  if (!on && !em) return { kind: "bad_request", message: "请填写订单号或买家邮箱至少一项" };
  if (opts?.refresh && !on) return { kind: "bad_request", message: "缺少订单号，无法更新订单信息" };

  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { kind: "auth" };

  const base = import.meta.env.VITE_SUPABASE_URL as string;
  const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  const u = new URL(`${base.replace(/\/+$/, "")}/functions/v1/get-order-by-email`);
  if (on) u.searchParams.set("order_no", on);
  if (em) u.searchParams.set("email", em);
  if (opts?.refresh) u.searchParams.set("refresh", "1");

  const res = await fetch(u.toString(), {
    headers: { Authorization: `Bearer ${token}`, apikey: anon },
  });
  const json = (await res.json()) as GetOrderApiJson;
  if (!res.ok && json.error) return { kind: "error", message: json.error };
  if (json.error) return { kind: "error", message: json.error };
  if (!json.found) {
    return {
      kind: "not_found",
      description: json.erp_message || json.erp_error || "本地与 OMS 均无有效记录，或 ERP 未配置",
    };
  }
  return { kind: "success", source: json.source };
}
