// 删除邮箱及相关数据 Edge Function
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 鉴权：仅管理员可删除邮箱
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "未登录" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: isAdmin } = await admin.rpc("has_role", {
      _user_id: userData.user.id,
      _role: "admin",
    });

    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "权限不足：仅管理员可删除邮箱" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let mailboxId: string | undefined;
    if (req.method === "POST" || req.method === "DELETE") {
      try {
        const body = await req.json();
        mailboxId = body?.mailbox_id;
      } catch {
        const url = new URL(req.url);
        mailboxId = url.searchParams.get("mailbox_id") ?? undefined;
      }
    }

    if (!mailboxId) {
      return new Response(JSON.stringify({ error: "缺少 mailbox_id 参数" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 调用删除函数
    const { data: result, error: deleteErr } = await admin.rpc(
      "delete_mailbox_with_cascade",
      { _mailbox_id: mailboxId }
    );

    if (deleteErr) {
      console.error("[delete-mailbox] error:", deleteErr);
      return new Response(
        JSON.stringify({
          error: deleteErr.message,
          code: deleteErr.code,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log("[delete-mailbox] success:", mailboxId, result);

    return new Response(
      JSON.stringify({
        success: true,
        mailbox_id: mailboxId,
        summary: result?.[0] ?? {
          deleted_emails: 0,
          deleted_drafts: 0,
          deleted_links: 0,
          deleted_logs: 0,
        },
        message: `已删除邮箱及其关联数据：${result?.[0]?.deleted_emails ?? 0} 封邮件，${result?.[0]?.deleted_drafts ?? 0} 个草稿，${result?.[0]?.deleted_links ?? 0} 个订单关联，${result?.[0]?.deleted_logs ?? 0} 条发送日志`,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("delete-mailbox error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
