/**
 * 附件补拉（可在 Edge sync-mailbox 或 Docker Worker 调用）。
 * 默认每轮只拉少量 part 并续传，避免 Edge CPU/墙钟硬杀。
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { connectMailImapTls } from "./mail-tls-ca.ts";
import {
  buildMessageIdSearchCandidates,
  messageIdMatchesHeader,
} from "./imap-message-id.ts";
import { parseAttachmentPartSections, type AttachmentPartSection } from "./imap-bodystructure.ts";
import { decodeImapPartPayload, parseFullMime, type MimeAttachmentPart } from "./mime-parse.ts";
import { attachmentsJsonHasValidStoragePath } from "./email-attachment-repair-queue.ts";

type AdminClient = ReturnType<typeof createClient>;

export type AttachmentRepairByIdResult =
  | { status: "repaired"; storedCount: number }
  | { status: "partial"; storedCount: number; remainingParts: number }
  | { status: "skip_already_has"; storedCount: number }
  | { status: "skip_no_uid"; error: string }
  | { status: "still_missing"; error: string }
  | { status: "queued_large"; error: string }
  | { status: "failed"; error: string };

export type RepairAttachmentsByIdOptions = {
  /** 本轮最多拉几个尚未落库的 part；Edge 建议 1，Docker 可更大 */
  maxPartsPerInvoke?: number;
  /** 超过该 RFC822.SIZE 则跳过本轮（留给更大预算环境） */
  rfc822MaxBytes?: number;
};

type MailboxRow = {
  id: string;
  incoming_host: string;
  incoming_port: number | string;
  use_ssl?: boolean | null;
  auth_user: string;
  auth_password: string;
};

type EmailRow = {
  id: string;
  message_id: string | null;
  mailbox_id: string;
  received_at?: string | null;
  attachments?: unknown;
  has_attachment?: boolean | null;
};

function envPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const IMAP_CONNECT_TIMEOUT_MS = envPositiveInt("EMAIL_ATTACHMENT_REPAIR_IMAP_CONNECT_TIMEOUT_MS", 8_000);
const IMAP_COMMAND_TIMEOUT_MS = envPositiveInt("EMAIL_ATTACHMENT_REPAIR_IMAP_COMMAND_TIMEOUT_MS", 12_000);
const IMAP_LOGIN_TIMEOUT_MS = envPositiveInt("EMAIL_ATTACHMENT_REPAIR_IMAP_LOGIN_TIMEOUT_MS", 10_000);
const IMAP_SELECT_TIMEOUT_MS = envPositiveInt("EMAIL_ATTACHMENT_REPAIR_IMAP_SELECT_TIMEOUT_MS", 8_000);
const IMAP_SEARCH_TIMEOUT_MS = envPositiveInt("EMAIL_ATTACHMENT_REPAIR_IMAP_SEARCH_TIMEOUT_MS", 10_000);
const IMAP_FETCH_PART_TIMEOUT_MS = envPositiveInt("EMAIL_ATTACHMENT_REPAIR_IMAP_FETCH_PART_TIMEOUT_MS", 45_000);
const PART_MAX_BYTES = envPositiveInt("MAIL_SYNC_ATTACHMENT_PART_MAX_BYTES", 25_000_000);
const DEFAULT_RFC822_MAX = envPositiveInt("MAIL_SYNC_BATCH_ATTACHMENT_FETCH_MAX_BYTES", 28_000_000);
const DEFAULT_MAX_PARTS = envPositiveInt("MAIL_SYNC_ATTACHMENT_PARTS_PER_INVOKE", 1);
const UID_DATE_WINDOW_FALLBACK_MAX_SCAN = 40;

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

function sanitizeStorageFilename(name: string): string {
  const base = String(name || "attachment").replace(/[^\w.\-()+@]+/g, "_").slice(0, 120);
  return base || "attachment";
}

function filenameKey(name: string): string {
  return String(name || "").trim().toLowerCase();
}

export function listValidAttachmentMetas(attachments: unknown): Record<string, unknown>[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((a) => {
    if (!a || typeof a !== "object") return false;
    const o = a as Record<string, unknown>;
    const path = typeof o.storage_path === "string" ? o.storage_path.trim() : "";
    if (!path) return false;
    if (typeof o.size === "number" && o.size <= 0) return false;
    return true;
  }) as Record<string, unknown>[];
}

class ImapAttClient {
  private conn!: Deno.TlsConn;
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private tagCounter = 0;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(
    private host: string,
    private port: number,
    _useTls: boolean,
  ) {}

  async connect() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), IMAP_CONNECT_TIMEOUT_MS);
    try {
      this.conn = await connectMailImapTls(this.host, this.port, ac.signal, "[att-repair] ");
    } finally {
      clearTimeout(timer);
    }
    this.reader = this.conn.readable.getReader();
    await this.readUntil(/^\* (OK|PREAUTH|BYE)/m, IMAP_CONNECT_TIMEOUT_MS);
  }

  private async readUntil(re: RegExp, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (re.test(this.buffer)) return this.buffer;
      const remain = Math.max(deadline - Date.now(), 1);
      const readPromise = this.reader.read();
      const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remain));
      const result = await Promise.race([readPromise, timer]);
      if (result === "timeout") throw new Error(`IMAP read timeout after ${timeoutMs}ms`);
      if (result.value) this.buffer += this.decoder.decode(result.value);
      if (result.done) break;
    }
    if (!re.test(this.buffer)) throw new Error(`IMAP read timeout after ${timeoutMs}ms`);
    return this.buffer;
  }

  private async write(s: string) {
    await this.conn.write(this.encoder.encode(s));
  }

  private async command(cmd: string, timeoutMs = IMAP_COMMAND_TIMEOUT_MS) {
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} ${cmd}\r\n`);
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    const raw = await this.readUntil(re, timeoutMs);
    const m = raw.match(re)!;
    return { ok: m[1] === "OK", lines: raw.split(/\r?\n/), raw };
  }

  async login(user: string, pass: string) {
    await this.command(`ID ("name" "MailGuideAttRepair" "version" "1.0")`, 4_000).catch(() => null);
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
    await this.write(
      `${tag} UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID DATE)] RFC822.SIZE BODYSTRUCTURE)\r\n`,
    );
    const doneRe = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    return await this.readUntil(doneRe, IMAP_SEARCH_TIMEOUT_MS);
  }

  async fetchBodyPart(uid: number, section: string, timeoutMs = IMAP_FETCH_PART_TIMEOUT_MS): Promise<string | null> {
    const sec = section.trim();
    if (!sec) return null;
    const tag = `A${++this.tagCounter}`;
    this.buffer = "";
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[${sec}])\r\n`);
    const re = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`, "m");
    try {
      const raw = await this.readUntil(re, timeoutMs);
      return sliceImapLiteral(raw, `BODY[${sec}]`) ?? sliceImapLiteral(raw, `BODY.PEEK[${sec}]`);
    } catch (e) {
      console.log("[att-repair] fetchBodyPart failed", uid, sec, e);
      return null;
    }
  }

  async logout() {
    try { await this.command("LOGOUT", 2_000); } catch { /* ignore */ }
    try { this.reader?.releaseLock(); } catch { /* ignore */ }
    try { this.conn?.close(); } catch { /* ignore */ }
  }
}

async function resolveUid(
  client: ImapAttClient,
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

function decodePart(sec: AttachmentPartSection, rawPart: string): MimeAttachmentPart | null {
  const directBytes = decodeImapPartPayload(rawPart, sec.encoding);
  if (directBytes && directBytes.length > 0) {
    return {
      filename: sec.filename?.trim() || "attachment",
      contentType: sec.contentType || "application/octet-stream",
      bytes: directBytes,
      contentId: sec.contentId ?? null,
    };
  }
  const parsed = parseFullMime(rawPart, { attachmentsOnly: true, forceAttachment: true });
  for (const p of parsed.attachments) {
    if (p.bytes.length === 0) continue;
    return {
      ...p,
      contentId: p.contentId ?? sec.contentId ?? null,
      filename: sec.filename && (!p.filename || p.filename === "attachment")
        ? sec.filename
        : p.filename,
    };
  }
  return null;
}

async function persistParts(
  admin: AdminClient,
  mailboxId: string,
  emailId: string,
  parts: MimeAttachmentPart[],
  startIndex: number,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const bucket = "email-attachments";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.bytes?.length) continue;
    const ctMain = (p.contentType || "").split(";")[0].trim().toLowerCase();
    if (ctMain.startsWith("multipart/") || ctMain.startsWith("message/")) continue;
    const storagePath = `${mailboxId}/${emailId}/${startIndex + i}_${sanitizeStorageFilename(p.filename)}`;
    try {
      const blob = new Blob([p.bytes], { type: p.contentType || "application/octet-stream" });
      const { error: upErr } = await admin.storage.from(bucket).upload(storagePath, blob, {
        contentType: p.contentType || "application/octet-stream",
        upsert: true,
      });
      if (upErr) {
        out.push({
          filename: p.filename,
          contentType: p.contentType,
          size: p.bytes.length,
          storage_path: null,
          warning: upErr.message,
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
        ...(p.contentId ? { contentId: p.contentId } : {}),
      });
    } catch (e) {
      const warning = e instanceof Error ? e.message : String(e);
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

/** Docker Worker / Edge repair_full 共用：按轮拉取未落库附件 part */
export async function repairEmailAttachmentsById(
  admin: AdminClient,
  emailId: string,
  opts: RepairAttachmentsByIdOptions = {},
): Promise<AttachmentRepairByIdResult> {
  const maxParts = opts.maxPartsPerInvoke ?? DEFAULT_MAX_PARTS;
  const rfc822Max = opts.rfc822MaxBytes ?? DEFAULT_RFC822_MAX;

  const { data: email, error: emailErr } = await admin
    .from("emails")
    .select("id, message_id, mailbox_id, received_at, attachments, has_attachment")
    .eq("id", emailId)
    .maybeSingle<EmailRow>();
  if (emailErr) return { status: "failed", error: emailErr.message };
  if (!email) return { status: "failed", error: "邮件不存在" };

  const existing = listValidAttachmentMetas(email.attachments);
  if (attachmentsJsonHasValidStoragePath(email.attachments) && existing.length > 0) {
    // 可能仍缺 part：下面用 BODYSTRUCTURE 对一下
  }

  const messageId = String(email.message_id ?? "").trim();
  if (!messageId) return { status: "skip_no_uid", error: "skip_no_uid: 缺少 Message-ID" };

  const { data: mailbox, error: mbErr } = await admin
    .from("mailboxes")
    .select("id, incoming_host, incoming_port, use_ssl, auth_user, auth_password")
    .eq("id", email.mailbox_id)
    .maybeSingle<MailboxRow>();
  if (mbErr) return { status: "failed", error: mbErr.message };
  if (!mailbox) return { status: "failed", error: "邮箱不存在" };

  const client = new ImapAttClient(
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
      return { status: "skip_no_uid", error: "skip_no_uid: Message-ID 未命中" };
    }

    const metaRaw = await client.fetchMetadata(uid);
    const rfc822Size = parseInt(metaRaw.match(/RFC822\.SIZE\s+(\d+)/i)?.[1] ?? "0", 10) || 0;
    if (rfc822Size > rfc822Max) {
      return {
        status: "queued_large",
        error: `rfc822_size_exceeds_limit:${rfc822Size}`,
      };
    }

    const sections = parseAttachmentPartSections(metaRaw);
    const orderedUnique = [
      ...sections.filter((s) => s.kind === "user"),
      ...sections.filter((s) => s.kind === "inline"),
    ];

    const have = new Set(
      existing.map((o) => filenameKey(String(o.filename ?? ""))).filter(Boolean),
    );
    const pendingSecs = orderedUnique.filter((sec) => {
      if (sec.sizeBytes <= 0 || sec.sizeBytes > PART_MAX_BYTES) return false;
      const key = filenameKey(sec.filename || `part-${sec.section}`);
      return !have.has(key);
    });

    if (pendingSecs.length === 0) {
      if (existing.length > 0) {
        return { status: "skip_already_has", storedCount: existing.length };
      }
      return {
        status: "still_missing",
        error: "no_pending_attachment_parts",
      };
    }

    const batch = pendingSecs.slice(0, Math.max(1, maxParts));
    const mimeParts: MimeAttachmentPart[] = [];
    for (const sec of batch) {
      const rawPart = await client.fetchBodyPart(uid, sec.section);
      if (!rawPart?.trim()) continue;
      const decoded = decodePart(sec, rawPart);
      if (decoded) mimeParts.push(decoded);
    }

    if (mimeParts.length === 0) {
      return {
        status: "still_missing",
        error: "part_fetch_or_decode_failed_no_fullbody_fallback",
      };
    }

    const newMetas = await persistParts(
      admin,
      String(mailbox.id),
      emailId,
      mimeParts,
      existing.length,
    );
    const merged = [
      ...existing,
      ...newMetas.filter((m) => typeof m.storage_path === "string" && String(m.storage_path).trim()),
    ];
    const stillPendingKeys = new Set(
      pendingSecs.map((s) => filenameKey(s.filename || `part-${s.section}`)),
    );
    for (const m of merged) {
      stillPendingKeys.delete(filenameKey(String(m.filename ?? "")));
    }
    const remainingParts = stillPendingKeys.size;

    await admin.from("emails").update({
      attachments: merged as unknown,
      has_attachment: merged.length > 0 || email.has_attachment === true,
    }).eq("id", emailId);

    if (remainingParts > 0) {
      return {
        status: "partial",
        storedCount: merged.length,
        remainingParts,
      };
    }
    return { status: "repaired", storedCount: merged.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "failed", error: msg };
  } finally {
    await client.logout();
  }
}
