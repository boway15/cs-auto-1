/** ERP 拦截通知：按 site_code 解析站点与发件 mailbox */

export type ErpSiteMailboxRow = {
  id: string;
  site_code: string;
  site_name: string;
  sender_email: string;
  is_active: boolean;
};

export type MailboxRow = {
  id: string;
  email_address: string;
  smtp_host: string | null;
  smtp_port: number | null;
  is_active: boolean;
  [key: string]: unknown;
};

export type ErpSiteResolveErrorCode =
  | "SITE_NOT_CONFIGURED"
  | "SENDER_NOT_CONFIGURED"
  | "MAILBOX_SMTP_MISSING";

export type ErpSiteResolveResult =
  | { ok: true; site: ErpSiteMailboxRow; mailbox: MailboxRow }
  | { ok: false; code: ErpSiteResolveErrorCode; message: string };

/** 纯函数：根据站点行与 mailbox 查询结果判定发件邮箱是否可用 */
export function evaluateErpSiteMailbox(
  site: ErpSiteMailboxRow | null | undefined,
  mailbox: MailboxRow | null | undefined,
): ErpSiteResolveResult {
  if (!site || !site.is_active) {
    return {
      ok: false,
      code: "SITE_NOT_CONFIGURED",
      message: "站点未配置或已停用",
    };
  }
  const senderEmail = (site.sender_email ?? "").trim();
  if (!senderEmail) {
    return {
      ok: false,
      code: "SENDER_NOT_CONFIGURED",
      message: "站点未配置发件邮箱",
    };
  }
  if (!mailbox || !mailbox.is_active) {
    return {
      ok: false,
      code: "MAILBOX_SMTP_MISSING",
      message: "发件邮箱未找到或未启用",
    };
  }
  if (!mailbox.smtp_host || !mailbox.smtp_port) {
    return {
      ok: false,
      code: "MAILBOX_SMTP_MISSING",
      message: "发件邮箱未配置 SMTP",
    };
  }
  return { ok: true, site, mailbox };
}

export async function resolveErpSiteMailbox(
  admin: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
        };
      };
    };
  },
  siteCode: string,
): Promise<ErpSiteResolveResult> {
  const code = siteCode.trim();
  const { data: siteRaw, error: siteErr } = await admin
    .from("erp_site_mailboxes")
    .select("id, site_code, site_name, sender_email, is_active")
    .eq("site_code", code)
    .maybeSingle();

  if (siteErr) {
    return {
      ok: false,
      code: "SITE_NOT_CONFIGURED",
      message: siteErr.message,
    };
  }

  const site = siteRaw as ErpSiteMailboxRow | null;
  if (!site || !site.is_active) {
    return evaluateErpSiteMailbox(site, null);
  }

  const senderEmail = (site.sender_email ?? "").trim();
  const { data: mbRaw, error: mbErr } = await admin
    .from("mailboxes")
    .select("*")
    .eq("email_address", senderEmail)
    .maybeSingle();

  if (mbErr) {
    return {
      ok: false,
      code: "MAILBOX_SMTP_MISSING",
      message: mbErr.message,
    };
  }

  return evaluateErpSiteMailbox(site, mbRaw as MailboxRow | null);
}
