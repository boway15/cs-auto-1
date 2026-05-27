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
  assertStaffCanAccessEmail,
  isServiceRoleToken,
  type StaffActor,
} from "../_shared/mailbox-access.ts";
import {
  enqueueBodyRepairTask,
  friendlyRepairError,
  isWorkerCancelledError,
  recordBodyRepairEvent,
  finalizePostBodyRepair,
} from "../_shared/email-body-repair-queue.ts";
import { enqueueAttachmentRepairTask } from "../_shared/email-attachment-repair-queue.ts";
import {
  buildMessageIdSearchCandidates,
  messageIdMatchesHeader,
} from "../_shared/imap-message-id.ts";

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

interface SyncOptions {
  forceBulk?: boolean;
  repairEmptyBody?: boolean;
  repairMissingAttachments?: boolean;
}

interface SyncResult {
  mailbox: string;
  fetched: number;
  inserted: number;
  total: number;
  remaining: number;
  repaired?: number;
  empty_body_remaining?: number;
  mode?: "incremental" | "historical" | "repair_body" | "repair_attachments" | "repair_single";
  attachments_remaining?: number;
  skipped?: boolean;
  email_id?: string;
  error?: string;
  queued?: boolean;
  queue_reason?: string;
  /** true：不应再提示“已入队等待” */
  terminal?: boolean;
}

function repairSingleShell(mailbox: string, extra: Partial<SyncResult> = {}): SyncResult {
  return {
    mailbox,
    fetched: 0,
    inserted: 0,
    total: 0,
    remaining: 0,
    mode: "repair_single",
    ...extra,
  };
}

type RepairOneOptions = {
  /** 点开轻量：优先 BODY.PEEK[TEXT]，短超时，不上传附件 */
  lightweight?: boolean;
  readTimeoutCapMs?: number;
  skipAttachments?: boolean;
  /** 后台补正文遇到大附件时只取正文，避免 BODY.PEEK[] 拉整封邮件触发 WorkerRequestCancelled */
  forceTextOnly?: boolean;
};

const REPAIR_SINGLE_TIME_BUDGET_MS = 16_000;
/** 交互式附件补拉：RFC822.SIZE 超过此值则先入队，避免单请求拉整封超大邮件 */
const INTERACTIVE_ATTACHMENT_RFC822_MAX_BYTES = 28_000_000;

type EmailRepairRow = {
  id: string;
  message_id: string | null;
  body_text?: string | null;
  body_html?: string | null;
  has_attachment?: boolean | null;
  received_at?: string | null;
};

const REPAIR_BODY_BATCH = 5;
const REPAIR_BODY_SCAN_LIMIT = 80;
const REPAIR_ATTACH_BATCH = 5;
const REPAIR_ATTACH_SCAN_LIMIT = 80;

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

  async searchSinceBeforeUid(sinceDate: Date, beforeUid: number | null): Promise<number[]> {
    if (beforeUid != null && beforeUid <= 1) return [];
    const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const d = `${sinceDate.getUTCDate()}-${m[sinceDate.getUTCMonth()]}-${sinceDate.getUTCFullYear()}`;
    const uidRange = beforeUid != null ? ` UID 1:${beforeUid - 1}` : "";
    const r = await this.command(`UID SEARCH SINCE ${d}${uidRange}`);
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

  /** 按 Message-ID 头搜索 UID（补正文模式） */
  async searchByMessageId(messageId: string): Promise<number[]> {
    const trimmed = messageId.trim();
    if (!trimmed) return [];
    const esc = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const r = await this.command(`UID SEARCH HEADER Message-ID "${esc}"`);
    if (!r.ok) return [];
    return this.parseSearchUids(r.lines);
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

  async fetchTextOnly(uid: number, timeoutMs = 5000): Promise<string> {
    return await this.fetchBodyTextFallback(uid, timeoutMs);
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

function isInvalidStoredAttachmentMeta(item: Record<string, unknown>): boolean {
  const ct = String(item.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (ct.startsWith("multipart/") || ct.startsWith("message/")) return true;
  const fn = String(item.filename ?? "").trim().toLowerCase();
  if (/^attachment-\d+$/.test(fn) && !/\.[a-z0-9]{2,8}$/i.test(fn)) {
    if (ct.startsWith("multipart/") || ct.startsWith("message/") || ct === "application/octet-stream") {
      return true;
    }
  }
  return false;
}

/** emails.attachments 是否仅有占位说明、尚无有效 storage_path 可下载 */
function attachmentsJsonNeedsBinarySync(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  const hasValid = value.some((item) => {
    if (!item || typeof item !== "object") return false;
    const o = item as Record<string, unknown>;
    if (isInvalidStoredAttachmentMeta(o)) return false;
    if (typeof o.storage_path === "string" && o.storage_path.trim()) return true;
    if (typeof o.url === "string" && o.url.trim()) return true;
    return false;
  });
  return !hasValid;
}

/** 历史轻量同步占位：count 较大时通常含超大视频，交互请求不宜同步拉整封 */
function placeholderSuggestsLargeMail(attachments: unknown): boolean {
  if (!Array.isArray(attachments) || attachments.length === 0) return false;
  const maxCount = attachments.reduce((max, item) => {
    if (!item || typeof item !== "object") return max;
    const c = (item as Record<string, unknown>).count;
    return typeof c === "number" && c > max ? c : max;
  }, 0);
  return maxCount >= 5;
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
    const ctMain = (p.contentType || "").split(";")[0].trim().toLowerCase();
    if (ctMain.startsWith("multipart/") || ctMain.startsWith("message/")) {
      console.warn("[persist attachments] skip non-file part:", ctMain, p.filename);
      continue;
    }
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

function parseOptionalUid(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function countHistoricalRemaining(uids: number[], cursorUid: number | null): number {
  if (cursorUid == null) return uids.length;
  return uids.filter((uid) => uid < cursorUid).length;
}

function isBodyEmpty(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): boolean {
  return !String(bodyText ?? "").trim() && !String(bodyHtml ?? "").trim();
}

/** Postgres text 不允许 NUL（\u0000），否则 22P05 导致入库失败 */
function sanitizePostgresText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.replace(/\u0000/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function resolveUidFromSyntheticMessageId(messageId: string, mailboxId: string): number | null {
  const prefix = `${mailboxId}-`;
  if (!messageId.startsWith(prefix)) return null;
  const n = parseInt(messageId.slice(prefix.length), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseFetchedMimeBody(
  rawBody: string,
  isFull: boolean,
  attachmentsOnly = false,
): { bodyText: string; bodyHtml: string | null; mimeAttachmentParts: MimeAttachmentPart[] } {
  let bodyText = "";
  let bodyHtml: string | null = null;
  let mimeAttachmentParts: MimeAttachmentPart[] = [];
  if (!rawBody) return { bodyText, bodyHtml, mimeAttachmentParts };
  const parsed = parseFullMime(rawBody, attachmentsOnly ? { attachmentsOnly: true } : undefined);
  bodyText = parsed.bodyText;
  bodyHtml = parsed.bodyHtml;
  // BODY[TEXT] 等片段 FETCH 不可信，避免把正文/HTML 误解析为可下载附件
  mimeAttachmentParts = isFull ? parsed.attachments : [];
  if (!isFull && mimeAttachmentParts.length === 0 && isBodyEmpty(bodyText, bodyHtml)) {
    bodyText = extractTextFromMime(rawBody);
  }
  if (bodyText.length > 50000) bodyText = bodyText.substring(0, 50000) + "\n\n[正文过长，已截断]";
  if (bodyHtml && bodyHtml.length > 100_000) {
    bodyHtml = bodyHtml.substring(0, 100_000) + "\n\n[HTML 内容过长，已截断]";
  }
  return { bodyText, bodyHtml, mimeAttachmentParts };
}

async function countEmptyBodyEmails(admin: ReturnType<typeof createClient>, mailboxId: string): Promise<number> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - 30);
  const { data, error } = await admin
    .from("emails")
    .select("id, body_text, body_html")
    .eq("mailbox_id", mailboxId)
    .gte("received_at", sinceDate.toISOString());
  if (error) {
    console.warn("[repair] count empty body failed:", error.message);
    return 0;
  }
  return (data ?? []).filter((row) =>
    isBodyEmpty(row.body_text as string | null, row.body_html as string | null)
  ).length;
}

const UID_DATE_WINDOW_FALLBACK_MAX_SCAN = 60;

async function resolveImapUidForEmail(
  client: ImapClient,
  messageId: string,
  mailboxId: string,
  receivedAt?: string | null,
  opts?: { allowDateWindowFallback?: boolean },
): Promise<number | null> {
  const synthetic = resolveUidFromSyntheticMessageId(messageId, mailboxId);
  if (synthetic != null) return synthetic;

  for (const candidate of buildMessageIdSearchCandidates(messageId)) {
    const uids = await client.searchByMessageId(candidate);
    if (uids.length > 0) return Math.max(...uids);
  }

  if (opts?.allowDateWindowFallback === false || !receivedAt) {
    return null;
  }

  const recv = new Date(receivedAt);
  if (Number.isNaN(recv.getTime())) return null;

  const since = new Date(recv);
  since.setUTCDate(since.getUTCDate() - 3);
  const until = new Date(recv);
  until.setUTCDate(until.getUTCDate() + 1);

  let uids: number[] = [];
  try {
    uids = await client.search(since);
  } catch (e) {
    console.warn("[resolveImapUid] date window search failed:", e);
    return null;
  }
  if (uids.length === 0) return null;

  const toScan = uids.length > UID_DATE_WINDOW_FALLBACK_MAX_SCAN
    ? uids.slice(-UID_DATE_WINDOW_FALLBACK_MAX_SCAN)
    : uids;

  for (const uid of [...toScan].reverse()) {
    try {
      const metaRaw = await client.fetchMetadata(uid);
      const mid = headerValue(metaRaw, "Message-ID");
      if (!messageIdMatchesHeader(messageId, mid)) continue;
      const dateHeader = headerValue(metaRaw, "Date");
      if (dateHeader) {
        const d = new Date(dateHeader);
        if (!Number.isNaN(d.getTime()) && (d < since || d > until)) continue;
      }
      console.log("[resolveImapUid] date-window fallback hit uid:", uid);
      return uid;
    } catch (metaErr) {
      console.warn("[resolveImapUid] fetchMetadata uid", uid, metaErr);
    }
  }
  return null;
}

/** 为单封已入库邮件从 IMAP 补拉正文（仅当当前正文仍为空时写入） */
async function repairOneEmailRecord(
  client: ImapClient,
  admin: ReturnType<typeof createClient>,
  mb: { id: string },
  row: EmailRepairRow,
  maxBytesNoAttach: number,
  maxBytesWithAttach: number,
  opts: RepairOneOptions = {},
): Promise<"repaired" | "still_empty" | "skip_not_empty" | "skip_no_uid" | "update_failed"> {
  if (!isBodyEmpty(row.body_text, row.body_html)) return "skip_not_empty";

  const messageId = String(row.message_id ?? "").trim();
  if (!messageId) return "skip_no_uid";

  const uid = await resolveImapUidForEmail(
    client,
    messageId,
    String(mb.id),
    row.received_at ?? null,
    { allowDateWindowFallback: !opts.lightweight },
  );
  if (uid == null) {
    console.log("[repair] no IMAP uid for message_id:", messageId.slice(0, 120));
    return "skip_no_uid";
  }

  const metaRaw = await client.fetchMetadata(uid);
  const rfc822SizeMatch = metaRaw.match(/RFC822\.SIZE\s+(\d+)/i);
  const rfc822Size = rfc822SizeMatch ? parseInt(rfc822SizeMatch[1], 10) || 0 : 0;
  const attachInfo = detectAttachments(metaRaw);
  const maxBytesForFetch = attachInfo.hasAttachment ? maxBytesWithAttach : maxBytesNoAttach;
  const readTimeout = opts.readTimeoutCapMs != null
    ? Math.min(
      imapFullBodyReadTimeoutMs(attachInfo.hasAttachment, rfc822Size),
      opts.readTimeoutCapMs,
    )
    : imapFullBodyReadTimeoutMs(attachInfo.hasAttachment, rfc822Size);

  let bodyText = "";
  let bodyHtml: string | null = null;
  let mimeAttachmentParts: Awaited<ReturnType<typeof parseFetchedMimeBody>>["mimeAttachmentParts"] = [];

  if (opts.lightweight || opts.forceTextOnly) {
    const textRaw = await client.fetchTextOnly(uid, Math.min(readTimeout, 10_000));
    if (textRaw) {
      const parsed = parseFetchedMimeBody(textRaw, false);
      bodyText = parsed.bodyText;
      bodyHtml = parsed.bodyHtml;
    }
  }

  if (isBodyEmpty(bodyText, bodyHtml) && !opts.forceTextOnly) {
    const bodyResult = await client.fetchFullBody(
      uid,
      rfc822Size,
      readTimeout,
      opts.lightweight ? Math.min(maxBytesForFetch, maxBytesNoAttach) : maxBytesForFetch,
    );
    const parsed = parseFetchedMimeBody(bodyResult.raw, bodyResult.isFull);
    bodyText = parsed.bodyText;
    bodyHtml = parsed.bodyHtml;
    mimeAttachmentParts = parsed.mimeAttachmentParts;
  }
  if (isBodyEmpty(bodyText, bodyHtml)) {
    console.log("[repair] still empty after fetch uid:", uid, "email_id:", row.id);
    return "still_empty";
  }

  const { data: stillEmpty } = await admin
    .from("emails")
    .select("body_text, body_html")
    .eq("id", row.id)
    .maybeSingle();
  if (!stillEmpty || !isBodyEmpty(stillEmpty.body_text, stillEmpty.body_html)) return "skip_not_empty";

  const updatePayload: Record<string, unknown> = {
    body_text: sanitizePostgresText(bodyText) ?? "",
    body_html: sanitizePostgresText(bodyHtml),
  };
  if (!opts.skipAttachments && mimeAttachmentParts.length > 0) {
    try {
      const attJson = await persistEmailAttachments(
        admin,
        String(mb.id),
        String(row.id),
        mimeAttachmentParts,
      );
      updatePayload.attachments = attJson;
      updatePayload.has_attachment = attJson.length > 0 || Boolean(row.has_attachment);
    } catch (attErr) {
      console.error("[repair attachments]", attErr);
    }
  }

  const { error: upErr } = await admin.from("emails").update(updatePayload).eq("id", row.id);
  if (upErr) {
    console.error("[repair update]", upErr);
    return "update_failed";
  }
  return "repaired";
}

async function connectImapClient(
  mb: any,
  opts: { connectTimeoutMs?: number; attempts?: number } = {},
): Promise<ImapClient> {
  const effectiveUseSsl = MAIL_LOCAL_TEST_MODE ? false : (mb.use_ssl !== false);
  const client = new ImapClient(mb.incoming_host, Number(mb.incoming_port), effectiveUseSsl);
  const attempts = Math.max(1, opts.attempts ?? 2);
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15000;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await client.connect(connectTimeoutMs);
      break;
    } catch (connErr) {
      try { (client as any).conn?.close(); } catch { /* ignore */ }
      try { (client as any).reader?.releaseLock(); } catch { /* ignore */ }
      if (attempt === attempts) throw connErr;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await client.login(mb.auth_user, mb.auth_password);
  await client.select("INBOX");
  return client;
}

/** 打开邮件时按需补拉单封正文（轻量限时；失败/超时入后台队列） */
async function repairEmailById(
  admin: ReturnType<typeof createClient>,
  emailId: string,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const emptyResult = (mailbox: string, extra: Partial<SyncResult> = {}): SyncResult => ({
    mailbox,
    fetched: 0,
    inserted: 0,
    total: 0,
    remaining: 0,
    email_id: emailId,
    mode: "repair_single",
    ...extra,
  });

  const { data: row, error: qErr } = await admin
    .from("emails")
    .select("id, message_id, body_text, body_html, has_attachment, mailbox_id, received_at, attachments")
    .eq("id", emailId)
    .maybeSingle();
  if (qErr) return emptyResult("", { error: qErr.message });
  if (!row?.mailbox_id) return emptyResult("", { error: "邮件不存在" });

  const { data: mb, error: mbErr } = await admin
    .from("mailboxes")
    .select("*")
    .eq("id", row.mailbox_id)
    .maybeSingle();
  if (mbErr || !mb) return emptyResult("", { error: mbErr?.message ?? "邮箱不存在" });

  const maxBytesNoAttach = parseEnvPositiveInt(
    "MAIL_SYNC_FULL_BODY_MAX_BYTES",
    DEFAULT_FULL_BODY_MAX_BYTES,
  );
  const maxBytesWithAttach = parseEnvPositiveInt(
    "MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES",
    DEFAULT_FULL_BODY_WITH_ATTACH_MAX_BYTES,
  );

  const overBudget = () => Date.now() - startedAt >= REPAIR_SINGLE_TIME_BUDGET_MS;

  if (!isBodyEmpty(row.body_text, row.body_html)) {
    if (row.has_attachment && attachmentsJsonNeedsBinarySync(row.attachments)) {
      if (placeholderSuggestsLargeMail(row.attachments)) {
        const enq = await enqueueAttachmentRepairTask(
          admin,
          emailId,
          "interactive_large_placeholder_attachment",
          "interactive",
        );
        return emptyResult(mb.email_address, {
          repaired: 0,
          queued: enq.enqueued,
          queue_reason: "large_placeholder_attachment",
          terminal: enq.terminal ?? !enq.enqueued,
          error: enq.enqueued ? undefined : "超大附件已入队，请稍后刷新",
        });
      }

      const prequeue = await enqueueAttachmentRepairTask(
        admin,
        emailId,
        "interactive_attachment_repair_prequeued",
        "interactive",
      );

      let client: ImapClient | null = null;
      try {
        if (overBudget()) {
          return emptyResult(mb.email_address, {
            repaired: 0,
            queued: prequeue.enqueued,
            queue_reason: "interactive_attachment_budget_before_connect",
          });
        }
        client = await connectImapClient(mb, { connectTimeoutMs: 6_000, attempts: 1 });
        if (overBudget()) {
          return emptyResult(mb.email_address, {
            repaired: 0,
            queued: prequeue.enqueued,
            queue_reason: "interactive_attachment_budget_after_connect",
          });
        }
        const attStatus = await repairAttachmentsForRecord(
          client,
          admin,
          mb,
          row as EmailAttachmentRepairRow,
          maxBytesNoAttach,
          maxBytesWithAttach,
          { interactive: true, rfc822MaxBytes: INTERACTIVE_ATTACHMENT_RFC822_MAX_BYTES },
        );
        if (attStatus === "repaired") {
          return emptyResult(mb.email_address, { repaired: 1, fetched: 1, total: 1 });
        }
        if (attStatus === "queued_large") {
          return emptyResult(mb.email_address, {
            repaired: 0,
            queued: prequeue.enqueued,
            queue_reason: "rfc822_size_exceeds_interactive_limit",
          });
        }
        return emptyResult(mb.email_address, {
          repaired: 0,
          queued: prequeue.enqueued,
          error: attStatus === "skip_no_uid" ? "无法在邮箱中定位该邮件" : "附件补拉未完成",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isWorkerCancelledError(e) || overBudget() || /timeout/i.test(msg)) {
          return emptyResult(mb.email_address, {
            repaired: 0,
            queued: prequeue.enqueued,
            queue_reason: isWorkerCancelledError(e) ? "worker_request_cancelled" : msg.slice(0, 200),
          });
        }
        return emptyResult(mb.email_address, { repaired: 0, error: msg, queued: prequeue.enqueued });
      } finally {
        if (client) await client.logout();
      }
    }
    return emptyResult(mb.email_address, { skipped: true, repaired: 0 });
  }

  const enqueueAndReturn = async (reason: string) => {
    const { enqueued, terminal } = await enqueueBodyRepairTask(admin, emailId, reason, "interactive");
    return emptyResult(mb.email_address, {
      repaired: 0,
      queued: enqueued,
      queue_reason: reason,
      terminal: terminal ?? !enqueued,
      error: enqueued ? undefined : (terminal ? friendlyRepairError(reason) : undefined),
    });
  };

  // 先入队，再做快速补拉。这样即使 Edge Runtime 在 IMAP 阶段取消请求，后台 worker 仍能继续补正文。
  const prequeue = await enqueueBodyRepairTask(admin, emailId, "quick_repair_prequeued", "interactive");
  if (!prequeue.enqueued) {
    const reason = prequeue.terminal ? "无法加入后台补拉队列" : "正文补拉入队失败";
    return emptyResult(mb.email_address, {
      repaired: 0,
      queued: false,
      terminal: prequeue.terminal ?? true,
      error: reason,
    });
  }

  let client: ImapClient | null = null;
  try {
    if (overBudget()) {
      return await enqueueAndReturn("quick_repair_budget_exceeded_before_connect");
    }
    client = await connectImapClient(mb, { connectTimeoutMs: 4_000, attempts: 1 });
    if (overBudget()) {
      return await enqueueAndReturn("quick_repair_budget_exceeded_after_connect");
    }
    const status = await repairOneEmailRecord(
      client,
      admin,
      mb,
      row as EmailRepairRow,
      maxBytesNoAttach,
      maxBytesWithAttach,
      {
        lightweight: true,
        readTimeoutCapMs: 8_000,
        skipAttachments: true,
      },
    );
    if (status === "repaired") {
      EdgeRuntime.waitUntil(
        finalizePostBodyRepair(admin, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, emailId)
          .catch((err) => console.error("[repair single post-process]", emailId, err)),
      );
      return emptyResult(mb.email_address, { repaired: 1, fetched: 1, total: 1 });
    }
    if (status === "skip_not_empty") {
      return emptyResult(mb.email_address, { skipped: true, repaired: 0 });
    }
    if (status === "skip_no_uid") {
      return await enqueueAndReturn("skip_no_uid_imap_search_miss");
    }
    if (status === "update_failed") {
      return await enqueueAndReturn("quick_repair_update_failed");
    }
    return await enqueueAndReturn(
      overBudget() ? "quick_repair_timeout_or_slow_imap" : "quick_repair_still_empty",
    );
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.error("[repair single]", emailId, raw);
    if (isWorkerCancelledError(e) || overBudget() || /timeout/i.test(raw)) {
      return await enqueueAndReturn(
        isWorkerCancelledError(e) ? "worker_request_cancelled" : raw,
      );
    }
    return await enqueueAndReturn(`quick_repair_error:${raw.slice(0, 200)}`);
  } finally {
    if (client) await client.logout();
  }
}

/** 后台 worker：完整补拉正文，成功后触发 process-email（after_body_repair） */
async function repairEmailByIdFull(
  admin: ReturnType<typeof createClient>,
  emailId: string,
  taskId?: string,
): Promise<SyncResult & { post_processed?: boolean }> {
  const emptyResult = (mailbox: string, extra: Partial<SyncResult> = {}): SyncResult => ({
    mailbox,
    fetched: 0,
    inserted: 0,
    total: 0,
    remaining: 0,
    email_id: emailId,
    mode: "repair_single",
    ...extra,
  });

  const { data: row, error: qErr } = await admin
    .from("emails")
    .select("id, message_id, body_text, body_html, has_attachment, mailbox_id, received_at, attachments")
    .eq("id", emailId)
    .maybeSingle();
  if (qErr) return emptyResult("", { error: qErr.message });
  if (!row?.mailbox_id) return emptyResult("", { error: "邮件不存在" });

  const { data: mb, error: mbErr } = await admin
    .from("mailboxes")
    .select("*")
    .eq("id", row.mailbox_id)
    .maybeSingle();
  if (mbErr || !mb) return emptyResult("", { error: mbErr?.message ?? "邮箱不存在" });

  const maxBytesNoAttach = parseEnvPositiveInt(
    "MAIL_SYNC_FULL_BODY_MAX_BYTES",
    DEFAULT_FULL_BODY_MAX_BYTES,
  );
  const maxBytesWithAttach = parseEnvPositiveInt(
    "MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES",
    DEFAULT_FULL_BODY_WITH_ATTACH_MAX_BYTES,
  );

  const needsAtt = attachmentsJsonNeedsBinarySync(row.attachments);

  if (!isBodyEmpty(row.body_text, row.body_html)) {
    if (needsAtt && row.has_attachment) {
      let client: ImapClient | null = null;
      try {
        client = await connectImapClient(mb, { connectTimeoutMs: 4_000, attempts: 1 });
        const attStatus = await repairAttachmentsForRecord(
          client,
          admin,
          mb,
          row as EmailAttachmentRepairRow,
          maxBytesNoAttach,
          maxBytesWithAttach,
        );
        if (attStatus === "repaired") {
          return {
            ...emptyResult(mb.email_address, { repaired: 1, fetched: 1, total: 1 }),
            post_processed: false,
          };
        }
      } catch (attErr) {
        console.error("[repair full] attachment-only", emailId, attErr);
      } finally {
        if (client) await client.logout();
      }
    }
    const post = await finalizePostBodyRepair(admin, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, emailId);
    return {
      ...emptyResult(mb.email_address, { skipped: true, repaired: 0 }),
      post_processed: post.ok,
    };
  }

  let client: ImapClient | null = null;
  try {
    await recordBodyRepairEvent(admin, emailId, "body_repair_started", "后台正文补拉开始", undefined, {
      task_id: taskId ?? null,
    });
    client = await connectImapClient(mb, { connectTimeoutMs: 4_000, attempts: 1 });
    const status = await repairOneEmailRecord(
      client,
      admin,
      mb,
      row as EmailRepairRow,
      maxBytesNoAttach,
      maxBytesWithAttach,
      {
        lightweight: false,
        forceTextOnly: true,
        readTimeoutCapMs: 12_000,
        skipAttachments: true,
      },
    );
    if (status === "repaired") {
      await admin.from("email_body_repair_tasks").update({
        status: "resolved",
        repaired_at: new Date().toISOString(),
        last_error: null,
      }).eq("email_id", emailId);
      await recordBodyRepairEvent(admin, emailId, "body_repair_succeeded", "后台正文补拉成功");
      const post = await finalizePostBodyRepair(admin, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, emailId);
      return {
        ...emptyResult(mb.email_address, { repaired: 1, fetched: 1, total: 1 }),
        post_processed: post.ok,
      };
    }
    if (status === "skip_not_empty") {
      return { ...emptyResult(mb.email_address, { skipped: true, repaired: 0 }), post_processed: false };
    }
    const errMsg = status === "still_empty"
      ? "IMAP 已拉取但未解析出正文"
      : status === "skip_no_uid"
        ? "skip_no_uid: 无法在邮箱中找到该邮件（Message-ID 未命中）"
        : "正文写入失败";
    return emptyResult(mb.email_address, { error: errMsg });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[repair full]", emailId, msg);
    return emptyResult(mb.email_address, { error: msg });
  } finally {
    if (client) await client.logout();
  }
}

/** 小批量为已入库但正文为空的历史邮件补拉 BODY.PEEK[] */
async function repairEmptyBodies(mb: any, admin: ReturnType<typeof createClient>): Promise<SyncResult> {
  const result: SyncResult = {
    mailbox: mb.email_address,
    fetched: 0,
    inserted: 0,
    total: 0,
    remaining: 0,
    repaired: 0,
    mode: "repair_body",
  };
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 40_000;
  let client: ImapClient | null = null;

  try {
    client = await connectImapClient(mb);

    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 30);
    const { data: candidates, error: qErr } = await admin
      .from("emails")
      .select("id, message_id, body_text, body_html, has_attachment, received_at")
      .eq("mailbox_id", mb.id)
      .gte("received_at", sinceDate.toISOString())
      .order("received_at", { ascending: false })
      .limit(REPAIR_BODY_SCAN_LIMIT);
    if (qErr) throw qErr;

    const toRepair = (candidates ?? []).filter((row) =>
      isBodyEmpty(row.body_text as string | null, row.body_html as string | null)
    ).slice(0, REPAIR_BODY_BATCH);
    result.total = toRepair.length;
    result.fetched = toRepair.length;

    const maxBytesNoAttach = parseEnvPositiveInt(
      "MAIL_SYNC_FULL_BODY_MAX_BYTES",
      DEFAULT_FULL_BODY_MAX_BYTES,
    );
    const maxBytesWithAttach = parseEnvPositiveInt(
      "MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES",
      DEFAULT_FULL_BODY_WITH_ATTACH_MAX_BYTES,
    );

    for (const row of toRepair) {
      if (Date.now() - startedAt > TIME_BUDGET_MS - 8000) {
        console.log("[repair] time budget low, stopping");
        break;
      }
      try {
        const status = await repairOneEmailRecord(
          client,
          admin,
          mb,
          row as EmailRepairRow,
          maxBytesNoAttach,
          maxBytesWithAttach,
        );
        if (status === "repaired") result.repaired = (result.repaired ?? 0) + 1;
      } catch (perErr) {
        console.error("[repair] email_id", row.id, perErr);
      }
    }

    const emptyRemaining = await countEmptyBodyEmails(admin, String(mb.id));
    result.empty_body_remaining = emptyRemaining;
    result.remaining = emptyRemaining;
    console.log(
      "[repair] done repaired:",
      result.repaired,
      "empty_body_remaining:",
      emptyRemaining,
    );
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error("[repair error]", mb.email_address, result.error);
    await admin.from("mailboxes").update({ last_error: result.error }).eq("id", mb.id);
  } finally {
    if (client) await client.logout();
  }
  return result;
}

type EmailAttachmentRepairRow = {
  id: string;
  message_id: string | null;
  received_at: string | null;
  attachments: unknown;
  has_attachment: boolean | null;
};

/** 为已入库但 attachments 仅为占位的邮件从 IMAP 补拉附件二进制 */
type RepairAttachmentsOptions = {
  interactive?: boolean;
  rfc822MaxBytes?: number;
};

async function repairAttachmentsForRecord(
  client: ImapClient,
  admin: ReturnType<typeof createClient>,
  mb: { id: string },
  row: EmailAttachmentRepairRow,
  maxBytesNoAttach: number,
  maxBytesWithAttach: number,
  opts: RepairAttachmentsOptions = {},
): Promise<"repaired" | "still_missing" | "skip_no_uid" | "queued_large"> {
  const messageId = String(row.message_id ?? "").trim();
  if (!messageId) return "skip_no_uid";

  const uid = await resolveImapUidForEmail(
    client,
    messageId,
    String(mb.id),
    row.received_at ?? null,
    { allowDateWindowFallback: true },
  );
  if (uid == null) {
    console.log("[repair-att] no IMAP uid for message_id:", messageId.slice(0, 120));
    return "skip_no_uid";
  }

  const metaRaw = await client.fetchMetadata(uid);
  const rfc822SizeMatch = metaRaw.match(/RFC822\.SIZE\s+(\d+)/i);
  const rfc822Size = rfc822SizeMatch ? parseInt(rfc822SizeMatch[1], 10) || 0 : 0;
  const attachInfo = detectAttachments(metaRaw);
  const maxBytesForFetch = attachInfo.hasAttachment ? maxBytesWithAttach : maxBytesNoAttach;

  if (
    opts.interactive &&
    opts.rfc822MaxBytes != null &&
    rfc822Size > opts.rfc822MaxBytes
  ) {
    console.log(
      "[repair-att] interactive skip large rfc822:",
      rfc822Size,
      "email_id:",
      row.id,
    );
    return "queued_large";
  }

  const bodyResult = await client.fetchFullBody(
    uid,
    rfc822Size,
    imapFullBodyReadTimeoutMs(attachInfo.hasAttachment, rfc822Size),
    maxBytesForFetch,
  );
  const parsed = parseFetchedMimeBody(bodyResult.raw, bodyResult.isFull, true);

  if (!bodyResult.isFull) {
    await admin.from("emails").update({
      attachments: [{
        count: attachInfo.count,
        note: "附件补拉时仅取得正文摘要，整封超过 MAIL_SYNC_FULL_BODY_* 上限或 FETCH 超时，附件仍未同步。",
      }] as unknown,
      has_attachment: true,
    }).eq("id", row.id);
    return "still_missing";
  }

  if (!parsed.mimeAttachmentParts.length) {
    if (attachInfo.hasAttachment) {
      await admin.from("emails").update({
        attachments: [{
          count: attachInfo.count,
          note: "IMAP 已标记附件，但补拉时未从 MIME 中解析出二进制。",
        }] as unknown,
        has_attachment: true,
      }).eq("id", row.id);
    }
    return "still_missing";
  }

  try {
    await admin.from("email_attachments").delete().eq("email_id", row.id);
    const attJson = await persistEmailAttachments(
      admin,
      String(mb.id),
      String(row.id),
      parsed.mimeAttachmentParts,
    );
    await admin.from("emails").update({
      attachments: attJson as unknown,
      has_attachment: attJson.length > 0 || attachInfo.hasAttachment,
    }).eq("id", row.id);
    return "repaired";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[repair-att]", row.id, e);
    await admin.from("emails").update({
      attachments: [{
        note: "附件补拉失败，请检查 Edge 日志与 Storage 策略。",
        error: msg.slice(0, 500),
      }] as unknown,
      has_attachment: true,
    }).eq("id", row.id);
    return "still_missing";
  }
}

async function countPlaceholderAttachmentEmails(
  admin: ReturnType<typeof createClient>,
  mailboxId: string,
): Promise<number> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - 30);
  const { data, error } = await admin
    .from("emails")
    .select("attachments")
    .eq("mailbox_id", mailboxId)
    .eq("has_attachment", true)
    .gte("received_at", sinceDate.toISOString())
    .limit(500);
  if (error) {
    console.warn("[repair-att] count failed:", error.message);
    return 0;
  }
  return (data ?? []).filter((row) => attachmentsJsonNeedsBinarySync(row.attachments)).length;
}

/** 小批量为占位附件邮件补拉 MIME 附件 */
async function repairMissingAttachments(mb: any, admin: ReturnType<typeof createClient>): Promise<SyncResult> {
  const result: SyncResult = {
    mailbox: mb.email_address,
    fetched: 0,
    inserted: 0,
    total: 0,
    remaining: 0,
    repaired: 0,
    mode: "repair_attachments",
  };
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 40_000;
  let client: ImapClient | null = null;

  try {
    client = await connectImapClient(mb);
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 30);
    const { data: candidates, error: qErr } = await admin
      .from("emails")
      .select("id, message_id, has_attachment, received_at, attachments")
      .eq("mailbox_id", mb.id)
      .eq("has_attachment", true)
      .gte("received_at", sinceDate.toISOString())
      .order("received_at", { ascending: false })
      .limit(REPAIR_ATTACH_SCAN_LIMIT);
    if (qErr) throw qErr;

    const toRepair = (candidates ?? []).filter((row) =>
      attachmentsJsonNeedsBinarySync(row.attachments)
    ).slice(0, REPAIR_ATTACH_BATCH);
    result.total = toRepair.length;
    result.fetched = toRepair.length;

    const maxBytesNoAttach = parseEnvPositiveInt(
      "MAIL_SYNC_FULL_BODY_MAX_BYTES",
      DEFAULT_FULL_BODY_MAX_BYTES,
    );
    const maxBytesWithAttach = parseEnvPositiveInt(
      "MAIL_SYNC_FULL_BODY_WITH_ATTACH_MAX_BYTES",
      DEFAULT_FULL_BODY_WITH_ATTACH_MAX_BYTES,
    );

    for (const row of toRepair) {
      if (Date.now() - startedAt > TIME_BUDGET_MS - 8000) {
        console.log("[repair-att] time budget low, stopping");
        break;
      }
      try {
        const status = await repairAttachmentsForRecord(
          client,
          admin,
          mb,
          row as EmailAttachmentRepairRow,
          maxBytesNoAttach,
          maxBytesWithAttach,
        );
        if (status === "repaired") result.repaired = (result.repaired ?? 0) + 1;
      } catch (perErr) {
        console.error("[repair-att] email_id", row.id, perErr);
      }
    }

    const remaining = await countPlaceholderAttachmentEmails(admin, String(mb.id));
    result.attachments_remaining = remaining;
    result.remaining = remaining;
    console.log("[repair-att] done repaired:", result.repaired, "remaining:", remaining);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    console.error("[repair-att error]", mb.email_address, result.error);
    await admin.from("mailboxes").update({ last_error: result.error }).eq("id", mb.id);
  } finally {
    if (client) await client.logout();
  }
  return result;
}

// ============ 同步逻辑 ============
async function syncOne(mb: any, admin: any, opts: SyncOptions = {}): Promise<SyncResult> {
  if (opts.repairEmptyBody) {
    return repairEmptyBodies(mb, admin);
  }
  if (opts.repairMissingAttachments) {
    return repairMissingAttachments(mb, admin);
  }

  const forceBulk = opts.forceBulk === true;
  const result: SyncResult = {
    mailbox: mb.email_address,
    fetched: 0,
    inserted: 0,
    total: 0,
    remaining: 0,
    mode: forceBulk ? "historical" : "incremental",
  };
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
    // - 增量同步：last_uid 是新邮件高水位，只拉取后续 UID。
    // - 历史同步：history_sync_cursor_uid 是从新到旧的独立游标，避免 3000+ 封历史邮件在一次请求里跑超时。
    const DAYS_BACK = 30;
    const PER_ROUND = 5;
    const MAX_ROUNDS = 2;
    const TIME_BUDGET_MS = 40_000; // 总时间预算 40s，给 Edge Runtime 留退出余量
    const startedAt = Date.now();

    let uids: number[] = [];
    const lastUid = parseOptionalUid(mb.last_uid) ?? 0;
    const isHistoricalBackfill = forceBulk;
    let historyCursorUid = parseOptionalUid(mb.history_sync_cursor_uid);
    if (isHistoricalBackfill) {
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - DAYS_BACK);
      uids = await client.searchSinceBeforeUid(sinceDate, historyCursorUid);
    } else if (lastUid > 0) {
      uids = await client.searchSinceUid(lastUid + 1);
    } else {
      uids = [];
    }
    uids.sort((a, b) => b - a); // 降序：最新邮件优先
    result.total = uids.length;
    console.log(
      "[sync] isHistoricalBackfill:",
      isHistoricalBackfill,
      "historyCursorUid:",
      historyCursorUid,
      "totalFound:",
      uids.length,
    );

    let progressUid = Math.max(lastUid, isHistoricalBackfill ? (uids[0] ?? 0) : lastUid);
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
      let roundLowestHandledUid: number | null = null;
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
            (attachmentsJsonNeedsBinarySync(existing.attachments) ||
              failedAttachmentEmailIds.has(existing.id));
          // 历史轻量同步：已存在且非占位附件则跳过；占位附件仍尝试补拉
          if (isHistoricalBackfill && !needsAttachmentRepair) {
            roundHandledUid = meta.uid;
            roundLowestHandledUid = roundLowestHandledUid == null ? meta.uid : Math.min(roundLowestHandledUid, meta.uid);
            continue;
          }

          if (!needsAttachmentRepair) {
            roundHandledUid = meta.uid;
            roundLowestHandledUid = roundLowestHandledUid == null ? meta.uid : Math.min(roundLowestHandledUid, meta.uid);
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
          roundLowestHandledUid = roundLowestHandledUid == null ? meta.uid : Math.min(roundLowestHandledUid, meta.uid);
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
          const bodyResult = isHistoricalBackfill
            ? { raw: "", isFull: false }
            : await client.fetchFullBody(
              meta.uid,
              rfc822Size,
              imapFullBodyReadTimeoutMs(attachInfo.hasAttachment, rfc822Size),
              maxBytesForFetch,
            );
          const parsedBody = parseFetchedMimeBody(bodyResult.raw, bodyResult.isFull);
          bodyText = parsedBody.bodyText;
          bodyHtml = parsedBody.bodyHtml;
          mimeAttachmentParts = parsedBody.mimeAttachmentParts;
          fullBodyFetched = bodyResult.isFull;
        } catch (bodyErr) {
          console.error(`[body uid ${meta.uid}]`, bodyErr);
        }

        const initialAttachments: Record<string, unknown>[] = !fullBodyFetched && attachInfo.hasAttachment
          ? [{
            count: attachInfo.count,
            note: isHistoricalBackfill
              ? "历史邮件轻量同步已检测到附件；为避免批量同步超时，未拉取正文和附件。"
              : "附件已检测到；仅拉取了正文摘要，附件未同步（整封超过 MAIL_SYNC_FULL_BODY_* 上限或 FETCH 超时时仅取 BODY[TEXT]）。",
          }]
          : [];

        const hasAttFlag = mimeAttachmentParts.length > 0 || attachInfo.hasAttachment;

        const ingestedAt = new Date().toISOString();
        const { data: insertedEmail, error: insErr } = await admin.from("emails").insert({
          mailbox_id: mb.id,
          message_id: sanitizePostgresText(meta.messageId) ?? meta.messageId,
          from_email: sanitizePostgresText(fromAddr.address ?? "unknown@unknown") ?? "unknown@unknown",
          from_name: sanitizePostgresText(decodeRfc2047(fromAddr.name)),
          to_email: sanitizePostgresText(toAddr.address ?? mb.email_address) ?? mb.email_address,
          subject: sanitizePostgresText(subject),
          body_text: sanitizePostgresText(bodyText) ?? "",
          body_html: sanitizePostgresText(bodyHtml),
          received_at: receivedAtFromDateHeader(messageDateHeader, ingestedAt),
          has_attachment: hasAttFlag,
          attachments: initialAttachments,
          missing_elements: [],
          status: "pending",
          is_read: false,
          idempotency_key: `sync:${mb.id}:${meta.messageId}`,
        }).select("id").single();
        if (insErr) {
          console.error("[insert err] uid:", meta.uid, "message_id:", meta.messageId.slice(0, 80), insErr);
          roundHandledUid = meta.uid;
          roundLowestHandledUid = roundLowestHandledUid == null
            ? meta.uid
            : Math.min(roundLowestHandledUid, meta.uid);
          continue;
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
        roundLowestHandledUid = roundLowestHandledUid == null ? meta.uid : Math.min(roundLowestHandledUid, meta.uid);
      }

      overallInserted += roundInserted;

      // 本轮进度标记
      const roundProgressUid = roundHandledUid > 0 ? roundHandledUid : roundMaxUid;
      if (roundProgressUid > progressUid) progressUid = roundProgressUid;
      if (isHistoricalBackfill && roundLowestHandledUid != null) {
        historyCursorUid = historyCursorUid == null
          ? roundLowestHandledUid
          : Math.min(historyCursorUid, roundLowestHandledUid);
      }
      const remainingAfterRound = isHistoricalBackfill
        ? countHistoricalRemaining(uids, historyCursorUid)
        : Math.max(0, uids.length - overallFetched);

      // 每轮结束后保存进度（确保中断时有部分进度）
      const updatePayload: Record<string, unknown> = {
        last_synced_at: new Date().toISOString(),
        last_error: null,
        last_uid: progressUid,
      };
      if (isHistoricalBackfill) {
        updatePayload.history_sync_cursor_uid = historyCursorUid;
        updatePayload.history_sync_completed_at = remainingAfterRound === 0 ? new Date().toISOString() : null;
      }
      await admin.from("mailboxes").update(updatePayload).eq("id", mb.id);

      // 每轮触发 AI 处理
      if (!isHistoricalBackfill && insertedEmailIds.length > 0) {
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

      // 时间不足则提前退出，剩余邮件下次手动同步继续
      if (Date.now() - startedAt > TIME_BUDGET_MS - 15000) {
        console.log("[sync] time budget nearly exhausted, stopping rounds");
        break;
      }
    }

    result.fetched = overallFetched;
    result.inserted = overallInserted;
    result.remaining = isHistoricalBackfill
      ? countHistoricalRemaining(uids, historyCursorUid)
      : Math.max(0, uids.length - overallFetched);
    console.log("[sync] all rounds done. fetched:", overallFetched, "inserted:", overallInserted, "total:", result.total, "remaining:", result.remaining, "progressUid:", progressUid);

    // 最终进度更新
    const finalUpdatePayload: Record<string, unknown> = {
      last_synced_at: new Date().toISOString(),
      last_error: null,
      last_uid: progressUid,
    };
    if (isHistoricalBackfill) {
      finalUpdatePayload.history_sync_cursor_uid = historyCursorUid;
      finalUpdatePayload.history_sync_completed_at = result.remaining === 0 ? new Date().toISOString() : null;
    }
    await admin.from("mailboxes").update(finalUpdatePayload).eq("id", mb.id);
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
    let repairEmailId: string | undefined;
    let repairFull = false;
    let repairTaskId: string | undefined;
    let queueAttachmentRepair = false;
    const syncOpts: SyncOptions = {};
    if (req.method === "POST") {
      try {
        const body = await req.json();
        mailboxId = body?.mailbox_id;
        syncOpts.forceBulk = body?.force_bulk === true;
        syncOpts.repairEmptyBody = body?.repair_empty_body === true;
        syncOpts.repairMissingAttachments = body?.repair_missing_attachments === true;
        repairEmailId = typeof body?.repair_email_id === "string"
          ? body.repair_email_id.trim()
          : undefined;
        repairFull = body?.repair_full === true;
        repairTaskId = typeof body?.repair_task_id === "string" ? body.repair_task_id.trim() : undefined;
        queueAttachmentRepair = body?.queue_attachment_repair === true;
      } catch { /* ignore */ }
    }

    if (repairEmailId) {
      const isWorkerCall = repairFull && isServiceRole;
      if (!isWorkerCall && manualUserId) {
        const actor: StaffActor = { userId: manualUserId, isService: false };
        await assertStaffCanAccessEmail(admin, actor, repairEmailId);
      }
      if (repairFull && !isWorkerCall) {
        return new Response(JSON.stringify({ error: "repair_full 仅允许服务角色" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (queueAttachmentRepair) {
        const enq = await enqueueAttachmentRepairTask(
          admin,
          repairEmailId,
          "interactive_attachment_repair_queue",
          "interactive",
        );
        return new Response(JSON.stringify({
          queued: enq.enqueued,
          task_id: enq.taskId,
          terminal: enq.terminal ?? false,
          results: [repairSingleShell("", { mode: "repair_single", queued: enq.enqueued })],
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const r = repairFull
        ? await repairEmailByIdFull(admin, repairEmailId, repairTaskId)
        : await repairEmailById(admin, repairEmailId);
      return new Response(JSON.stringify({ results: [r] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
        const r = await syncOne(mb, admin, syncOpts);
        results.push(r);
      }
      return new Response(JSON.stringify({ results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 全部邮箱同步（cron 自动）：异步后台执行
    EdgeRuntime.waitUntil((async () => {
      for (const mb of mailboxes) {
        await syncOne(mb, admin, {});
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
