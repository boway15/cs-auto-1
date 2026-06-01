import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { extractTextFromMime, hasReadableEmailBody, parseFullMime } from "./mime-parse.ts";
import { connectMailImapTls } from "./mail-tls-ca.ts";
import {
  buildMessageIdSearchCandidates,
  messageIdMatchesHeader,
} from "./imap-message-id.ts";

type AdminClient = ReturnType<typeof createClient>;

type MailboxRow = {
  id: string;
  incoming_host: string;
  incoming_port: number | string;
  use_ssl?: boolean | null;
  auth_user: string;
  auth_password: string;
  email_address?: string | null;
};

type EmailRow = {
  id: string;
  message_id: string | null;
  body_text?: string | null;
  body_html?: string | null;
  mailbox_id: string;
  received_at?: string | null;
};

type RepairResult =
  | { status: "repaired"; bodyTextLength: number; bodyHtmlLength: number }
  | { status: "skip_not_empty" }
  | { status: "skip_no_uid"; error: string }
  | { status: "still_empty"; error: string }
  | { status: "update_failed"; error: string };

const UID_DATE_WINDOW_FALLBACK_MAX_SCAN = 40;

function envPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const IMAP_CONNECT_TIMEOUT_MS = envPositiveInt("EMAIL_BODY_REPAIR_IMAP_CONNECT_TIMEOUT_MS", 4_000);
const IMAP_COMMAND_TIMEOUT_MS = envPositiveInt("EMAIL_BODY_REPAIR_IMAP_COMMAND_TIMEOUT_MS", 8_000);
const IMAP_LOGIN_TIMEOUT_MS = envPositiveInt("EMAIL_BODY_REPAIR_IMAP_LOGIN_TIMEOUT_MS", 6_000);
const IMAP_SELECT_TIMEOUT_MS = envPositiveInt("EMAIL_BODY_REPAIR_IMAP_SELECT_TIMEOUT_MS", 5_000);
const IMAP_SEARCH_TIMEOUT_MS = envPositiveInt("EMAIL_BODY_REPAIR_IMAP_SEARCH_TIMEOUT_MS", 6_000);
const IMAP_FETCH_TEXT_TIMEOUT_MS = envPositiveInt("EMAIL_BODY_REPAIR_IMAP_FETCH_TEXT_TIMEOUT_MS", 10_000);

function isBodyEmpty(bodyText: string | null | undefined, bodyHtml: string | null | undefined): boolean {
  return !hasReadableEmailBody(bodyText, bodyHtml);
}

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

function headerValue(raw: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[\\t ][^\\r\\n]*)*)`, "im");
  const value = raw.match(re)?.[1];
  return value ? value.replace(/\r?\n[\t ]+/g, " ").trim() : null;
}

type TextPartSection = {
  section: string;
  subtype: "plain" | "html" | "other";
};

function extractBodyStructure(raw: string): string | null {
  const idx = raw.toUpperCase().indexOf("BODYSTRUCTURE");
  if (idx < 0) return null;
  const start = raw.indexOf("(", idx);
  if (start < 0) return null;
  let depth = 0;
  let inQuote = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inQuote = false;
      }
      continue;
    }
    if (ch === "\"") {
      inQuote = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function tokenizeBodyStructure(input: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < input.length;) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === "\"") {
      i++;
      let value = "";
      while (i < input.length) {
        const c = input[i++];
        if (c === "\\") {
          value += input[i++] ?? "";
        } else if (c === "\"") {
          break;
        } else {
          value += c;
        }
      }
      tokens.push(value);
      continue;
    }
    let value = "";
    while (i < input.length && !/\s|\(|\)/.test(input[i])) {
      value += input[i++];
    }
    tokens.push(value);
  }
  return tokens;
}

function parseTextPartSections(raw: string): TextPartSection[] {
  const bodyStructure = extractBodyStructure(raw);
  if (!bodyStructure) return [];

  const tokens = tokenizeBodyStructure(bodyStructure);
  let index = 0;

  function skipRemainderOfCurrentList() {
    let nested = 0;
    while (index < tokens.length) {
      const token = tokens[index++];
      if (token === "(") nested++;
      else if (token === ")") {
        if (nested === 0) break;
        nested--;
      }
    }
  }

  function parsePart(path: string[]): TextPartSection[] {
    if (tokens[index] !== "(") return [];
    index++;

    const sections: TextPartSection[] = [];
    if (tokens[index] === "(") {
      let child = 1;
      while (tokens[index] === "(") {
        sections.push(...parsePart([...path, String(child)]));
        child++;
      }
      skipRemainderOfCurrentList();
      return sections;
    }

    const type = String(tokens[index++] ?? "").toLowerCase();
    const subtypeRaw = String(tokens[index++] ?? "").toLowerCase();
    skipRemainderOfCurrentList();

    if (type !== "text") return [];
    const subtype = subtypeRaw === "plain" || subtypeRaw === "html" ? subtypeRaw : "other";
    return [{ section: path.length > 0 ? path.join(".") : "TEXT", subtype }];
  }

  const sections = parsePart([]);
  return sections.sort((a, b) => {
    const rank = (s: TextPartSection) => s.subtype === "plain" ? 0 : s.subtype === "html" ? 1 : 2;
    return rank(a) - rank(b);
  });
}

function parseTextOnlyBody(rawBody: string): { bodyText: string; bodyHtml: string | null } {
  if (!rawBody.trim()) return { bodyText: "", bodyHtml: null };

  const parsed = parseFullMime(rawBody);
  let bodyText = parsed.bodyText;
  let bodyHtml = parsed.bodyHtml;

  if (isBodyEmpty(bodyText, bodyHtml)) {
    bodyText = extractTextFromMime(rawBody);
  }
  if (bodyText.length > 50_000) {
    bodyText = `${bodyText.substring(0, 50_000)}\n\n[正文过长，已截断]`;
  }
  if (bodyHtml && bodyHtml.length > 100_000) {
    bodyHtml = `${bodyHtml.substring(0, 100_000)}\n\n[HTML 内容过长，已截断]`;
  }
  return { bodyText, bodyHtml };
}

class ImapTextClient {
  private conn!: Deno.Conn | Deno.TlsConn;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder("iso-8859-1");
  private buffer = "";
  private tagCounter = 0;

  constructor(private host: string, private port: number, private useSsl = true) {}

  async connect(timeoutMs = IMAP_CONNECT_TIMEOUT_MS) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`IMAP connect timeout ${timeoutMs}ms`)), timeoutMs);
    try {
      this.conn = this.useSsl
        ? await connectMailImapTls(this.host, this.port, abort.signal, "[body-repair] ")
        : await Deno.connect({ hostname: this.host, port: this.port, transport: "tcp" });
    } finally {
      clearTimeout(timer);
    }
    this.reader = this.conn.readable.getReader();
    await this.readUntil(/^\* OK/m, timeoutMs);
  }

  private async readUntil(re: RegExp, timeoutMs = IMAP_COMMAND_TIMEOUT_MS): Promise<string> {
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

  private async command(cmd: string, timeoutMs = IMAP_COMMAND_TIMEOUT_MS): Promise<{ ok: boolean; lines: string[]; raw: string }> {
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} ${cmd}\r\n`);
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    const raw = await this.readUntil(re, timeoutMs);
    const m = raw.match(re)!;
    return { ok: m[1] === "OK", lines: raw.split(/\r?\n/), raw };
  }

  async login(user: string, pass: string) {
    await this.command(`ID ("name" "MailGuideBodyRepair" "version" "1.0")`, 4_000).catch(() => null);
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const r = await this.command(`LOGIN "${esc(user)}" "${esc(pass)}"`, IMAP_LOGIN_TIMEOUT_MS);
    if (!r.ok) throw new Error("IMAP LOGIN failed: " + r.raw.slice(-200));
  }

  async select(mailbox = "INBOX") {
    const r = await this.command(`SELECT "${mailbox}"`, IMAP_SELECT_TIMEOUT_MS);
    if (!r.ok) throw new Error("IMAP SELECT failed");
  }

  private parseSearchUids(lines: string[]): number[] {
    const all: number[] = [];
    for (const l of lines) {
      if (!l.startsWith("* SEARCH")) continue;
      all.push(...l.replace("* SEARCH", "").trim().split(/\s+/).filter(Boolean).map(Number));
    }
    return all.filter((n) => Number.isFinite(n) && n > 0);
  }

  async searchByMessageId(messageId: string): Promise<number[]> {
    const trimmed = messageId.trim();
    if (!trimmed) return [];
    const esc = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const r = await this.command(`UID SEARCH HEADER Message-ID "${esc}"`, IMAP_SEARCH_TIMEOUT_MS);
    if (!r.ok) return [];
    return this.parseSearchUids(r.lines);
  }

  async searchSince(sinceDate: Date): Promise<number[]> {
    const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const d = `${sinceDate.getUTCDate()}-${m[sinceDate.getUTCMonth()]}-${sinceDate.getUTCFullYear()}`;
    const r = await this.command(`UID SEARCH SINCE ${d}`, IMAP_SEARCH_TIMEOUT_MS);
    if (!r.ok) return [];
    return this.parseSearchUids(r.lines);
  }

  async fetchMetadata(uid: number): Promise<string> {
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID DATE)] RFC822.SIZE BODYSTRUCTURE)\r\n`);
    const doneRe = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    return await this.readUntil(doneRe, IMAP_SEARCH_TIMEOUT_MS);
  }

  async fetchBodyStructure(uid: number): Promise<string> {
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODYSTRUCTURE)\r\n`);
    const doneRe = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    return await this.readUntil(doneRe, IMAP_SEARCH_TIMEOUT_MS);
  }

  async fetchTextSection(uid: number, section: string): Promise<string> {
    if (section === "TEXT") return await this.fetchTextOnly(uid);
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[${section}.MIME] BODY.PEEK[${section}])\r\n`);
    const doneRe = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    const raw = await this.readUntil(doneRe, IMAP_FETCH_TEXT_TIMEOUT_MS);
    const mime =
      sliceImapLiteral(raw, `BODY[${section}.MIME]`) ??
      sliceImapLiteral(raw, `BODY.PEEK[${section}.MIME]`) ??
      "";
    const body =
      sliceImapLiteral(raw, `BODY[${section}]`) ??
      sliceImapLiteral(raw, `BODY.PEEK[${section}]`) ??
      "";
    return mime ? `${mime}\r\n${body}` : body;
  }

  async fetchTextOnly(uid: number): Promise<string> {
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[TEXT])\r\n`);
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    const raw = await this.readUntil(re, IMAP_FETCH_TEXT_TIMEOUT_MS);
    const body = sliceImapLiteral(raw, "BODY[TEXT]") ?? sliceImapLiteral(raw, "BODY.PEEK[TEXT]");
    if (body != null) return body;
    const quotedMatch = raw.match(/(?:BODY\[TEXT\]|BODY\.PEEK\[TEXT\])\s+"([^"]*?)"\s*\)/);
    return quotedMatch?.[1] ?? "";
  }

  async logout() {
    try { await this.command("LOGOUT", 2_000); } catch { /* ignore */ }
    try { this.reader?.releaseLock(); } catch { /* ignore */ }
    try { this.conn?.close(); } catch { /* ignore */ }
  }
}

async function resolveUid(
  client: ImapTextClient,
  messageId: string,
  receivedAt?: string | null,
): Promise<number | null> {
  for (const candidate of buildMessageIdSearchCandidates(messageId)) {
    const uids = await client.searchByMessageId(candidate);
    if (uids.length > 0) return Math.max(...uids);
  }

  if (!receivedAt) return null;
  const recv = new Date(receivedAt);
  if (Number.isNaN(recv.getTime())) return null;
  const since = new Date(recv);
  since.setUTCDate(since.getUTCDate() - 3);
  const until = new Date(recv);
  until.setUTCDate(until.getUTCDate() + 1);

  const uids = await client.searchSince(since);
  const toScan = uids.length > UID_DATE_WINDOW_FALLBACK_MAX_SCAN
    ? uids.slice(-UID_DATE_WINDOW_FALLBACK_MAX_SCAN)
    : uids;

  for (const uid of [...toScan].reverse()) {
    const metaRaw = await client.fetchMetadata(uid);
    const mid = headerValue(metaRaw, "Message-ID");
    if (!messageIdMatchesHeader(messageId, mid)) continue;
    const dateHeader = headerValue(metaRaw, "Date");
    if (dateHeader) {
      const d = new Date(dateHeader);
      if (!Number.isNaN(d.getTime()) && (d < since || d > until)) continue;
    }
    return uid;
  }
  return null;
}

export async function repairEmailBodyTextOnly(
  admin: AdminClient,
  emailId: string,
): Promise<RepairResult> {
  const { data: email, error: emailErr } = await admin
    .from("emails")
    .select("id, message_id, body_text, body_html, mailbox_id, received_at")
    .eq("id", emailId)
    .maybeSingle<EmailRow>();
  if (emailErr) return { status: "update_failed", error: emailErr.message };
  if (!email) return { status: "update_failed", error: "邮件不存在" };
  if (!isBodyEmpty(email.body_text, email.body_html)) return { status: "skip_not_empty" };

  const messageId = String(email.message_id ?? "").trim();
  if (!messageId) return { status: "skip_no_uid", error: "skip_no_uid: 邮件缺少 Message-ID" };

  const { data: mailbox, error: mbErr } = await admin
    .from("mailboxes")
    .select("id, incoming_host, incoming_port, use_ssl, auth_user, auth_password, email_address")
    .eq("id", email.mailbox_id)
    .maybeSingle<MailboxRow>();
  if (mbErr) return { status: "update_failed", error: mbErr.message };
  if (!mailbox) return { status: "update_failed", error: "邮箱不存在" };

  const client = new ImapTextClient(
    mailbox.incoming_host,
    Number(mailbox.incoming_port),
    mailbox.use_ssl !== false,
  );

  try {
    await client.connect();
    await client.login(mailbox.auth_user, mailbox.auth_password);
    await client.select("INBOX");

    const uid = await resolveUid(client, messageId, email.received_at);
    if (uid == null) {
      return {
        status: "skip_no_uid",
        error: "skip_no_uid: 无法在邮箱中找到该邮件（Message-ID 未命中）",
      };
    }

    const bodyStructureRaw = await client.fetchBodyStructure(uid).catch(() => "");
    const textSections = parseTextPartSections(bodyStructureRaw).slice(0, 6);

    let bodyText = "";
    let bodyHtml: string | null = null;
    if (textSections.length > 0) {
      for (const part of textSections) {
        const rawPart = await client.fetchTextSection(uid, part.section);
        const parsed = parseTextOnlyBody(rawPart);
        if (parsed.bodyText.trim()) {
          bodyText = bodyText ? `${bodyText}\n\n${parsed.bodyText}` : parsed.bodyText;
        }
        if (!bodyHtml && parsed.bodyHtml?.trim()) {
          bodyHtml = parsed.bodyHtml;
        }
      }
    } else {
      const raw = await client.fetchTextOnly(uid);
      const parsed = parseTextOnlyBody(raw);
      bodyText = parsed.bodyText;
      bodyHtml = parsed.bodyHtml;
    }

    if (isBodyEmpty(bodyText, bodyHtml)) {
      return { status: "still_empty", error: "IMAP 已拉取 TEXT 但未解析出正文" };
    }

    const { error: upErr } = await admin
      .from("emails")
      .update({ body_text: bodyText, body_html: bodyHtml })
      .eq("id", emailId);
    if (upErr) return { status: "update_failed", error: upErr.message };
    return {
      status: "repaired",
      bodyTextLength: bodyText.length,
      bodyHtmlLength: bodyHtml?.length ?? 0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "update_failed", error: msg };
  } finally {
    await client.logout();
  }
}
