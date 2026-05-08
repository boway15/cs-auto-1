// IMAP 收件 Edge Function（Deno 原生 TLS 实现，不依赖 Node 库）
// 实现最小 IMAP 子集：LOGIN / ID / SELECT / SEARCH / FETCH / LOGOUT
// 适配 Gmail / Outlook / 163 / QQ 等主流 IMAP 服务器
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

interface SyncResult {
  mailbox: string;
  fetched: number;
  inserted: number;
  total: number;
  remaining: number;
  error?: string;
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
  private conn!: Deno.TlsConn;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private buffer = "";
  private tagCounter = 0;

  constructor(private host: string, private port: number) {}

  async connect(timeoutMs = 15000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`IMAP connect timeout ${timeoutMs}ms`)), timeoutMs);
    try {
      this.conn = await Deno.connectTls({ hostname: this.host, port: this.port, signal: abort.signal });
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
  // 对 HTML-only 邮件也能正确提取；超过 500KB 的邮件回退到 BODY[TEXT]
  async fetchFullBody(uid: number, rfc822Size: number, timeoutMs = 10000): Promise<{ raw: string; isFull: boolean }> {
    // 大邮件只取 BODY[TEXT]，避免下载附件撑爆内存
    if (rfc822Size > 500_000) {
      const text = await this.fetchBodyTextFallback(uid, timeoutMs);
      return { raw: text, isFull: false };
    }
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[])\r\n`);
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    try {
      const raw = await this.readUntil(re, timeoutMs);
      const literalMatch = raw.match(/BODY\[\]\s*\{(\d+)\}\r?\n([\s\S]*?)(?=\r?\n\)|\r?\nA\d+ )/);
      if (literalMatch) {
        const size = Number(literalMatch[1]);
        const body = literalMatch[2].slice(0, size);
        console.log("[fetchFullBody] uid:", uid, "size:", body.length);
        return { raw: body, isFull: true };
      }
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
    const ok = raw.match(re)?.[1];
    const literalMatch = raw.match(/BODY\[TEXT\]\s*\{(\d+)\}\r?\n([\s\S]*?)(?=\r?\n\)|\r?\nA\d+ )/);
    if (literalMatch) {
      return literalMatch[2].slice(0, Number(literalMatch[1]));
    }
    const quotedMatch = raw.match(/BODY\[TEXT\]\s+"([^"]*?)"\s*\)/);
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
  if (angle) return { name: angle[1].replace(/^"|"$/g, "").trim() || null, address: angle[2].trim() };
  const plain = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? value.trim();
  return { name: null, address: plain };
}

// 从 MIME 正文中提取可读的纯文本，处理 base64 / quoted-printable 及 charset 转换
function extractTextFromMime(raw: string): string {
  if (!raw) return "";

  function decodePart(headers: string, body: string): string {
    const charset = headers.match(/charset=(["']?)([\w-]+)\1/i)?.[2] ?? "utf-8";
    const cte = (headers.match(/content-transfer-encoding:\s*(\S+)/i)?.[1] ?? "7bit").toLowerCase();
    let decoded: Uint8Array;
    try {
      if (cte === "base64") {
        const bin = atob(body.replace(/\s/g, ""));
        decoded = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
      } else if (cte === "quoted-printable") {
        const buf: number[] = [];
        for (let i = 0; i < body.length; i++) {
          if (body[i] === '=') {
            if (i + 2 < body.length) {
              if (body[i+1] === '\r' && body[i+2] === '\n') { i += 2; continue; } // 软换行
              if (body[i+1] === '\n') { i += 1; continue; }
              buf.push(parseInt(body.substring(i + 1, i + 3), 16));
              i += 2;
            }
          } else if (body[i] !== '\r' && body[i] !== '\n') {
            buf.push(body.charCodeAt(i));
          }
        }
        decoded = new Uint8Array(buf);
      } else {
        const enc = new TextEncoder();
        decoded = enc.encode(body);
      }
    } catch {
      decoded = new TextEncoder().encode(body);
    }
    try { return new TextDecoder(charset).decode(decoded); }
    catch { return new TextDecoder().decode(decoded); }
  }

  // 检查是否为 multipart（有 boundary）
  const boundaryMatch = raw.match(/^--([^\s\r\n]+)/m);
  if (boundaryMatch) {
    const esc = boundaryMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = raw.split(new RegExp(`\\r?\\n--${esc}`, 'g'));
    // 优先找 text/plain
    for (const part of parts) {
      if (/content-type:\s*text\/plain/i.test(part)) {
        const sep = part.search(/\r?\n\r?\n/);
        if (sep === -1) continue;
        const text = decodePart(part.substring(0, sep), part.substring(sep).trim());
        if (text.trim()) return text.trim();
      }
    }
    // 降级到 text/html
    for (const part of parts) {
      if (/content-type:\s*text\/html/i.test(part)) {
        const sep = part.search(/\r?\n\r?\n/);
        if (sep === -1) continue;
        const html = decodePart(part.substring(0, sep), part.substring(sep).trim());
        return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/["\n]{2,}/g, '\n').trim();
      }
    }
    return "";
  }

  // 非 multipart：判断是否有 MIME 头部
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd > 0 && headerEnd < 2000 && /content-type|content-transfer-encoding/i.test(raw.substring(0, headerEnd))) {
    return decodePart(raw.substring(0, headerEnd), raw.substring(headerEnd).trim());
  }
  return raw.trim();
}

// 从 MIME 正文中提取原始 HTML 内容（与 extractTextFromMime 类似但返回原始 HTML）
function extractHtmlFromMime(raw: string): string | null {
  if (!raw) return null;

  function decodePart(headers: string, body: string): string {
    const charset = headers.match(/charset=(["']?)([\w-]+)\1/i)?.[2] ?? "utf-8";
    const cte = (headers.match(/content-transfer-encoding:\s*(\S+)/i)?.[1] ?? "7bit").toLowerCase();
    let decoded: Uint8Array;
    try {
      if (cte === "base64") {
        const bin = atob(body.replace(/\s/g, ""));
        decoded = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
      } else if (cte === "quoted-printable") {
        const buf: number[] = [];
        for (let i = 0; i < body.length; i++) {
          if (body[i] === '=') {
            if (i + 2 < body.length) {
              if (body[i+1] === '\r' && body[i+2] === '\n') { i += 2; continue; }
              if (body[i+1] === '\n') { i += 1; continue; }
              buf.push(parseInt(body.substring(i + 1, i + 3), 16));
              i += 2;
            }
          } else if (body[i] !== '\r' && body[i] !== '\n') {
            buf.push(body.charCodeAt(i));
          }
        }
        decoded = new Uint8Array(buf);
      } else {
        const enc = new TextEncoder();
        decoded = enc.encode(body);
      }
    } catch {
      decoded = new TextEncoder().encode(body);
    }
    try { return new TextDecoder(charset).decode(decoded); }
    catch { return new TextDecoder().decode(decoded); }
  }

  // 检查是否为 multipart（有 boundary）
  const boundaryMatch = raw.match(/^--([^\s\r\n]+)/m);
  if (boundaryMatch) {
    const esc = boundaryMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = raw.split(new RegExp(`\\r?\\n--${esc}`, 'g'));
    // 找 text/html 部分
    for (const part of parts) {
      if (/content-type:\s*text\/html/i.test(part)) {
        const sep = part.search(/\r?\n\r?\n/);
        if (sep === -1) continue;
        const html = decodePart(part.substring(0, sep), part.substring(sep).trim());
        if (html.trim()) return html.trim();
      }
    }
    return null;
  }

  // 非 multipart：直接检查是否为 HTML
  if (/^\s*<(html|!DOCTYPE|head|body|div|p|table)/i.test(raw)) {
    return raw.trim();
  }
  // 检查是否有 MIME 头部且内容是 HTML
  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd > 0 && headerEnd < 2000 && /content-type:\s*text\/html/i.test(raw.substring(0, headerEnd))) {
    return decodePart(raw.substring(0, headerEnd), raw.substring(headerEnd).trim());
  }
  return null;
}

// 增强的附件检测：从 BODYSTRUCTURE 响应中检测附件
function detectAttachments(metaRaw: string): { hasAttachment: boolean; count: number } {
  // 检查 BODYSTRUCTURE 中的常见附件标记
  const bodyStructure = metaRaw.match(/BODYSTRUCTURE\s*\(([\s\S]+)\)\s*\)\s*$/m);
  if (!bodyStructure) return { hasAttachment: false, count: 0 };

  const structure = bodyStructure[1];
  let hasAttachment = false;
  let count = 0;

  // multipart/mixed 通常表示有附件
  if (/mixed/i.test(structure)) {
    hasAttachment = true;
  }

  // 查找 ATTACHMENT 或 INLINE 中的 filename/name 参数
  const attachMatches = structure.match(/"attachment"|"ATTACHMENT"|FILENAME\s*["\[]|NAME\s*["\[]/gi);
  if (attachMatches) {
    hasAttachment = true;
    count = attachMatches.length;
  }

  // 回退：从原始元数据中匹配
  if (!hasAttachment) {
    const fallback = /(ATTACHMENT|FILENAME|NAME)\s*=/i.test(metaRaw) ||
                     /"attachment"/i.test(metaRaw);
    if (fallback) {
      hasAttachment = true;
      // 尝试计数
      const fn = metaRaw.match(/FILENAME\s*=\s*["\[]?([^"\]\s)]+)/gi);
      count = fn?.length ?? 1;
    }
  }

  return { hasAttachment, count: Math.max(count, hasAttachment ? 1 : 0) };
}

// ============ 同步逻辑 ============
async function syncOne(mb: any, admin: any, forceBulk = false): Promise<SyncResult> {
  const result: SyncResult = { mailbox: mb.email_address, fetched: 0, inserted: 0, total: 0, remaining: 0 };
  const client = new ImapClient(mb.incoming_host, Number(mb.incoming_port));

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

      // --- Phase 2: 去重 ---
      const existingSet = new Set<string>();
      if (metaList.length > 0) {
        const messageIds = metaList.map(m => m.messageId);
        const CHUNK = 200;
        for (let i = 0; i < messageIds.length; i += CHUNK) {
          const chunk = messageIds.slice(i, i + CHUNK);
          const { data: existRows } = await admin
            .from("emails")
            .select("message_id")
            .in("message_id", chunk);
          for (const row of (existRows ?? [])) {
            existingSet.add(row.message_id);
          }
        }
      }
      console.log(`[sync] round ${round + 1} phase2: existing=${existingSet.size}`);

      // --- Phase 3: 下载正文 + 入库 ---
      let roundInserted = 0;
      let roundHandledUid = progressUid;
      const insertedEmailIds: string[] = [];
      for (const meta of metaList) {
        // 已存在 → 推进进度（DB 中已有，安全跨过）
        if (existingSet.has(meta.messageId)) {
          roundHandledUid = meta.uid;
          continue;
        }

        if (Date.now() - startedAt > TIME_BUDGET_MS - 5000) {
          console.log("[sync] time budget critical, stopping body download");
          break;
        }

        const fromAddr = parseAddress(headerValue(meta.raw, "From"));
        const toAddr = parseAddress(headerValue(meta.raw, "To"));
        const subject = decodeRfc2047(headerValue(meta.raw, "Subject"));
        // 业务时间与 SLA / 草稿窗口一致：使用 MIME Date 头；缺失则回退为同步入库时刻
        const messageDateHeader = headerValue(meta.raw, "Date");
        const rfc822Size = parseInt(headerValue(meta.raw, "RFC822.SIZE") ?? "0", 10) || 0;
        const attachInfo = detectAttachments(meta.raw);

        let bodyText = "";
        let bodyHtml: string | null = null;
        try {
          const { raw: rawBody, isFull } = await client.fetchFullBody(meta.uid, rfc822Size, 5000);
          if (rawBody) {
            if (isFull) {
              bodyText = extractTextFromMime(rawBody);
              bodyHtml = extractHtmlFromMime(rawBody);
            } else {
              bodyText = extractTextFromMime(rawBody);
            }
            if (bodyText.length > 50000) bodyText = bodyText.substring(0, 50000) + "\n\n[正文过长，已截断]";
            if (bodyHtml && bodyHtml.length > 100_000) bodyHtml = bodyHtml.substring(0, 100_000) + "\n\n[HTML 内容过长，已截断]";
          }
        } catch (bodyErr) {
          console.error(`[body uid ${meta.uid}]`, bodyErr);
        }

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
          has_attachment: attachInfo.hasAttachment,
          attachments: attachInfo.hasAttachment ? [{ count: attachInfo.count, note: "附件已检测到，完整下载将在后续后台任务中处理" }] : [],
          missing_elements: [],
          status: "pending",
          is_read: false,
          idempotency_key: `sync:${mb.id}:${meta.messageId}`,
        }).select("id").single();
        if (insErr) {
          console.error("[insert err]", insErr);
          break; // 入库失败则不继续本轮
        }
        if (insertedEmail?.id) insertedEmailIds.push(insertedEmail.id);
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
    // 鉴权：允许 (a) 服务角色（pg_cron 调用） 或 (b) 已登录的 admin/leader/agent 员工
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isServiceRole = token && token === SUPABASE_SERVICE_ROLE_KEY;

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
      // 必须是员工（admin/leader/agent）
      const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: isStaff } = await adminClient.rpc("is_staff", { _user_id: userData.user.id });
      if (!isStaff) {
        return new Response(JSON.stringify({ error: "权限不足" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let mailboxId: string | undefined;
    let forceBulk = false;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        mailboxId = body?.mailbox_id;
        forceBulk = body?.force_bulk === true;
      } catch { /* ignore */ }
    }

    const query = admin.from("mailboxes").select("*").eq("is_active", true);
    if (mailboxId) query.eq("id", mailboxId);
    const { data: mailboxes, error: mbErr } = await query;
    if (mbErr) throw mbErr;
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
