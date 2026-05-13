// 测试 IMAP 邮箱连通性：connect → login → select INBOX → logout
// 仅做一次性轻量校验，不拉邮件，超时 20s
import { getMailTlsCaCerts } from "../_shared/mail-tls-ca.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAIL_LOCAL_TEST_MODE = Deno.env.get("MAIL_LOCAL_TEST_MODE") === "true";

async function connectImapTls(host: string, port: number): Promise<Deno.TlsConn> {
  const caCerts = await getMailTlsCaCerts("[test-mailbox] ");
  return await Deno.connectTls({
    hostname: host,
    port,
    ...(caCerts ? { caCerts } : {}),
  });
}

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
      ? await connectImapTls(opts.host, opts.port)
      : await Deno.connect({ hostname: opts.host, port: opts.port });
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
    // literal LOGIN（兼容含特殊字符密码 / 网易企业邮）
    async function loginLiteral(user: string, pass: string) {
      const tag = `A${++tagN}`;
      buf = "";
      // 先发命令头 + 用户名 literal 长度
      const userBytes = enc.encode(user);
      await conn!.write(enc.encode(`${tag} LOGIN {${userBytes.length}}\r\n`));
      // 等待续行符 +
      await readUntil(/\+ /);
      buf = "";
      // 写用户名 + 空格 + 密码 literal 长度
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
    try { await cmd(`ID ("name" "Lovable" "version" "1.0")`); } catch { /* 部分服务器不支持 ID 命令，忽略 */ }

    step = "login";
    // 优先尝试 literal 形式（更兼容）
    let r = await loginLiteral(opts.user, opts.pass);
    if (!r.ok) {
      // 回退：传统带引号 LOGIN
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      r = await cmd(`LOGIN "${esc(opts.user)}" "${esc(opts.pass)}"`);
      if (!r.ok) {
        return { ok: false, step, message: `登录失败：${r.raw.slice(-300).trim()}（请检查授权码是否正确、是否已在邮箱后台开启 IMAP/SMTP 服务）` };
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
        message: "[connect] 邮箱服务器证书不被当前 Edge Functions 信任。请将该邮箱服务器的根证书/中间证书 PEM 配置到 MAIL_TLS_CA_CERT_PATH 或 MAIL_TLS_CA_CERT_PEM 后重启 functions。",
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
    const body = await req.json();
    const { host, port, user, pass, use_ssl } = body ?? {};
    if (!host || !port || !user || !pass) {
      return new Response(JSON.stringify({ ok: false, message: "host/port/user/pass 必填" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const r = await testImap({
      host,
      port: Number(port),
      user,
      pass,
      useSsl: use_ssl !== false,
    });
    if (MAIL_LOCAL_TEST_MODE && r.ok) {
      return new Response(JSON.stringify({
        ...r,
        message: "本地测试模式已开启：当前使用明文连接（未校验证书），仅限本地调试。",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(r), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, message: e instanceof Error ? e.message : "未知错误" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
