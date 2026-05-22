// IMAP 收件 Edge Function（Deno 原生 TLS 实现，不依赖 Node 库）
// 实现最小 IMAP 子集：LOGIN / ID / SELECT / SEARCH / FETCH / LOGOUT
// 适配 Gmail / Outlook / 163 / QQ 等主流 IMAP 服务器
//
// 环境变量（可选，控制是否拉取完整 RFC822 以解析附件）：
// - MAIL_SYNC_FULL_BODY_MAX_BYTES：无附件邮件时，RFC822.SIZE 超过此值则只取 BODY[TEXT]，默认 5000000（5MB）
// - MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES：BODYSTRUCTURE 已标记有附件时，允许完整拉取的上限，默认 25000000（25MB）
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  extractTextFromMime,
  parseFullMime,
  type MimeAttachmentPart,
} from "../_shared/mime-parse.ts";
import { getMailTlsCaCerts } from "../_shared/mail-tls-ca.ts";
import { sanitizeDisplayName } from "../_shared/display-name.ts";
import {
  assertCanAccessMailbox,
  isServiceRoleToken,
} from "../_shared/mailbox-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SERVICE_ROLE_KEY = Deno.env.get("CRON_SERVICE_ROLE_KEY");
const MAIL_LOCAL_TEST_MODE = Deno.env.get("MAIL_LOCAL_TEST_MODE") === "true";
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

const DEFAULT_FULL_BODY_MAX_BYTES = 5_000_000;
const DEFAULT_FULL_BODY_WITH_ATTACH_MAX_BYTES = 25_000_000;

function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function connectImapTls(host: string, port: number, signal: AbortSignal): Promise<Deno.TlsConn> {
  const caCerts = await getMailTlsCaCerts("[sync-mailbox] ");
  return await Deno.connectTls({
    hostname: host,
    port,
    signal,
    ...(caCerts ? { caCerts } : {}),
  });
}

interface SyncResult {
  mailbox: string;
  fetched: number;
  inserted: number;
  total: number;
  remaining: number;
  error?: string;
}

/**
 * 从 IMAP FETCH 响应中按 literal 声明的字节数截取正文（RFC 3501）。
 * 不能用 [\s\S]*? 非贪婪到 `\r\n)`：MIME/二进制正文里可能含 `)\r\n` 等序列，会导致截断、正文丢失、附件损坏。
 */
function sliceImapLiteral(resp: string, path: string): string | null {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${esc}\\s*\\{(\\d+)\\}\\r?\\n`, "m");
  const m = resp.match(re);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return resp.slice(start, start + n);
}

/** FETCH 响应里 literal 的字段名因服务器而异（发 PEEK[] 仍可能回 BODY.PEEK[]） */
function sliceImapFullBodyLiteral(resp: string): { body: string; matched: string } | null {
  const candidates = ["BODY[]", "BODY.PEEK[]", "RFC822"] as const;
  for (const path of candidates) {
    const body = sliceImapLiteral(resp, path);
    if (body != null) return { body, matched: path };
  }
  return null;
}

/** 业务 received_at：RFC 5322 Date 头；缺失或无法解析时回退为本次入库时刻 */
function receivedAtFromDateHeader(dateHeader: string | null | undefined, ingestedAtIso: string): string {
  const raw = dateHeader?.trim();
  if (!raw) return ingestedAtIso;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return ingestedAtIso;
  return d.toISOString();
}

// ============ 极简 IMAP 客户端 ============
class ImapClient {
  private conn!: Deno.Conn | Deno.TlsConn;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private encoder = new TextEncoder();
  /** 使用 latin1 与 IMAP 原始字节一一对应，便于按 literal 字节数 slice；避免 UTF-8 解码损坏二进制 MIME 导致正文/附件截断 */
  private decoder = new TextDecoder("iso-8859-1");
  private buffer = "";
  private tagCounter = 0;

  constructor(private host: string, private port: number, private useSsl = true) {}

  async connect(timeoutMs = 15000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`IMAP connect timeout ${timeoutMs}ms`)), timeoutMs);
    try {
      this.conn = this.useSsl
        ? await connectImapTls(this.host, this.port, abort.signal)
        : await Deno.connect({ hostname: this.host, port: this.port, transport: "tcp" });
    } finally {
      clearTimeout(timer);
    }
    this.reader = this.conn.readable.getReader();
    // 读取欢迎消息（也带上超时）
    await this.readUntil(/^\* OK/m, timeoutMs);
  }

  private async readUntil(re: RegExp, timeoutMs = 15000): Promise<string> {
    const start = Date.now();
    while (!re.test(this.buffer)) {
      if (Date.now() - start > timeoutMs) throw new Error("IMAP read timeout");
      const { value, done } = await this.reader.read();
      if (done) throw new Error("IMAP connection closed");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
    return this.buffer;
  }

  private async write(s: string) {
    await this.conn.write(this.encoder.encode(s));
  }

  // 发送命令并读取到 tagged 响应（OK/NO/BAD）
  async command(cmd: string): Promise<{ ok: boolean; lines: string[]; raw: string }> {
    const tag = `A${++this.tagCounter}`;
    const line = `${tag} ${cmd}\r\n`;
    this.buffer = "";
    await this.write(line);
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    const raw = await this.readUntil(re);
    const m = raw.match(re)!;
    const ok = m[1] === "OK";
    const lines = raw.split(/\r?\n/);
    return { ok, lines, raw };
  }

  async login(user: string, pass: string) {
    // ID 命令兼容 163/QQ/企业邮
    await this.command(
      `ID ("name" "Lovable" "version" "1.0" "vendor" "Lovable")`
    );
    // 优先使用 IMAP literal 形式登录（兼容含特殊字符密码及网易企业邮）
    try {
      const r = await this.loginLiteral(user, pass);
      if (r.ok) return;
      // 回退到带引号形式
    } catch {
      // 回退到带引号形式
    }
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const r2 = await this.command(`LOGIN "${esc(user)}" "${esc(pass)}"`);
    if (!r2.ok) throw new Error("IMAP LOGIN failed: " + r2.raw.slice(-200));
  }

  // literal 形式的 LOGIN：A1 LOGIN {n}\r\n<bytes> {m}\r\n<bytes>\r\n
  async loginLiteral(user: string, pass: string): Promise<{ ok: boolean; raw: string }> {
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    const userBytes = this.encoder.encode(user);
    await this.conn.write(this.encoder.encode(`${tag} LOGIN {${userBytes.length}}\r\n`));
    await this.readUntil(/\+ /);
    this.buffer = "";
    await this.conn.write(userBytes);
    const passBytes = this.encoder.encode(pass);
    await this.conn.write(this.encoder.encode(` {${passBytes.length}}\r\n`));
    await this.readUntil(/\+ /);
    this.buffer = "";
    await this.conn.write(passBytes);
    await this.conn.write(this.encoder.encode(`\r\n`));
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    const raw = await this.readUntil(re);
    return { ok: raw.match(re)![1] === "OK", raw };
  }

  async select(mailbox = "INBOX") {
    const r = await this.command(`SELECT "${mailbox}"`);
    if (!r.ok) throw new Error("IMAP SELECT failed");
  }

  /** 从 tagged 响应行中提取所有 * SEARCH 行的 UID（服务器可能分多行返回） */
  private parseSearchUids(lines: string[]): number[] {
    const all: number[] = [];
    for (const l of lines) {
      if (l.startsWith("* SEARCH")) {
        const nums = l.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean).map(Number);
        all.push(...nums);
      }
    }
    return all;
  }

  async search(sinceDate: Date): Promise<number[]> {
    const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const d = `${sinceDate.getUTCDate()}-${m[sinceDate.getUTCMonth()]}-${sinceDate.getUTCFullYear()}`;
    const r = await this.command(`UID SEARCH SINCE ${d}`);
    if (!r.ok) return [];
    return this.parseSearchUids(r.lines);
  }

  // 按 UID 区间搜索：拉取 minUid 之后的所有邮件
  async searchSinceUid(minUid: number): Promise<number[]> {
    const r = await this.command(`UID SEARCH UID ${minUid}:*`);
    const uids = this.parseSearchUids(r.lines).filter(u => u >= minUid);
    console.log("[imap] searchSinceUid minUid:", minUid, "ok:", r.ok, "found:", uids.length);
    if (!r.ok) return [];
    return uids;
  }

  // 抓取邮件轻量元数据：只取头部 + BODYSTRUCTURE，不下载正文和附件，避免大邮件触发 CPU/内存限制
  async fetchMetadata(uid: number): Promise<string> {
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID FROM TO SUBJECT DATE)] RFC822.SIZE BODYSTRUCTURE)\r\n`);
    const doneRe = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    return await this.readUntil(doneRe);
  }

  // 下载邮件完整 MIME 正文（含 multipart 结构）：使用 BODY.PEEK[] 保留边界信息
  // rfc822Size 超过 maxBytes 时只取 BODY[TEXT]，避免超大信撑爆内存
  async fetchFullBody(
    uid: number,
    rfc822Size: number,
    timeoutMs = 10000,
    maxBytes = DEFAULT_FULL_BODY_MAX_BYTES,
  ): Promise<{ raw: string; isFull: boolean }> {
    if (rfc822Size > maxBytes) {
      console.log(
        "[fetchFullBody] rfc822 over maxBytes, using BODY[TEXT] only. uid:",
        uid,
        "rfc822Size:",
        rfc822Size,
        "maxBytes:",
        maxBytes,
      );
      const text = await this.fetchBodyTextFallback(uid, timeoutMs);
      return { raw: text, isFull: false };
    }
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[])\r\n`);
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    try {
      const raw = await this.readUntil(re, timeoutMs);
      const sliced = sliceImapFullBodyLiteral(raw);
      if (sliced != null) {
        console.log(
          "[fetchFullBody] uid:",
          uid,
          "field:",
          sliced.matched,
          "literalBytes:",
          sliced.body.length,
        );
        return { raw: sliced.body, isFull: true };
      }
      console.log("[fetchFullBody] uid:", uid, "no BODY[]/BODY.PEEK[]/RFC822 literal in FETCH response");
    } catch (e) {
      console.log("[fetchFullBody] uid:", uid, "fallback to TEXT due to:", e);
    }
    const text = await this.fetchBodyTextFallback(uid, timeoutMs);
    return { raw: text, isFull: false };
  }

  // 回退：仅取 BODY[TEXT]（与旧逻辑一致）
  private async fetchBodyTextFallback(uid: number, timeoutMs = 8000): Promise<string> {
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[TEXT])\r\n`);
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    const raw = await this.readUntil(re, timeoutMs);
    const body =
      sliceImapLiteral(raw, "BODY[TEXT]") ?? sliceImapLiteral(raw, "BODY.PEEK[TEXT]");
    if (body != null) {
      return body;
    }
    const quotedMatch = raw.match(/(?:BODY\[TEXT\]|BODY\.PEEK\[TEXT\])\s+"([^"]*?)"\s*\)/);
    if (quotedMatch) return quotedMatch[1];
    console.log("[fetchBodyTextFallback] uid:", uid, "FAILED");
    return "";
  }

  async logout() {
    try { await this.command("LOGOUT"); } catch { /* ignore */ }
    try { this.reader?.releaseLock(); } catch { /* ignore */ }
    try { this.conn?.close(); } catch { /* ignore */ }
  }
}

function headerValue(raw: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[\\t ][^\\r\\n]*)*)`, "im");
  const value = raw.match(re)?.[1];
  return value ? value.replace(/\r?\n[\t ]+/g, " ").trim() : null;
}

// RFC 2047 解码：将 =?charset?B?base64?= 和 =?charset?Q?qp?= 还原为可读文本
function decodeRfc2047(encoded: string | null): string | null {
  if (!encoded) return null;
  // 相邻编码词之间的空白应忽略
  let text = encoded.replace(/\?=\s+=\?/g, '?==?=');
  text = text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset, encoding, data) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder(charset).decode(bytes);
      } else {
        // Q 编码：=XX 是十六进制字节，_ 是空格
        const bytes: number[] = [];
        for (let i = 0; i < data.length; i++) {
          if (data[i] === '_') { bytes.push(0x20); }
          else if (data[i] === '=' && i + 2 < data.length) {
            bytes.push(parseInt(data.substring(i + 1, i + 3), 16));
            i += 2;
          } else { bytes.push(data.charCodeAt(i)); }
        }
        return new TextDecoder(charset).decode(new Uint8Array(bytes));
      }
    } catch {
      return _match; // 解码失败则保留原始内容
    }
  });
  return text || null;
}

function parseAddress(value: string | null): { name: string | null; address: string | null } {
  if (!value) return { name: null, address: null };
  const angle = value.match(/^(.*?)<([^>]+)>/);
  if (angle) {
    const name = sanitizeDisplayName(angle[1]) || null;
    return { name, address: angle[2].trim() };
  }
  const plain = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? value.trim();
  return { name: null, address: plain };
}

function sanitizeStorageFilename(name: string): string {
  const cleaned = name.replace(/[/\\]/g, "_").replace(/\0/g, "").replace(/\s+/g, " ").trim();
  const extMatch = cleaned.match(/\.([A-Za-z0-9]{1,10})$/);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : "";
  const stem = ext ? cleaned.slice(0, -ext.length) : cleaned;
  const asciiStem = stem
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ .-]+|[_ .-]+$/g, "")
    .slice(0, 120);
  return `${asciiStem || "file"}${ext}`.slice(0, 180);
}

function attachmentJsonLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** 上传 MIME 解析出的附件到 Storage，写 email_attachments 并返回 emails.attachments JSON 数组项 */
async function persistEmailAttachments(
  admin: ReturnType<typeof createClient>,
  mailboxId: string,
  emailId: string,
  parts: MimeAttachmentPart[],
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const bucket = "email-attachments";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const safe = sanitizeStorageFilename(p.filename);
    const storagePath = `${mailboxId}/${emailId}/${i}_${safe}`;
    try {
      const blob = new Blob([p.bytes], { type: p.contentType || "application/octet-stream" });
      const { error: upErr } = await admin.storage.from(bucket).upload(storagePath, blob, {
        contentType: p.contentType || "application/octet-stream",
        upsert: true,
      });
      if (upErr) {
        const warning = upErr.message;
        await admin.from("email_attachments").insert({
          email_id: emailId,
          filename: p.filename,
          content_type: p.contentType,
          size_bytes: p.bytes.length,
          storage_bucket: bucket,
          storage_path: null,
          download_status: "failed",
          warning,
        });
        out.push({
          filename: p.filename,
          contentType: p.contentType,
          size: p.bytes.length,
          storage_path: null,
          warning,
        });
        continue;
      }
      await admin.from("email_attachments").insert({
        email_id: emailId,
        filename: p.filename,
        content_type: p.contentType,
        size_bytes: p.bytes.length,
        storage_bucket: bucket,
        storage_path: storagePath,
        download_status: "completed",
        warning: null,
      });
      out.push({
        filename: p.filename,
        contentType: p.contentType,
        size: p.bytes.length,
        storage_path: storagePath,
      });
    } catch (e) {
      const warning = e instanceof Error ? e.message : String(e);
      await admin.from("email_attachments").insert({
        email_id: emailId,
        filename: p.filename,
        content_type: p.contentType,
        size_bytes: p.bytes.length,
        storage_bucket: bucket,
        storage_path: null,
        download_status: "failed",
        warning,
      });
      out.push({
        filename: p.filename,
        contentType: p.contentType,
        size: p.bytes.length,
        storage_path: null,
        warning,
      });
    }
  }
  return out;
}

/**
 * 从 FETCH 元数据（含 BODYSTRUCTURE）判断是否有附件。
 * 注意：不能用「从 BODYSTRUCTURE( 到末尾 ))」这种正则——嵌套括号与同一 FETCH 里还有 RFC822.SIZE 等字段时会匹配失败，
 * 若匹配失败就返回 false，会导致误判为无附件、整封体积上限变小、只拉 BODY[TEXT]，attachments 永远为空。
 */
function detectAttachments(metaRaw: string): { hasAttachment: boolean; count: number } {
  const raw = metaRaw;
  let hasAttachment = false;
  let count = 0;

  // 1) 全文启发式（不依赖嵌套括号解析）
  if (/"attachment"/i.test(raw)) {
    hasAttachment = true;
    count = Math.max(count, (raw.match(/"attachment"/gi) ?? []).length);
  }
  if (/BODYSTRUCTURE/i.test(raw) && /\bMIXED\b/i.test(raw)) {
    hasAttachment = true;
  }
  if (/FILENAME\s*=/i.test(raw) || /\bNAME\s*=\s*"/i.test(raw)) {
    hasAttachment = true;
  }

  // 2) 仅从 BODYSTRUCTURE 起始处截取一段做细化（避免误把整个 FETCH 当 structure）
  const bs = raw.match(/BODYSTRUCTURE\s*\(/i);
  if (bs && bs.index !== undefined) {
    const slice = raw.slice(bs.index, Math.min(bs.index + 400_000, raw.length));
    if (/mixed/i.test(slice)) hasAttachment = true;
    const attachMatches = slice.match(/"attachment"|"ATTACHMENT"|FILENAME\s*["\[]|NAME\s*["\[]/gi);
    if (attachMatches) {
      hasAttachment = true;
      count = Math.max(count, attachMatches.length);
    }
  }

  return { hasAttachment, count: Math.max(count, hasAttachment ? 1 : 0) };
}

/** 拉取整封 RFC822 时 readUntil 等待 tagged OK 的超时：大体积+慢链路需要更长 */
function imapFullBodyReadTimeoutMs(hasAttachment: boolean, rfc822Size: number): number {
  const base = hasAttachment ? 35_000 : 15_000;
  const extra = Math.min(120_000, Math.floor(rfc822Size / 8192) * 1000);
  return Math.min(180_000, base + extra);
}

// ============ 同步逻辑 ============
async function syncOne(mb: any, admin: any, forceBulk = false): Promise<SyncResult> {
  const result: SyncResult = { mailbox: mb.email_address, fetched: 0, inserted: 0, total: 0, remaining: 0 };
  const effectiveUseSsl = MAIL_LOCAL_TEST_MODE ? false : (mb.use_ssl !== false);
  const client = new ImapClient(mb.incoming_host, Number(mb.incoming_port), effectiveUseSsl);

  try {
    console.log("[sync]", mb.email_address, mb.incoming_host, mb.incoming_port, "id:", mb.id, "type:", typeof mb.id);
    // 连接失败时自动重试一次（网易企业邮等中国邮箱常有瞬时路由问题）
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await client.connect();
        break;
      } catch (connErr) {
        // 清理可能的半开连接
        try { (client as any).conn?.close(); } catch {}
        try { (client as any).reader?.releaseLock(); } catch {}
        if (attempt === 2) throw connErr;
        console.log(`[sync] connect attempt ${attempt} failed, retrying...`, connErr);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    await client.login(mb.auth_user, mb.auth_password);
    await client.select("INBOX");

    // 同步策略：
    // - last_uid > 0：增量 UID 搜索（仅拉取后续新邮件）
    // - last_uid <= 0：按 30 天日期范围搜索，从最新开始倒序同步
    // 多轮分批：每轮最多 20 封，一次同步调用最多 20 轮（共 400 封）
    const DAYS_BACK = 30;
    const PER_ROUND = 20;
    const MAX_ROUNDS = 20;
    const TIME_BUDGET_MS = 45_000; // 总时间预算 45s
    const startedAt = Date.now();

    let uids: number[] = [];
    const isBulkSync = forceBulk || !mb.last_uid || mb.last_uid <= 0;
    if (isBulkSync) {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - DAYS_BACK);
      uids = await client.search(sinceDate);
    } else {
      uids = await client.searchSinceUid(mb.last_uid + 1);
    }
    uids.sort((a, b) => b - a); // 降序：最新邮件优先
    result.total = uids.length;
    console.log("[sync] isBulkSync:", isBulkSync, "totalFound:", uids.length);

    let progressUid = mb.last_uid ?? 0;
    let overallFetched = 0;
    let overallInserted = 0;

    // 多轮分批循环
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const roundStart = round * PER_ROUND;
      const roundUids = uids.slice(roundStart, roundStart + PER_ROUND);
      if (roundUids.length === 0) {
        console.log("[sync] no more UIDs to process after round", round);
        break;
      }

      const roundStartTs = Date.now();
      console.log(`[sync] round ${round + 1}/${MAX_ROUNDS}: ${roundUids.length} uids`);

      // --- Phase 1: 拉取元数据（仅头部 + BODYSTRUCTURE） ---
      const metaList: Array<{ uid: number; messageId: string; raw: string }> = [];
      let roundMaxUid = progressUid;
      for (const uid of roundUids) {
        if (Date.now() - startedAt > TIME_BUDGET_MS - 10000) {
          console.log("[sync] time budget low, stopping metadata fetch at uid:", uid);
          break;
        }
        try {
          const raw = await client.fetchMetadata(uid);
          if (!raw) { if (uid > roundMaxUid) roundMaxUid = uid; continue; }
          const messageId = headerValue(raw, "Message-ID") ?? `${mb.id}-${uid}`;
          metaList.push({ uid, messageId, raw });
          if (uid > roundMaxUid) roundMaxUid = uid;
        } catch (perMsgErr) {
          console.error(`fetch metadata uid ${uid} failed:`, perMsgErr);
        }
      }
      const roundFetched = metaList.length;
      overallFetched += roundFetched;
      console.log(`[sync] round ${round + 1} phase1: metaList=${roundFetched}`);

      // --- Phase 2: 去重；对历史空附件/失败附件记录允许在 Phase 3 修复 ---
      const existingByMessageId = new Map<string, { id: string; message_id: string; attachments: unknown }>();
      const failedAttachmentEmailIds = new Set<string>();
      if (metaList.length > 0) {
        const messageIds = metaList.map(m => m.messageId);
        const CHUNK = 200;
        for (let i = 0; i < messageIds.length; i += CHUNK) {
          const chunk = messageIds.slice(i, i + CHUNK);
          const { data: existRows } = await admin
            .from("emails")
            .select("id, message_id, attachments")
            .in("message_id", chunk);
          for (const row of (existRows ?? [])) {
            existingByMessageId.set(row.message_id, row);
          }
          const emailIds = (existRows ?? []).map((row: { id: string }) => row.id);
          if (emailIds.length > 0) {
            const { data: failedRows } = await admin
              .from("email_attachments")
              .select("email_id")
              .in("email_id", emailIds)
              .eq("download_status", "failed");
            for (const row of (failedRows ?? [])) {
              failedAttachmentEmailIds.add(row.email_id);
            }
          }
        }
      }
      console.log(`[sync] round ${round + 1} phase2: existing=${existingByMessageId.size}`);

      // --- Phase 3: 下载正文 + 入库 ---
      let roundInserted = 0;
      let roundHandledUid = progressUid;
      const insertedEmailIds: string[] = [];
      for (const meta of metaList) {
        if (Date.now() - startedAt > TIME_BUDGET_MS - 5000) {
          console.log("[sync] time budget critical, stopping body download");
          break;
        }

        // FETCH 应答里是「RFC822.SIZE 12345」，不是 MIME 头「RFC822.SIZE:」
        const rfc822SizeMatch = meta.raw.match(/RFC822\.SIZE\s+(\d+)/i);
        const rfc822Size = rfc822SizeMatch ? parseInt(rfc822SizeMatch[1], 10) || 0 : 0;
        const attachInfo = detectAttachments(meta.raw);
        const maxBytesNoAttach = parseEnvPositiveInt(
          "MAIL_SYNC_FULL_BODY_MAX_BYTES",
          DEFAULT_FULL_BODY_MAX_BYTES,
        );
        const maxBytesWithAttach = parseEnvPositiveInt(
          "MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES",
          DEFAULT_FULL_BODY_WITH_ATTACH_MAX_BYTES,
        );
        const maxBytesForFetch = attachInfo.hasAttachment ? maxBytesWithAttach : maxBytesNoAttach;

        const existing = existingByMessageId.get(meta.messageId);
        if (existing) {
          const needsAttachmentRepair =
            attachInfo.hasAttachment &&
            (attachmentJsonLength(existing.attachments) === 0 || failedAttachmentEmailIds.has(existing.id));
          if (!needsAttachmentRepair) {
            roundHandledUid = meta.uid;
            continue;
          }

          console.log("[sync] repairing attachments for existing email uid:", meta.uid, "email_id:", existing.id);
          try {
            const { raw: rawBody, isFull } = await client.fetchFullBody(
              meta.uid,
              rfc822Size,
              imapFullBodyReadTimeoutMs(true, rfc822Size),
              maxBytesForFetch,
            );
            const parsed = isFull && rawBody ? parseFullMime(rawBody) : null;
            if (parsed?.attachments.length) {
              await admin.from("email_attachments").delete().eq("email_id", existing.id);
              const attJson = await persistEmailAttachments(
                admin,
                String(mb.id),
                existing.id,
                parsed.attachments,
              );
              await admin.from("emails").update({
                attachments: attJson as unknown,
                has_attachment: attJson.length > 0 || attachInfo.hasAttachment,
              }).eq("id", existing.id);
            } else {
              await admin.from("emails").update({
                attachments: [{
                  count: attachInfo.count,
                  note: isFull
                    ? "IMAP 已标记附件，但修复时未从 MIME 中解析出二进制。"
                    : "附件已检测到；修复时仅拉取了正文摘要，附件未同步（整封超过 MAIL_SYNC_FULL_BODY_* 上限或 FETCH 超时）。",
                }] as unknown,
                has_attachment: true,
              }).eq("id", existing.id);
            }
          } catch (repairErr) {
            const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
            console.error("[repair attachments]", repairErr);
            await admin.from("emails").update({
              attachments: [{
                note: "附件修复失败，请检查 Edge 日志与 Storage 策略。",
                error: msg.slice(0, 500),
              }] as unknown,
              has_attachment: true,
            }).eq("id", existing.id);
          }
          roundHandledUid = meta.uid;
          continue;
        }

        const fromAddr = parseAddress(headerValue(meta.raw, "From"));
        const toAddr = parseAddress(headerValue(meta.raw, "To"));
        const subject = decodeRfc2047(headerValue(meta.raw, "Subject"));
        // 业务时间与 SLA / 草稿窗口一致：使用 MIME Date 头；缺失则回退为同步入库时刻
        const messageDateHeader = headerValue(meta.raw, "Date");

        let bodyText = "";
        let bodyHtml: string | null = null;
        let mimeAttachmentParts: MimeAttachmentPart[] = [];
        let fullBodyFetched = false;
        try {
          const { raw: rawBody, isFull } = await client.fetchFullBody(
            meta.uid,
            rfc822Size,
            imapFullBodyReadTimeoutMs(attachInfo.hasAttachment, rfc822Size),
            maxBytesForFetch,
          );
          fullBodyFetched = isFull;
          if (rawBody) {
            if (isFull) {
              const parsed = parseFullMime(rawBody);
              bodyText = parsed.bodyText;
              bodyHtml = parsed.bodyHtml;
              mimeAttachmentParts = parsed.attachments;
            } else {
              bodyText = extractTextFromMime(rawBody);
            }
            if (bodyText.length > 50000) bodyText = bodyText.substring(0, 50000) + "\n\n[正文过长，已截断]";
            if (bodyHtml && bodyHtml.length > 100_000) bodyHtml = bodyHtml.substring(0, 100_000) + "\n\n[HTML 内容过长，已截断]";
          }
        } catch (bodyErr) {
          console.error(`[body uid ${meta.uid}]`, bodyErr);
        }

        const initialAttachments: Record<string, unknown>[] = !fullBodyFetched && attachInfo.hasAttachment
          ? [{
            count: attachInfo.count,
            note: "附件已检测到；仅拉取了正文摘要，附件未同步（整封超过 MAIL_SYNC_FULL_BODY_* 上限或 FETCH 超时时仅取 BODY[TEXT]）。",
          }]
          : [];

        const hasAttFlag = mimeAttachmentParts.length > 0 || attachInfo.hasAttachment;

        const ingestedAt = new Date().toISOString();
        const { data: insertedEmail, error: insErr } = await admin.from("emails").insert({
          mailbox_id: mb.id,
          message_id: meta.messageId,
          from_email: fromAddr.address ?? "unknown@unknown",
          from_name: decodeRfc2047(fromAddr.name),
          to_email: toAddr.address ?? mb.email_address,
          subject,
          body_text: bodyText,
          body_html: bodyHtml,
          received_at: receivedAtFromDateHeader(messageDateHeader, ingestedAt),
          has_attachment: hasAttFlag,
          attachments: initialAttachments,
          missing_elements: [],
          status: "pending",
          is_read: false,
          idempotency_key: `sync:${mb.id}:${meta.messageId}`,
        }).select("id").single();
        if (insErr) {
          console.error("[insert err]", insErr);
          break; // 入库失败则不继续本轮
        }
        if (insertedEmail?.id) {
          insertedEmailIds.push(insertedEmail.id);
          if (fullBodyFetched && mimeAttachmentParts.length > 0) {
            try {
              const attJson = await persistEmailAttachments(
                admin,
                String(mb.id),
                insertedEmail.id,
                mimeAttachmentParts,
              );
              await admin.from("emails").update({
                attachments: attJson as unknown,
                has_attachment: attJson.length > 0 || attachInfo.hasAttachment,
              }).eq("id", insertedEmail.id);
            } catch (attErr) {
              const msg = attErr instanceof Error ? attErr.message : String(attErr);
              console.error("[persist attachments]", attErr);
              try {
                await admin.from("emails").update({
                  attachments: [{
                    note: "附件已解析但写入存储/数据库失败，请检查 Edge 日志与 Storage 策略。",
                    error: msg.slice(0, 500),
                  }] as unknown,
                  has_attachment: true,
                }).eq("id", insertedEmail.id);
              } catch (e2) {
                console.error("[persist attachments] failed to write error note", e2);
              }
            }
          } else if (fullBodyFetched && attachInfo.hasAttachment && mimeAttachmentParts.length === 0) {
            await admin.from("emails").update({
              attachments: [{
                count: attachInfo.count,
                note: "IMAP 已标记附件，但未从 MIME 中解析出二进制（结构特殊或超过单文件大小限制）。",
              }] as unknown,
              has_attachment: true,
            }).eq("id", insertedEmail.id);
          }
        }
        roundInserted++;
        roundHandledUid = meta.uid;
      }

      overallInserted += roundInserted;

      // 本轮进度标记
      const roundProgressUid = roundHandledUid > 0 ? roundHandledUid : roundMaxUid;
      if (roundProgressUid > progressUid) progressUid = roundProgressUid;

      // 每轮结束后保存进度（确保中断时有部分进度）
      await admin.from("mailboxes").update({
        last_synced_at: new Date().toISOString(),
        last_error: null,
        last_uid: progressUid,
      }).eq("id", mb.id);

      // 每轮触发 AI 处理
      if (insertedEmailIds.length > 0) {
        EdgeRuntime.waitUntil(fetch(`${SUPABASE_URL}/functions/v1/process-email`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email_ids: insertedEmailIds }),
        }).then(async (res) => {
          if (!res.ok) console.error("[process-email enqueue failed]", await res.text());
        }).catch((err) => console.error("[process-email enqueue error]", err)));
      }

      const roundDuration = Date.now() - roundStartTs;
      console.log(`[sync] round ${round + 1} done: fetched=${roundFetched} inserted=${roundInserted} duration=${roundDuration}ms`);

      // 时间不足则提前退出，剩余邮件下次 cron 继续
      if (Date.now() - startedAt > TIME_BUDGET_MS - 15000) {
        console.log("[sync] time budget nearly exhausted, stopping rounds");
        break;
      }
    }

    result.fetched = overallFetched;
    result.inserted = overallInserted;
    result.remaining = Math.max(0, uids.length - overallFetched);
    console.log("[sync] all rounds done. fetched:", overallFetched, "inserted:", overallInserted, "total:", result.total, "remaining:", result.remaining, "progressUid:", progressUid);

    // 最终进度更新
    await admin.from("mailboxes").update({
      last_synced_at: new Date().toISOString(),
      last_error: null,
      last_uid: progressUid,
    }).eq("id", mb.id);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error("[sync error]", mb.email_address, result.error);
    // 回写错误，便于前端展示
    await admin
      .from("mailboxes")
      .update({ last_error: result.error })
      .eq("id", mb.id);
  } finally {
    await client.logout();
  }
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isServiceRole = isServiceRoleToken(
      token,
      SUPABASE_SERVICE_ROLE_KEY,
      CRON_SERVICE_ROLE_KEY,
    );

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    let manualUserId: string | null = null;

    if (!isServiceRole) {
      if (!token) {
        return new Response(JSON.stringify({ error: "未授权" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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
      const { data: isStaff } = await admin.rpc("is_staff", { _user_id: userData.user.id });
      if (!isStaff) {
        return new Response(JSON.stringify({ error: "权限不足" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      manualUserId = userData.user.id;
    }

    let mailboxId: string | undefined;
    let forceBulk = false;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        mailboxId = body?.mailbox_id;
        forceBulk = body?.force_bulk === true;
      } catch { /* ignore */ }
    }

    if (manualUserId && mailboxId) {
      try {
        await assertCanAccessMailbox(admin, manualUserId, mailboxId);
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }
    }

    const query = admin.from("mailboxes").select("*").eq("is_active", true);
    if (mailboxId) query.eq("id", mailboxId);
    let { data: mailboxes, error: mbErr } = await query;
    if (mbErr) throw mbErr;

    if (manualUserId && mailboxes && mailboxes.length > 0) {
      const { data: isAdmin } = await admin.rpc("has_role", {
        _user_id: manualUserId,
        _role: "admin",
      });
      if (!isAdmin) {
        const allowed: typeof mailboxes = [];
        for (const mb of mailboxes) {
          const { data: ok } = await admin.rpc("can_access_mailbox", {
            _user_id: manualUserId,
            _mailbox_id: mb.id,
          });
          if (ok) allowed.push(mb);
        }
        mailboxes = allowed;
      }
    }

    if (!mailboxes || mailboxes.length === 0) {
      return new Response(JSON.stringify({ message: "无启用邮箱", results: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (mailboxId) {
      // 单个邮箱同步（手动触发）：同步执行并返回结果
      const results: SyncResult[] = [];
      for (const mb of mailboxes) {
        const r = await syncOne(mb, admin, forceBulk);
        results.push(r);
      }
      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 全部邮箱同步（cron 自动）：异步后台执行
    EdgeRuntime.waitUntil((async () => {
      for (const mb of mailboxes) {
        await syncOne(mb, admin);
      }
    })());

    return new Response(JSON.stringify({ queued: true, mailbox_count: mailboxes.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("sync-mailbox error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "未知错误" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
