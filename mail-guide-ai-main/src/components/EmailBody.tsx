import { cn } from "@/lib/utils";

/**
 * Decode HTML entities like &gt; &lt; &nbsp; &amp; to their text equivalents.
 * Uses the browser's built-in HTML parser for accurate decoding.
 */
function decodeHtmlEntities(text: string): string {
  if (!text) return "";
  const txt = document.createElement("textarea");
  txt.innerHTML = text;
  return txt.value;
}

/**
 * Check if the text looks like it contains HTML markup.
 */
function isHtmlContent(text: string): boolean {
  if (!text) return false;
  // Match opening HTML tags like <div>, <p>, <table>, <br>, etc.
  return /<(html|head|body|div|p|table|tr|td|th|span|a|br|img|ul|ol|li|h[1-6]|blockquote|strong|em|pre|code|hr|style|meta|font|center)[\s>]/i.test(
    text,
  );
}

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
  `;
  document.head.appendChild(el);
}

interface EmailBodyProps {
  /** Raw email body (may contain HTML or plain text with entities) */
  content: string | null | undefined;
  className?: string;
}

export function EmailBody({ content, className }: EmailBodyProps) {
  if (!content) {
    return (
      <div className={cn("text-sm text-muted-foreground italic", className)}>
        无正文内容
      </div>
    );
  }

  // If it looks like an HTML email, render it as HTML
  if (isHtmlContent(content)) {
    injectEmailStyles();
    return (
      <div
        className={cn(
          "email-body-html text-sm break-words overflow-hidden",
          className,
        )}
        dangerouslySetInnerHTML={{ __html: content }}
      />
    );
  }

  // Plain text email — decode HTML entities (like &gt; → >, &nbsp; → space)
  // and display with whitespace preserved
  const decoded = decodeHtmlEntities(content);

  return (
    <div
      className={cn(
        "text-sm whitespace-pre-wrap break-words overflow-hidden",
        className,
      )}
    >
      {decoded}
    </div>
  );
}
