// 获取邮件上下文 Edge Function（供 Dify 工作流调用）
// 通过 email_id 查询邮件内容，并回溯同发件人的历史邮件提取订单号
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

// 从文本中提取订单号：匹配常见格式
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 鉴权：x-api-key 头传自定义 API Key（在 Supabase Custom Secrets 中设 API_KEY）
    // Authorization 头仅用于通过网关，函数内不再用它做身份校验
    const CUSTOM_API_KEY = Deno.env.get("API_KEY");
    const apiKeyHeader = req.headers.get("x-api-key") ?? "";

    if (CUSTOM_API_KEY && apiKeyHeader !== CUSTOM_API_KEY) {
      return new Response(JSON.stringify({ error: "未授权，请检查 x-api-key" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const url = new URL(req.url);
    const emailId = url.searchParams.get("email_id");
    const depth = Math.min(
      parseInt(url.searchParams.get("depth") ?? "10"),
      50
    );

    if (!emailId) {
      return new Response(JSON.stringify({ error: "缺少 email_id 参数" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. 获取当前邮件
    const { data: email, error: emailErr } = await admin
      .from("emails")
      .select("*")
      .eq("id", emailId)
      .single();

    if (emailErr || !email) {
      return new Response(JSON.stringify({ error: "邮件不存在" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. 从当前邮件中提取订单号
    const currentOrderNo =
      extractOrderNo(email.subject ?? "") ??
      extractOrderNo(email.body_text ?? "");

    let extractedOrderNo = currentOrderNo;
    let orderSource: string | null = currentOrderNo ? "current_email" : null;

    // 3. 如果当前邮件没找到订单号，回溯同发件人的历史邮件
    if (!extractedOrderNo && depth > 0) {
      const { data: threadEmails } = await admin
        .from("emails")
        .select("subject, body_text, message_id, received_at")
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

    return new Response(
      JSON.stringify({
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
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("get-email-context error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
