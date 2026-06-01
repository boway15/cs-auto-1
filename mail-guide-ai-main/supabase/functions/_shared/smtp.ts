// 极简 Deno 原生 SMTP 客户端，支持 SSL(465) / STARTTLS(587/25)
// EHLO / STARTTLS / AUTH LOGIN|PLAIN / MAIL FROM / RCPT TO / DATA / QUIT

import { connectMailImapTls, startMailSmtpTls } from "./mail-tls-ca.ts";
import { plainTextToHtmlEmail } from "./mail-body-html.ts";

export interface Mailbox {
  smtp_host: string;
  smtp_port: number;
  auth_user: string;
  auth_password: string;
  email_address: string;
  display_name?: string | null;
}

interface SendOpts {
  /** 单个地址，或逗号/分号分隔的多个地址（与 RCPT TO 一一对应） */
  to: string | string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

type AuthMethod = "LOGIN" | "PLAIN";

const MAIL_LOCAL_TEST_MODE = Deno.env.get("MAIL_LOCAL_TEST_MODE") === "true";

function b64(s: string) {
  return btoa(unescape(encodeURIComponent(s)));
}

function b64AuthPlain(user: string, pass: string) {
  const bytes = new TextEncoder().encode(`\0${user}\0${pass}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function encodeSubject(s: string) {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${b64(s)}?=`;
}

function foldBase64(encoded: string): string {
  return encoded.replace(/(.{76})/g, "$1\r\n");
}

function normalizeSmtpRecipients(to: string | string[]): string[] {
  if (Array.isArray(to)) {
    return to.map((a) => a.trim()).filter(Boolean);
  }
  return to.split(/[,;]/).map((a) => a.trim()).filter(Boolean);
}

export function resolveSmtpCreds(mb: Mailbox): { user: string; pass: string } {
  const user = (mb.auth_user || mb.email_address || "").trim();
  const pass = (mb.auth_password ?? "").trim();
  if (!user || !pass) {
    throw new Error("邮箱未配置授权码，请在「邮箱配置」中填写客户端授权密码后保存");
  }
  return { user, pass };
}

function isAuthFailureMessage(msg: string): boolean {
  return /535|authentication failed|SMTP AUTH pass failed/i.test(msg);
}

export function formatSmtpAuthHint(mb: Mailbox): string {
  const host = (mb.smtp_host ?? "").toLowerCase();
  if (/163\.com|qiye\.163/.test(host)) {
    return "网易企业邮常见原因：① Webmail「设置→客户端设置」需开启 SMTP/客户端授权密码（不能用网页登录密码）；② 管理员后台「安全登录→IP 限制」需允许当前服务器 IP；③ 可尝试备用发件服务器 hwhzsmtp.qiye.163.com:465。收信（IMAP）正常仅表示授权码对收件有效，发信 SMTP 可能仍需单独开通。";
  }
  return "请确认 SMTP 服务器、端口、登录名与客户端授权码正确，且邮箱服务商已开启 SMTP 发信。";
}

export function enhanceSmtpAuthError(err: unknown, mb: Mailbox): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (!isAuthFailureMessage(raw)) {
    return err instanceof Error ? err : new Error(raw);
  }
  return new Error(`${raw}\n${formatSmtpAuthHint(mb)}`);
}

export function createMultipartBoundary(): string {
  return `mg_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** multipart 正文（boundary 须写在邮件头 Content-Type 中，不可作为正文首行） */
export function buildMultipartAlternativeBody(
  plain: string,
  html: string,
  boundary: string,
): string {
  const plainPart = foldBase64(b64(plain));
  const htmlPart = foldBase64(b64(html));
  return [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    plainPart,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    htmlPart,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

class SmtpSession {
  private conn!: Deno.Conn;
  private buf = "";
  private readonly dec = new TextDecoder();
  private readonly enc = new TextEncoder();

  async connect(mb: Mailbox): Promise<void> {
    const port = Number(mb.smtp_port);
    const useSSL = MAIL_LOCAL_TEST_MODE ? false : port === 465;
    if (MAIL_LOCAL_TEST_MODE && port === 465) {
      throw new Error("本地测试模式已开启：SMTP 465 需要 TLS，请改用 25/587 或关闭 MAIL_LOCAL_TEST_MODE。");
    }
    this.conn = useSSL
      ? await connectMailImapTls(mb.smtp_host, port, undefined, "[smtp] ")
      : await Deno.connect({ hostname: mb.smtp_host, port });
    await this.expect("220", "greet");
  }

  close() {
    try {
      this.conn.close();
    } catch { /* ignore */ }
  }

  private async read(): Promise<string> {
    const b = new Uint8Array(8192);
    const n = await this.conn.read(b);
    if (n === null) throw new Error("SMTP connection closed");
    this.buf += this.dec.decode(b.subarray(0, n));
    while (!/\r\n$/.test(this.buf)) {
      const n2 = await this.conn.read(b);
      if (n2 === null) break;
      this.buf += this.dec.decode(b.subarray(0, n2));
    }
    const out = this.buf;
    this.buf = "";
    return out;
  }

  async expect(code: string, ctx: string): Promise<string> {
    const r = await this.read();
    if (!r.startsWith(code)) throw new Error(`SMTP ${ctx} failed: ${r.trim()}`);
    return r;
  }

  async write(s: string) {
    await this.conn.write(this.enc.encode(s));
  }

  async ehlo(mb: Mailbox): Promise<void> {
    await this.write(`EHLO lovable\r\n`);
    let ehlo = await this.expect("250", "EHLO");
    const port = Number(mb.smtp_port);
    const useSSL = MAIL_LOCAL_TEST_MODE ? false : port === 465;
    if (!useSSL && /STARTTLS/i.test(ehlo) && !MAIL_LOCAL_TEST_MODE) {
      await this.write(`STARTTLS\r\n`);
      await this.expect("220", "STARTTLS");
      this.conn = await startMailSmtpTls(this.conn as Deno.TcpConn, mb.smtp_host, "[smtp] ");
      await this.write(`EHLO lovable\r\n`);
      ehlo = await this.expect("250", "EHLO2");
    }
    void ehlo;
  }

  async authenticate(method: AuthMethod, user: string, pass: string): Promise<void> {
    if (method === "LOGIN") {
      await this.write(`AUTH LOGIN\r\n`);
      await this.expect("334", "AUTH");
      await this.write(`${b64(user)}\r\n`);
      await this.expect("334", "AUTH user");
      await this.write(`${b64(pass)}\r\n`);
      await this.expect("235", "AUTH pass");
      return;
    }
    await this.write(`AUTH PLAIN\r\n`);
    await this.expect("334", "AUTH PLAIN");
    await this.write(`${b64AuthPlain(user, pass)}\r\n`);
    await this.expect("235", "AUTH PLAIN pass");
  }
}

async function withSmtpAuth<T>(
  mb: Mailbox,
  fn: (session: SmtpSession, method: AuthMethod) => Promise<T>,
): Promise<T> {
  const { user, pass } = resolveSmtpCreds(mb);
  let lastErr: Error | undefined;
  for (const method of ["LOGIN", "PLAIN"] as const) {
    const session = new SmtpSession();
    try {
      await session.connect(mb);
      await session.ehlo(mb);
      await session.authenticate(method, user, pass);
      const out = await fn(session, method);
      try {
        await session.write(`QUIT\r\n`);
      } catch { /* ignore */ }
      return out;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (!isAuthFailureMessage(lastErr.message) || method === "PLAIN") {
        throw enhanceSmtpAuthError(lastErr, mb);
      }
    } finally {
      session.close();
    }
  }
  throw enhanceSmtpAuthError(lastErr ?? new Error("SMTP authentication failed"), mb);
}

/** 仅测试 SMTP 登录（不发信） */
export async function testSmtpAuth(
  mb: Mailbox,
): Promise<{ ok: boolean; message?: string; auth_method?: AuthMethod }> {
  if (!mb.smtp_host?.trim() || !mb.smtp_port) {
    return { ok: false, message: "未配置 SMTP 服务器或端口" };
  }
  try {
    let usedMethod: AuthMethod = "LOGIN";
    await withSmtpAuth(mb, async (_s, method) => {
      usedMethod = method;
    });
    return {
      ok: true,
      auth_method: usedMethod,
      message: `SMTP 认证成功（${usedMethod}，${mb.smtp_host}:${mb.smtp_port}）`,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function sendMail(mb: Mailbox, opts: SendOpts): Promise<string> {
  const recipients = normalizeSmtpRecipients(opts.to);
  if (recipients.length === 0) {
    throw new Error("SMTP recipients empty");
  }

  return await withSmtpAuth(mb, async (session) => {
    await session.write(`MAIL FROM:<${mb.email_address}>\r\n`);
    await session.expect("250", "MAIL FROM");
    for (const addr of recipients) {
      await session.write(`RCPT TO:<${addr}>\r\n`);
      await session.expect("250", "RCPT TO");
    }
    await session.write(`DATA\r\n`);
    await session.expect("354", "DATA");

    const messageId = `<${crypto.randomUUID()}@${mb.email_address.split("@")[1] ?? "localhost"}>`;
    const fromName = mb.display_name ? `${encodeSubject(mb.display_name)} ` : "";
    const toHeader = recipients.map((a) => `<${a}>`).join(", ");
    const headers = [
      `From: ${fromName}<${mb.email_address}>`,
      `To: ${toHeader}`,
      `Subject: ${encodeSubject(opts.subject)}`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Date: ${new Date().toUTCString()}`,
    ];
    if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts.references) headers.push(`References: ${opts.references}`);

    const boundary = createMultipartBoundary();
    const html = plainTextToHtmlEmail(opts.text);
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body = buildMultipartAlternativeBody(opts.text, html, boundary);
    const data = headers.join("\r\n") + "\r\n\r\n" + body + "\r\n.\r\n";
    await session.write(data);
    await session.expect("250", "BODY");
    return messageId;
  });
}
