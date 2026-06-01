// 测试 IMAP 邮箱连通性：connect → login → select INBOX → logout
// 仅做一次性轻量校验，不拉邮件，超时 20s
// body：host/port/user/pass/use_ssl；或 mailbox_id（编辑时留空授权码则用库内凭据）+ 可选覆盖 host/port/use_ssl
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { connectMailImapTls } from "../_shared/mail-tls-ca.ts";
import {
  assertCanAccessMailbox,
  getStaffActor,
} from "../_shared/mailbox-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const MAIL_LOCAL_TEST_MODE = Deno.env.get("MAIL_LOCAL_TEST_MODE") === "true";

async function testImap(opts: {
  host: string;
  port: number;
  user: string;
  pass: string;
  useSsl: boolean;
}): Promise<{ ok: boolean; step: string; message?: string }> {
  let conn: Deno.Conn | Deno.TlsConn | null = null;
  let step = "connect";
  try {
    const effectiveUseSsl = MAIL_LOCAL_TEST_MODE ? false : opts.useSsl;
    conn = effectiveUseSsl
      ? await connectMailImapTls(opts.host, opts.port, undefined, "[test-mailbox] ")
      : await Deno.connect({ hostname: opts.host, port: opts.port, transport: "tcp" });
    const reader = conn.readable.getReader();
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let buf = "";
    let tagN = 0;

    async function readUntil(re: RegExp, timeoutMs = 15000): Promise<string> {
      const start = Date.now();
      while (!re.test(buf)) {
        if (Date.now() - start > timeoutMs) throw new Error("读取超时");
        const { value, done } = await reader.read();
        if (done) throw new Error("连接被关闭");
        buf += dec.decode(value, { stream: true });
      }
      return buf;
    }
    async function cmd(c: string): Promise<{ ok: boolean; raw: string }> {
      const tag = `A${++tagN}`;
      buf = "";
      await conn!.write(enc.encode(`${tag} ${c}\r\n`));
      const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
      const raw = await readUntil(re);
      return { ok: raw.match(re)![1] === "OK", raw };
    }
    async function loginLiteral(user: string, pass: string) {
      const tag = `A${++tagN}`;
      buf = "";
      const userBytes = enc.encode(user);
      await conn!.write(enc.encode(`${tag} LOGIN {${userBytes.length}}\r\n`));
      await readUntil(/\+ /);
      buf = "";
      await conn!.write(userBytes);
      const passBytes = enc.encode(pass);
      await conn!.write(enc.encode(` {${passBytes.length}}\r\n`));
      await readUntil(/\+ /);
      buf = "";
      await conn!.write(passBytes);
      await conn!.write(enc.encode(`\r\n`));
      const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
      const raw = await readUntil(re);
      return { ok: raw.match(re)![1] === "OK", raw };
    }

    await readUntil(/^\* OK/m);
    step = "id";
    try {
      await cmd(`ID ("name" "Lovable" "version" "1.0" "vendor" "Lovable")`);
    } catch { /* 部分服务器不支持 ID 命令，忽略 */ }

    step = "login";
    let r: { ok: boolean; raw: string };
    try {
      r = await loginLiteral(opts.user, opts.pass);
      if (r.ok) {
        // ok
      } else {
        throw new Error("literal login failed");
      }
    } catch {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      r = await cmd(`LOGIN "${esc(opts.user)}" "${esc(opts.pass)}"`);
      if (!r.ok) {
        return {
          ok: false,
          step,
          message:
            `登录失败：${r.raw.slice(-300).trim()}（请检查 IMAP 登录用户名与授权码；网易/QQ 需使用应用专用密码而非网页登录密码；确认已在邮箱后台开启 IMAP）`,
        };
      }
    }

    step = "select";
    const sel = await cmd(`SELECT "INBOX"`);
    if (!sel.ok) {
      return { ok: false, step, message: `SELECT INBOX 失败：${sel.raw.slice(-200).trim()}` };
    }

    try { await cmd("LOGOUT"); } catch { /* ignore */ }
    return { ok: true, step: "done" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[test-mailbox] step=${step} error=${msg}`);
    if (step === "connect" && msg.includes("UnknownIssuer")) {
      return {
        ok: false,
        step,
        message:
          "[connect] TLS 证书校验失败（UnknownIssuer）。若 163 可连而 Gmail 不行，多为公司网络 SSL 审计：请确认 MAIL_TLS_CA_CERT_PATH 指向 TecSign/企业邮 CA（mail-ca.pem），并同步 functions 后重建；也可设置 MAIL_TLS_FORCE_CUSTOM_CA=true。",
      };
    }
    return { ok: false, step, message: `[${step}] ${msg}` };
  } finally {
    try { conn?.close(); } catch { /* ignore */ }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const actor = await getStaffActor(req, admin, {
      supabaseUrl: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    });

    const body = await req.json();
    const mailboxId = typeof body?.mailbox_id === "string" ? body.mailbox_id.trim() : "";
    let host = typeof body?.host === "string" ? body.host.trim() : "";
    let port = body?.port != null ? Number(body.port) : NaN;
    let user = typeof body?.user === "string" ? body.user.trim() : "";
    let pass = typeof body?.pass === "string" ? body.pass : "";
    let useSsl = body?.use_ssl !== false;
    let usedStoredPass = false;

    if (mailboxId) {
      if (!actor.isService) {
        await assertCanAccessMailbox(admin, actor.userId, mailboxId);
      }
      const { data: mb, error: mbErr } = await admin
        .from("mailboxes")
        .select("incoming_host, incoming_port, use_ssl, auth_user, auth_password, email_address")
        .eq("id", mailboxId)
        .maybeSingle();
      if (mbErr || !mb) {
        return new Response(JSON.stringify({ ok: false, message: "邮箱不存在" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!host) host = mb.incoming_host?.trim() ?? "";
      if (!Number.isFinite(port) || port <= 0) port = Number(mb.incoming_port);
      if (!user) user = (mb.auth_user || mb.email_address || "").trim();
      if (!pass) {
        pass = mb.auth_password ?? "";
        usedStoredPass = true;
      }
      if (body?.use_ssl === undefined) useSsl = mb.use_ssl !== false;
    }

    pass = pass.trim();
    if (!host || !Number.isFinite(port) || port <= 0 || !user || !pass) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: mailboxId && !pass
            ? "库内无授权码，请填写新授权码后再测试"
            : "host/port/user/pass 必填（编辑已有邮箱可只传 mailbox_id 使用已保存授权码）",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const r = await testImap({ host, port, user, pass, useSsl });
    const note = usedStoredPass && r.ok
      ? "（使用已保存的授权码与登录名测试成功）"
      : usedStoredPass && !r.ok
        ? "（使用已保存的授权码测试失败，若同步正常请检查 IMAP 登录用户名或收件服务器是否已改）"
        : undefined;
    const message = note ? [r.message, note].filter(Boolean).join(" ") : r.message;

    if (MAIL_LOCAL_TEST_MODE && r.ok) {
      return new Response(JSON.stringify({
        ...r,
        message: "本地测试模式已开启：当前使用明文连接（未校验证书），仅限本地调试。",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ...r, message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return new Response(
      JSON.stringify({ ok: false, message: e instanceof Error ? e.message : "未知错误" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
