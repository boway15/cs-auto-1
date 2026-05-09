// 极简 Deno 原生 SMTP 客户端，支持 SSL(465) / STARTTLS(587/25)
// 仅实现：EHLO / STARTTLS / AUTH LOGIN / MAIL FROM / RCPT TO / DATA / QUIT

interface Mailbox {
  smtp_host: string;
  smtp_port: number;
  auth_user: string;
  auth_password: string;
  email_address: string;
  display_name?: string | null;
}

interface SendOpts {
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

const MAIL_LOCAL_TEST_MODE = Deno.env.get("MAIL_LOCAL_TEST_MODE") === "true";
let cachedMailTlsCaCerts: string[] | undefined | null;

async function getMailTlsCaCerts(): Promise<string[] | undefined> {
  if (cachedMailTlsCaCerts !== null && cachedMailTlsCaCerts !== undefined) {
    return cachedMailTlsCaCerts;
  }

  const certs: string[] = [];
  const inlinePem = Deno.env.get("MAIL_TLS_CA_CERT_PEM")?.trim();
  if (inlinePem) certs.push(inlinePem.replace(/\\n/g, "\n"));

  const rawPaths = Deno.env.get("MAIL_TLS_CA_CERT_PATH") || Deno.env.get("DENO_CERT") || "";
  const paths = rawPaths.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  for (const path of paths) {
    try {
      certs.push(await Deno.readTextFile(path));
    } catch (e) {
      console.error(`[smtp] failed to read CA cert path=${path}:`, e);
    }
  }

  cachedMailTlsCaCerts = certs.length > 0 ? certs : null;
  return cachedMailTlsCaCerts ?? undefined;
}

function b64(s: string) {
  return btoa(unescape(encodeURIComponent(s)));
}

function encodeSubject(s: string) {
  // RFC 2047 UTF-8 Base64 编码（避免中文主题乱码）
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${b64(s)}?=`;
}

export async function sendMail(mb: Mailbox, opts: SendOpts): Promise<string> {
  const port = Number(mb.smtp_port);
  const useSSL = MAIL_LOCAL_TEST_MODE ? false : port === 465;
  if (MAIL_LOCAL_TEST_MODE && port === 465) {
    throw new Error("本地测试模式已开启：SMTP 465 需要 TLS，请改用 25/587 或关闭 MAIL_LOCAL_TEST_MODE。");
  }
  const caCerts = await getMailTlsCaCerts();

  let conn: Deno.Conn = useSSL
    ? await Deno.connectTls({ hostname: mb.smtp_host, port, ...(caCerts ? { caCerts } : {}) })
    : await Deno.connect({ hostname: mb.smtp_host, port });

  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";

  async function read(): Promise<string> {
    const b = new Uint8Array(8192);
    const n = await conn.read(b);
    if (n === null) throw new Error("SMTP connection closed");
    buf += dec.decode(b.subarray(0, n));
    // 读到完整一行结束
    while (!/\r\n$/.test(buf)) {
      const n2 = await conn.read(b);
      if (n2 === null) break;
      buf += dec.decode(b.subarray(0, n2));
    }
    const out = buf;
    buf = "";
    return out;
  }

  async function expect(code: string, ctx: string) {
    const r = await read();
    if (!r.startsWith(code)) throw new Error(`SMTP ${ctx} failed: ${r.trim()}`);
    return r;
  }

  async function write(s: string) {
    await conn.write(enc.encode(s));
  }

  try {
    await expect("220", "greet");

    await write(`EHLO lovable\r\n`);
    let ehlo = await expect("250", "EHLO");

    // STARTTLS（非 SSL 情形）
    if (!useSSL && /STARTTLS/i.test(ehlo) && !MAIL_LOCAL_TEST_MODE) {
      await write(`STARTTLS\r\n`);
      await expect("220", "STARTTLS");
      const tls = await Deno.startTls(conn as Deno.TcpConn, {
        hostname: mb.smtp_host,
        ...(caCerts ? { caCerts } : {}),
      });
      conn = tls;
      await write(`EHLO lovable\r\n`);
      ehlo = await expect("250", "EHLO2");
    }

    // AUTH LOGIN
    await write(`AUTH LOGIN\r\n`);
    await expect("334", "AUTH");
    await write(`${b64(mb.auth_user)}\r\n`);
    await expect("334", "AUTH user");
    await write(`${b64(mb.auth_password)}\r\n`);
    await expect("235", "AUTH pass");

    await write(`MAIL FROM:<${mb.email_address}>\r\n`);
    await expect("250", "MAIL FROM");
    await write(`RCPT TO:<${opts.to}>\r\n`);
    await expect("250", "RCPT TO");
    await write(`DATA\r\n`);
    await expect("354", "DATA");

    const messageId = `<${crypto.randomUUID()}@${mb.email_address.split("@")[1] ?? "localhost"}>`;
    const fromName = mb.display_name ? `${encodeSubject(mb.display_name)} ` : "";
    const headers = [
      `From: ${fromName}<${mb.email_address}>`,
      `To: <${opts.to}>`,
      `Subject: ${encodeSubject(opts.subject)}`,
      `Message-ID: ${messageId}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      `Date: ${new Date().toUTCString()}`,
    ];
    if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts.references) headers.push(`References: ${opts.references}`);

    // 正文 base64，按 76 字符换行
    const body = b64(opts.text).replace(/(.{76})/g, "$1\r\n");
    const data = headers.join("\r\n") + "\r\n\r\n" + body + "\r\n.\r\n";
    await write(data);
    await expect("250", "BODY");
    try { await write(`QUIT\r\n`); } catch { /* ignore */ }
    return messageId;
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
}
