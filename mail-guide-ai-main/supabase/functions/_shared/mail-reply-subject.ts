/** 部分客户端无主题时会写入 "To: xxx@..." 占位主题，视为无有效主题。 */

function isPlaceholderSubject(subject: string): boolean {

  return /^To:\s*.+@.+\s*$/i.test(subject.trim());

}



/** 自动回复实际收件人（与 sendMail 的 to 一致；优先 Reply-To，否则 from_email）。 */

export function resolveAutoReplyRecipient(

  email: { from_email?: string | null; reply_to_email?: string | null },

  replyToEmail?: string | null,

): string {

  const explicit = String(replyToEmail ?? "").trim();

  if (explicit) return explicit;

  const stored = String(email.reply_to_email ?? "").trim();

  if (stored) return stored;

  return String(email.from_email ?? "").trim();

}



/** 回复主题基准：有主题用主题，无主题用自动回复收件人邮箱（便于线程识别）。 */

export function replySubjectBase(

  email: {

    subject?: string | null;

    from_email?: string | null;

  },

  replyToEmail?: string | null,

): string {

  const subject = String(email.subject ?? "").trim();

  if (subject && !isPlaceholderSubject(subject)) return subject;

  return resolveAutoReplyRecipient(email, replyToEmail);

}



/** 生成带 Re: 前缀的回复主题；已含 Re: 则不再重复添加。 */

export function formatReplySubject(base: string): string {

  const b = base.trim();

  if (!b) return "Re:";

  if (/^re:\s*/i.test(b)) return b;

  return `Re: ${b}`;

}



export function buildReplySubject(

  email: {

    subject?: string | null;

    from_email?: string | null;

  },

  replyToEmail?: string | null,

): string {

  return formatReplySubject(replySubjectBase(email, replyToEmail));

}


