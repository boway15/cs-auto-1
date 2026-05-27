import { cn } from "@/lib/utils";
import {
  formatPlainTextEmailForDisplay,
  looksLikeHtmlEmailContent,
  normalizeEmailBodyContent,
  pickRenderableEmailBody,
  plainTextEmailToDisplayHtml,
} from "@/lib/email-body";

// Styles injected once for email content rendering
let styleInjected = false;
function injectEmailStyles() {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const el = document.createElement("style");
  el.textContent = `
    .email-body-html table {
      border-collapse: collapse;
      max-width: 100%;
    }
    .email-body-html img {
      max-width: 100%;
      height: auto;
    }
    .email-body-html blockquote {
      border-left: 3px solid #d1d5db;
      margin: 0.5em 0;
      padding-left: 1em;
      color: #6b7280;
    }
    .email-body-html a {
      color: #2563eb;
      text-decoration: underline;
    }
    .email-body-html pre {
      white-space: pre-wrap;
      word-break: break-word;
      overflow-x: auto;
      max-width: 100%;
    }
    .email-body-html * {
      max-width: 100%;
      word-wrap: break-word;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .email-plain-main {
      line-height: 1.55;
    }
    .email-plain-quote {
      border-left: 3px solid #d1d5db;
      margin: 0.75em 0 0;
      padding: 0.25em 0 0.25em 1em;
      color: #4b5563;
      font-size: 0.95em;
      line-height: 1.5;
    }
    .email-body-html .gmail_quote,
    .email-body-html blockquote.gmail_quote {
      border-left: 1px solid #ccc;
      margin: 0.75em 0 0 0.8ex;
      padding-left: 1ex;
      color: #4b5563;
    }
    .email-body-html .gmail_attr {
      color: #6b7280;
      font-size: 0.85em;
      margin-bottom: 0.25em;
    }
    .email-body-html .gmail_signature {
      margin-top: 0.5em;
    }
  `;
  document.head.appendChild(el);
}

interface EmailBodyProps {
  /** 单字段正文（历史用法）；与 bodyText/bodyHtml 二选一 */
  content?: string | null | undefined;
  bodyText?: string | null;
  bodyHtml?: string | null;
  className?: string;
}

export function EmailBody({ content, bodyText, bodyHtml, className }: EmailBodyProps) {
  const normalized =
    bodyText !== undefined || bodyHtml !== undefined
      ? pickRenderableEmailBody(bodyText, bodyHtml)
      : (() => {
          const single = normalizeEmailBodyContent(content);
          return pickRenderableEmailBody(single.text, single.html);
        })();

  if (!normalized.text && !normalized.html) {
    return (
      <div className={cn("text-sm text-muted-foreground italic", className)}>
        无正文内容
      </div>
    );
  }

  const text = normalized.text;
  const htmlToRender =
    normalized.html && looksLikeHtmlEmailContent(normalized.html) ? normalized.html : null;

  if (htmlToRender) {
    injectEmailStyles();
    return (
      <div
        className={cn(
          "email-body-html text-sm break-words overflow-hidden",
          className,
        )}
        dangerouslySetInnerHTML={{ __html: htmlToRender }}
      />
    );
  }

  const formatted = formatPlainTextEmailForDisplay(text);
  const plainHtml = plainTextEmailToDisplayHtml(formatted);
  injectEmailStyles();
  return (
    <div
      className={cn(
        "email-body-html text-sm break-words overflow-hidden",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: plainHtml }}
    />
  );
}
