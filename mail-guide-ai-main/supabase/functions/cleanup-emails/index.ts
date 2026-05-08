// 清理特定邮箱的所有数据（临时操作函数）
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
    // 仅允许服务角色调用
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isServiceRole = token && token === SUPABASE_SERVICE_ROLE_KEY;

    if (!isServiceRole) {
      return new Response(JSON.stringify({ error: "未授权" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const emailAddress = "service@sedetalife.com";

    console.log(`[cleanup] 开始清理 ${emailAddress} 的数据...`);

    // 1. 查询相关邮件 ID
    const { data: targetEmails } = await admin
      .from("emails")
      .select("id, mailbox_id")
      .or(`from_email.ilike.%${emailAddress}%,to_email.ilike.%${emailAddress}%`);

    if (!targetEmails || targetEmails.length === 0) {
      console.log(`[cleanup] 未找到相关邮件`);
      return new Response(
        JSON.stringify({
          success: true,
          message: "未找到相关邮件",
          summary: {
            deleted_emails: 0,
            deleted_drafts: 0,
            deleted_links: 0,
            deleted_logs: 0,
          },
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const emailIds = targetEmails.map((e) => e.id);
    const mailboxIds = [
      ...new Set(targetEmails.map((e) => e.mailbox_id).filter(Boolean)),
    ];

    console.log(
      `[cleanup] 找到 ${emailIds.length} 封邮件，涉及 ${mailboxIds.length} 个邮箱`
    );

    let stats = {
      deleted_emails: 0,
      deleted_drafts: 0,
      deleted_links: 0,
      deleted_logs: 0,
      deleted_mailboxes: 0,
    };

    // 2. 删除 AI 草稿
    if (emailIds.length > 0) {
      const { error: draftErr } = await admin
        .from("ai_drafts")
        .delete()
        .in("email_id", emailIds);
      if (!draftErr) {
        const { count } = await admin
          .from("ai_drafts")
          .select("id", { count: "exact", head: true })
          .in("email_id", emailIds);
        stats.deleted_drafts = count || 0;
        console.log(`[cleanup] 删除草稿: ${stats.deleted_drafts}`);
      }
    }

    // 3. 删除邮件-订单关联
    if (emailIds.length > 0) {
      const { count: linkCount } = await admin
        .from("email_order_links")
        .select("id", { count: "exact", head: true })
        .in("email_id", emailIds);
      if (linkCount) {
        await admin.from("email_order_links").delete().in("email_id", emailIds);
        stats.deleted_links = linkCount;
        console.log(`[cleanup] 删除订单关联: ${stats.deleted_links}`);
      }
    }

    // 4. 删除发送日志
    if (emailIds.length > 0) {
      const { count: logCount } = await admin
        .from("email_send_logs")
        .select("id", { count: "exact", head: true })
        .or(
          `email_id.in.(${emailIds.join(",")}),mailbox_id.in.(${mailboxIds.join(",")})`
        );
      if (logCount) {
        await admin.from("email_send_logs").delete().in("email_id", emailIds);
        if (mailboxIds.length > 0) {
          await admin.from("email_send_logs").delete().in("mailbox_id", mailboxIds);
        }
        stats.deleted_logs = logCount;
        console.log(`[cleanup] 删除发送日志: ${stats.deleted_logs}`);
      }
    }

    // 5. 删除邮件
    if (emailIds.length > 0) {
      const { count: emailCount } = await admin
        .from("emails")
        .select("id", { count: "exact", head: true })
        .in("id", emailIds);
      if (emailCount) {
        await admin.from("emails").delete().in("id", emailIds);
        stats.deleted_emails = emailCount;
        console.log(`[cleanup] 删除邮件: ${stats.deleted_emails}`);
      }
    }

    // 6. 删除邮箱
    if (mailboxIds.length > 0) {
      const { count: mbCount } = await admin
        .from("mailboxes")
        .select("id", { count: "exact", head: true })
        .in("id", mailboxIds);
      if (mbCount) {
        await admin.from("mailboxes").delete().in("id", mailboxIds);
        stats.deleted_mailboxes = mbCount;
        console.log(`[cleanup] 删除邮箱: ${stats.deleted_mailboxes}`);
      }
    }

    // 再次查询是否真的删除了
    const { data: remaining } = await admin
      .from("emails")
      .select("id")
      .or(`from_email.ilike.%${emailAddress}%,to_email.ilike.%${emailAddress}%`);

    console.log(
      `[cleanup] 完成。剩余邮件: ${remaining?.length || 0}，已删除数据:`,
      stats
    );

    return new Response(
      JSON.stringify({
        success: true,
        email_address: emailAddress,
        summary: stats,
        remaining_emails: remaining?.length || 0,
        message: `已清理 ${emailAddress} 的所有数据：${stats.deleted_emails} 封邮件，${stats.deleted_drafts} 个草稿，${stats.deleted_links} 个订单关联，${stats.deleted_logs} 条发送日志，${stats.deleted_mailboxes} 个邮箱配置`,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("[cleanup] error:", e);
    return new Response(
      JSON.stringify({
        error: e instanceof Error ? e.message : "未知错误",
        stack: e instanceof Error ? e.stack : undefined,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
