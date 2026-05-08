// 人工触发的草稿生成 Edge Function
// 业务规则（Phase D 落定）：
//   - 本接口仅服务「人工再生成」，固定走【本地短稿】路径，避免 Dify 不稳定时人工被卡
//   - 自动草稿（0-4h Dify、4-24h 本地）由 schedule-draft-generation 30 分钟调度负责
//   - 兼容旧调用：POST { email_id, guidance, mode? }；mode 为 'local' 或缺省时走本地
// 历史保留：Lovable AI 网关与 Dify 草稿调用代码已下线，统一交给调度任务

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { buildLocalDraft, insertDraft } from "../_shared/draft.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// 旧的 Dify / Lovable 实现仅作为参考保留（不再被调用）
async function _legacyCallDifyWorkflow(email: any, orders: any[], guidance: string | null, prev: any | null): Promise<string> {
  const difyUrl = Deno.env.get("DIFY_DRAFT_URL")!;
  const difyKey = Deno.env.get("DIFY_DRAFT_KEY")!;

  const orderInfo = orders.length > 0
    ? orders.map((o: any) =>
        `- 订单号 ${o.order_no} | 客户 ${o.customer_name ?? ""} | 商品 ${o.product_summary ?? ""} | 物流状态 ${o.shipping_status ?? ""} | 物流单号 ${o.tracking_no ?? ""} | 订单状态 ${o.order_status ?? ""} | 金额 ${o.amount ?? ""} ${o.currency ?? ""}`
      ).join("\n")
    : "（暂无关联订单）";

  const response = await fetch(difyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${difyKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inputs: {
        subject: email.subject ?? "",
        body_text: email.body_text ?? "",
        from_name: email.from_name ?? email.from_email,
        from_email: email.from_email,
        order_info: orderInfo,
        guidance: guidance ?? "",
        previous_draft: prev?.draft_content ?? "",
      },
      response_mode: "blocking",
      user: "mail-guide-ai",
    }),
  });

  if (!response.ok) {
    const t = await response.text();
    throw new Error(`Dify 工作流错误 ${response.status}: ${t}`);
  }

  const json = await response.json();
  // Dify workflow blocking response: { data: { outputs: { draft_content: "..." }, status: "succeeded" } }
  const outputs = json.data?.outputs ?? json;
  return outputs.draft_content ?? outputs.text ?? "（Dify 未返回草稿内容）";
}

async function _legacyCallLovableGateway(systemPrompt: string, userPrompt: string): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

  const aiResp = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    }
  );

  if (aiResp.status === 429) {
    throw new DraftError("AI 调用超出频率限制，请稍后再试", 429);
  }
  if (aiResp.status === 402) {
    throw new DraftError("AI 额度不足，请到工作台 Settings → Workspace → Usage 充值", 402);
  }
  if (!aiResp.ok) {
    const t = await aiResp.text();
    throw new Error(`AI 网关错误 ${aiResp.status}: ${t}`);
  }

  const aiJson = await aiResp.json();
  return aiJson.choices?.[0]?.message?.content ?? "（AI 未返回内容）";
}

class DraftError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "DraftError";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return new Response(JSON.stringify({ error: "未登录" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { email_id, guidance, mode } = await req.json();
    if (!email_id) {
      return new Response(JSON.stringify({ error: "缺少 email_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // mode 仅接受 'local'（默认）；拒绝旧的远程调用，避免人工流走 Dify
    if (mode && mode !== "local") {
      return new Response(JSON.stringify({ error: "人工生成仅支持 mode=local；自动草稿请等待调度任务" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: email, error: emailErr } = await supabase
      .from("emails")
      .select("id, subject, body_text, from_email, from_name, ai_summary, status")
      .eq("id", email_id)
      .single();
    if (emailErr || !email) throw new Error("邮件不存在");

    const { data: links } = await supabase
      .from("email_order_links")
      .select("orders(*)")
      .eq("email_id", email_id);
    const orders = (links ?? []).map((l: any) => l.orders).filter(Boolean);

    const content = buildLocalDraft(email as any, orders, email.ai_summary);
    const version = await insertDraft(
      supabase,
      email_id,
      content,
      "pipeline-local",
      guidance ?? null,
      userData.user.id,
    );

    await supabase
      .from("emails")
      .update({ status: "processing" })
      .eq("id", email_id)
      .eq("status", "pending");

    await supabase.from("email_processing_events").insert({
      email_id,
      event_type: "draft_manual_generated_local",
      actor_type: "user",
      actor_id: userData.user.id,
      title: `人工生成草稿 v${version}（本地）`,
      detail: guidance ?? null,
    });

    return new Response(JSON.stringify({ draft: { email_id, version, draft_content: content, model: "pipeline-local" } }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("generate-draft error:", e);
    const status = e instanceof DraftError ? e.status : 500;
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
