/** 剥离邮件引用区，供 AI 分类仅使用客户最新正文（与前端 email-body.ts 逻辑对齐） */



const EMAIL_HEADER_NAMES = [

  "From",

  "Sent",

  "Reply-To",

  "To",

  "Cc",

  "Bcc",

  "Subject",

  "Date",

  "Importance",

] as const;



function decodePlainTextEntities(text: string): string {

  if (!text) return "";

  return text

    .replace(/&nbsp;/gi, "\u00A0")

    .replace(/&amp;/gi, "&")

    .replace(/&lt;/gi, "<")

    .replace(/&gt;/gi, ">")

    .replace(/&quot;/gi, '"')

    .replace(/&#39;/g, "'")

    .replace(/&apos;/gi, "'");

}



/**

 * 入库/ IMAP 压扁纯文本恢复邮件头换行，再分割引用。

 * 与前端 `formatPlainTextEmailForDisplay` 核心规则对齐（见 src/lib/email-body.ts）。

 */

export function preparePlainBodyForQuoteSplit(text: string): string {

  let s = decodePlainTextEntities(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  if (!s.trim()) return "";



  const newlineCount = (s.match(/\n/g) ?? []).length;

  if (newlineCount >= 8) {

    return s.replace(/\t+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  }



  s = s.replace(/\t+/g, "\n").replace(/\u00a0/g, " ");



  for (const name of EMAIL_HEADER_NAMES) {

    s = s.replace(

      new RegExp(`(?<!\\n)(?<![\\n\\r])\\s{2,}(${name}\\s*[：:])`, "gi"),

      "\n\n$1",

    );

  }



  s = s.replace(/([ap]\.?\s*m\.?)(To\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(<[^>]+>)\s+(Sent\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(<[^>]+>)\s+(To\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(>)(Subject\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(>)(Sent\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(>)(To\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(>)(From\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(@[^\s>]+)\s+(Sent\s*[：:])/gi, "$1\n$2");



  s = s.replace(/(Subject\s*:[^\n]{0,240}?)(Dear\s+)/gi, "$1\n\n$2");

  s = s.replace(/(Subject\s*:[^\n]{0,240}?)(Greetings,)/gi, "$1\n\n$2");

  s = s.replace(/(Importance\s*:\s*High\s*)(Greetings,)/gi, "$1\n\n$2");

  s = s.replace(/(Importance\s*:\s*High\s*)(Dear\s+)/gi, "$1\n\n$2");



  s = s.replace(/\s*(Original\s*:\s*)/gi, "\n\n$1\n");

  s = s.replace(/\*+\s*(From\s*[：:])/gi, "\n$1");

  s = s.replace(/\*+\s*(Subject\s*[：:])/gi, "\n$1");

  s = s.replace(/(part)(Importance\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(\.com)\s+(Subject\s*[：:])/gi, "$1\n$2");

  s = s.replace(/(Service)(service@)/gi, "$1\n$2");



  s = s.replace(/[ \t]{2,}/g, " ");

  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();

}



export function splitPlainEmailTopAndQuoted(formatted: string): {

  top: string;

  quoted: string | null;

} {

  const gmailWrote = formatted.search(

    /\n\nOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[\s\S]{8,220}?wrote:\s*(?:\n|$)/i,

  );

  if (gmailWrote > 6) {

    return {

      top: formatted.slice(0, gmailWrote).trim(),

      quoted: formatted.slice(gmailWrote).trim(),

    };

  }

  const gmailWroteSingle = formatted.search(

    /\nOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[\s\S]{8,220}?wrote:\s*\n/i,

  );

  if (gmailWroteSingle > 6) {

    return {

      top: formatted.slice(0, gmailWroteSingle).trim(),

      quoted: formatted.slice(gmailWroteSingle).trim(),

    };

  }

  const idx = formatted.search(/\n\nFrom\s*[：:]/i);

  if (idx > 12) {

    return {

      top: formatted.slice(0, idx).trim(),

      quoted: formatted.slice(idx).trim(),

    };

  }

  return { top: formatted, quoted: null };

}



/** 分类/关键词用：主题 + 最新正文（不含引用历史） */

export function getAnalysisText(subject: string | null | undefined, bodyText: string | null | undefined): string {

  const sub = String(subject ?? "").trim();

  const body = String(bodyText ?? "").trim();

  const { top } = splitPlainEmailTopAndQuoted(preparePlainBodyForQuoteSplit(body));

  if (!sub && !top) return "";

  if (!sub) return top;

  if (!top) return sub;

  return `${sub}\n${top}`;

}



/** 客户最新正文片段（供 Dify body_latest） */

export function getLatestBodyText(bodyText: string | null | undefined): string {

  const body = String(bodyText ?? "").trim();

  if (!body) return "";

  return splitPlainEmailTopAndQuoted(preparePlainBodyForQuoteSplit(body)).top;

}

