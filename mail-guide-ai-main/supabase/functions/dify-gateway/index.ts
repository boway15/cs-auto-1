import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key, x-idempotency-key, x-trace-id",
};

type GatewayAction =
  | "get_email_context"
  | "get_order_by_email"
  | "risk_intercept";

type GatewayRequest = {
  action: GatewayAction;
  payload?: Record<string, unknown>;
  trace_id?: string;
};

function parseGatewayRequest(req: Request): Promise<GatewayRequest> | GatewayRequest {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const action = (url.searchParams.get("action") ?? "") as GatewayAction;
    const payload: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key === "action" || key === "trace_id") continue;
      payload[key] = value;
    }
    return {
      action,
      payload,
      trace_id: url.searchParams.get("trace_id") ?? undefined,
    };
  }
  return req.json() as Promise<GatewayRequest>;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  traceId: string,
) {
  return new Response(
    JSON.stringify({
      trace_id: traceId,
      ...body,
    }),
    {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

function extractOrderNo(text: string): string | null {
  if (!text) return null;
  const patterns = [
    /(?:订单号|Order\s*(?:No|ID|#)?|ORD-?)\s*[:#]?\s*([A-Z0-9]{4,30})/gi,
    /#([A-Z0-9]{4,20})/g,
    /\b(PO\d{4,20})\b/gi,
    /\b(ORD[A-Z0-9-]{4,30})\b/gi,
    /\b(?:order|订单).*?([A-Z0-9]{5,20})/gi,
    /([A-Z]{2,4}\d{6,20})\b/g,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const candidate = m[1].toUpperCase();
      if (/^\d{8}$/.test(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

async function handleGetEmailContext(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
) {
  const emailId = String(payload.email_id ?? "").trim();
  const depthRaw = Number(payload.depth ?? 10);
  const depth = Number.isFinite(depthRaw) ? Math.max(0, Math.min(depthRaw, 50)) : 10;

  if (!emailId) throw new Error("缺少 payload.email_id");

  const { data: email, error: emailErr } = await admin
    .from("emails")
    .select("*")
    .eq("id", emailId)
    .single();

  if (emailErr || !email) throw new Error("邮件不存在");

  const currentOrderNo =
    extractOrderNo(email.subject ?? "") ??
    extractOrderNo(email.body_text ?? "");

  let extractedOrderNo = currentOrderNo;
  let orderSource: string | null = currentOrderNo ? "current_email" : null;

  if (!extractedOrderNo && depth > 0) {
    const { data: threadEmails } = await admin
      .from("emails")
      .select("subject, body_text, received_at")
      .eq("from_email", email.from_email)
      .neq("id", emailId)
      .order("received_at", { ascending: false })
      .limit(depth);

    for (const prev of threadEmails ?? []) {
      const orderNo =
        extractOrderNo(prev.subject ?? "") ??
        extractOrderNo(prev.body_text ?? "");
      if (orderNo) {
        extractedOrderNo = orderNo;
        orderSource = "thread_email";
        break;
      }
    }
  }

  return {
    email: {
      email_id: email.id,
      subject: email.subject ?? "",
      body: email.body_text ?? "",
      from_address: email.from_email,
      from_name: email.from_name ?? "",
      to_address: email.to_email ?? "",
      received_at: email.received_at,
      has_attachment: email.has_attachment,
      attachments: email.attachments ?? [],
      status: email.status,
    },
    extracted_order_no: extractedOrderNo ?? "",
    order_source: orderSource,
    search_depth: depth,
  };
}

async function handleGetOrderByEmail(
  admin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
) {
  const orderNo = String(payload.order_no ?? "").trim();
  const email = String(payload.email ?? "").trim();

  if (!orderNo) throw new Error("缺少 payload.order_no");

  let query = admin
    .from("orders")
    .select("*")
    .eq("order_no", orderNo);

  if (email) query = query.eq("customer_email", email);

  let { data: order, error: orderErr } = await query.maybeSingle();

  if (!order && email) {
    const { data: fallback } = await admin
      .from("orders")
      .select("*")
      .eq("order_no", orderNo)
      .limit(1);
    if (fallback && fallback.length > 0) order = fallback[0];
  }

  if (orderErr || !order) {
    return { found: false, order: null };
  }

  let trackingUrl = order.tracking_no ?? "";
  if (order.raw_data) {
    try {
      const raw =
        typeof order.raw_data === "string"
          ? JSON.parse(order.raw_data)
          : order.raw_data;
      if (raw.tracking_url) trackingUrl = raw.tracking_url;
      else if (raw.tracking_urls?.[0]) trackingUrl = raw.tracking_urls[0];
    } catch {
      // ignore parse error
    }
  }

  return {
    found: true,
    order: {
      order_no: order.order_no,
      customer_name: order.customer_name ?? "",
      product_name: order.product_summary ?? "",
      status: order.order_status ?? "",
      currency: order.currency ?? "USD",
      amount: order.amount ?? 0,
      placed_at: order.ordered_at ?? order.created_at,
      tracking_url: trackingUrl,
      shipping_status: order.shipping_status ?? "",
      tracking_no: order.tracking_no ?? "",
    },
  };
}

async function handleRiskIntercept(
  supabaseUrl: string,
  serviceKey: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) {
  const res = await fetch(`${supabaseUrl}/functions/v1/risk-intercept`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...payload,
      idempotency_key: payload.idempotency_key ?? idempotencyKey,
      trigger_source: payload.trigger_source ?? "dify",
    }),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`risk-intercept 调用失败: ${res.status} ${text.slice(0, 300)}`);
  }

  return parsed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const traceId = req.headers.get("x-trace-id") ?? crypto.randomUUID();

  try {
    if (req.method !== "POST" && req.method !== "GET") {
      return jsonResponse(
        405,
        { success: false, code: "METHOD_NOT_ALLOWED", message: "仅支持 GET/POST" },
        traceId,
      );
    }

    const gatewayApiKey = Deno.env.get("DIFY_GATEWAY_API_KEY");
    const headerApiKey = req.headers.get("x-api-key") ?? "";
    if (!gatewayApiKey) {
      return jsonResponse(
        500,
        { success: false, code: "GATEWAY_API_KEY_MISSING", message: "网关未配置 DIFY_GATEWAY_API_KEY" },
        traceId,
      );
    }
    if (headerApiKey !== gatewayApiKey) {
      return jsonResponse(
        401,
        { success: false, code: "UNAUTHORIZED", message: "未授权，请检查 x-api-key" },
        traceId,
      );
    }

    const body = await parseGatewayRequest(req);
    const action = body.action;
    const payload = (body.payload ?? {}) as Record<string, unknown>;
    const idempotencyKey = req.headers.get("x-idempotency-key") ?? "";

    if (!action) {
      return jsonResponse(
        400,
        { success: false, code: "INVALID_ACTION", message: "缺少 action" },
        traceId,
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    let data: unknown = null;
    switch (action) {
      case "get_email_context":
        data = await handleGetEmailContext(admin, payload);
        break;
      case "get_order_by_email":
        data = await handleGetOrderByEmail(admin, payload);
        break;
      case "risk_intercept":
        if (!idempotencyKey && !payload.idempotency_key) {
          return jsonResponse(
            400,
            {
              success: false,
              code: "MISSING_IDEMPOTENCY_KEY",
              message: "risk_intercept 需要 x-idempotency-key 或 payload.idempotency_key",
            },
            traceId,
          );
        }
        data = await handleRiskIntercept(
          supabaseUrl,
          serviceKey,
          payload,
          idempotencyKey,
        );
        break;
      default:
        return jsonResponse(
          400,
          { success: false, code: "UNSUPPORTED_ACTION", message: `不支持 action: ${String(action)}` },
          traceId,
        );
    }

    return jsonResponse(
      200,
      { success: true, code: "OK", message: "ok", action, data },
      traceId,
    );
  } catch (error) {
    console.error("dify-gateway error:", error);
    return jsonResponse(
      500,
      {
        success: false,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "未知错误",
      },
      traceId,
    );
  }
});
