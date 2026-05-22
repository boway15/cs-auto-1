import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const mailboxAccessCorsJsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

export type StaffActor = {
  userId: string;
  isService: boolean;
};

export function isServiceRoleToken(
  token: string,
  serviceKey: string,
  cronKey?: string | null,
): boolean {
  if (!token) return false;
  if (token === serviceKey) return true;
  if (cronKey && token === cronKey) return true;
  return false;
}

/** 已登录员工；service role / cron 返回 isService */
export async function getStaffActor(
  req: Request,
  admin: ReturnType<typeof createClient>,
  options: { supabaseUrl: string; anonKey: string; serviceKey: string; cronKey?: string | null },
): Promise<StaffActor> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw new Response(JSON.stringify({ error: "未授权" }), {
      status: 401,
      headers: mailboxAccessCorsJsonHeaders,
    });
  }
  if (isServiceRoleToken(token, options.serviceKey, options.cronKey)) {
    return { userId: "", isService: true };
  }
  const userClient = createClient(options.supabaseUrl, options.anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) {
    throw new Response(JSON.stringify({ error: "未登录" }), {
      status: 401,
      headers: mailboxAccessCorsJsonHeaders,
    });
  }
  const { data: isStaff, error: staffErr } = await admin.rpc("is_staff", {
    _user_id: data.user.id,
  });
  if (staffErr || !isStaff) {
    throw new Response(JSON.stringify({ error: "权限不足" }), {
      status: 403,
      headers: mailboxAccessCorsJsonHeaders,
    });
  }
  return { userId: data.user.id, isService: false };
}

export async function assertCanAccessMailbox(
  admin: ReturnType<typeof createClient>,
  userId: string,
  mailboxId: string,
): Promise<void> {
  const { data: ok, error } = await admin.rpc("can_access_mailbox", {
    _user_id: userId,
    _mailbox_id: mailboxId,
  });
  if (error || !ok) {
    throw new Response(JSON.stringify({ error: "无权访问该邮箱" }), {
      status: 403,
      headers: mailboxAccessCorsJsonHeaders,
    });
  }
}

export async function assertCanAccessEmail(
  admin: ReturnType<typeof createClient>,
  userId: string,
  emailId: string,
): Promise<void> {
  const { data: ok, error } = await admin.rpc("can_access_email", {
    _user_id: userId,
    _email_id: emailId,
  });
  if (error || !ok) {
    throw new Response(JSON.stringify({ error: "无权访问该邮件" }), {
      status: 403,
      headers: mailboxAccessCorsJsonHeaders,
    });
  }
}

/** 人工操作前校验：service 跳过，普通用户校验邮箱授权 */
export async function assertStaffCanAccessEmail(
  admin: ReturnType<typeof createClient>,
  actor: StaffActor,
  emailId: string,
): Promise<void> {
  if (actor.isService) return;
  await assertCanAccessEmail(admin, actor.userId, emailId);
}

export async function assertStaffCanAccessMailbox(
  admin: ReturnType<typeof createClient>,
  actor: StaffActor,
  mailboxId: string,
): Promise<void> {
  if (actor.isService) return;
  await assertCanAccessMailbox(admin, actor.userId, mailboxId);
}

export async function isUserAdmin(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  return !error && !!data;
}

export async function assertCanAccessOrder(
  admin: ReturnType<typeof createClient>,
  userId: string,
  orderId: string,
): Promise<void> {
  const { data: ok, error } = await admin.rpc("can_access_order", {
    _user_id: userId,
    _order_id: orderId,
  });
  if (error || !ok) {
    throw new Response(JSON.stringify({ error: "无权访问该订单" }), {
      status: 403,
      headers: mailboxAccessCorsJsonHeaders,
    });
  }
}

export async function assertStaffCanAccessOrder(
  admin: ReturnType<typeof createClient>,
  actor: StaffActor,
  orderId: string,
): Promise<void> {
  if (actor.isService) return;
  await assertCanAccessOrder(admin, actor.userId, orderId);
}

/** 非 admin 人工操作订单时必须带 email_id，且邮件与订单均需授权 */
export async function assertStaffCanAccessEmailOrderContext(
  admin: ReturnType<typeof createClient>,
  actor: StaffActor,
  emailId: string,
  orderId: string,
): Promise<void> {
  if (actor.isService) return;
  await assertStaffCanAccessEmail(admin, actor, emailId);
  await assertStaffCanAccessOrder(admin, actor, orderId);
  const { data: link } = await admin
    .from("email_order_links")
    .select("id")
    .eq("email_id", emailId)
    .eq("order_id", orderId)
    .maybeSingle();
  if (!link) {
    throw new Response(JSON.stringify({ error: "该订单未关联到当前邮件" }), {
      status: 403,
      headers: mailboxAccessCorsJsonHeaders,
    });
  }
}
