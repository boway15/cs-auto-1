import { useMemo } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import GithubSlugger from "github-slugger";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { BookOpen, List } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import guideMarkdown from "@/content/business-user-guide.md?raw";

function buildToc(md: string) {
  const slugger = new GithubSlugger();
  return md
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trimStart();
      return t.startsWith("## ") && !t.startsWith("### ");
    })
    .map((l) => {
      const title = l.trimStart().replace(/^## /, "").trim();
      return { id: slugger.slug(title), title };
    });
}

function scrollToHeading(id: string) {
  requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function DocLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  if (!href) {
    return <a {...rest}>{children}</a>;
  }
  if (/^https?:\/\//i.test(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline decoration-primary/30 underline-offset-4 transition-colors hover:decoration-primary"
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <span
      className="cursor-default border-b border-dotted border-muted-foreground/50 text-foreground/90"
      title="此链接指向仓库内文档，请联系管理员或 AI 产品经理获取副本。"
    >
      {children}
    </span>
  );
}

type MdProps = { children?: ReactNode; className?: string };

function MdH1({ children, id, className, ...rest }: ComponentPropsWithoutRef<"h1">) {
  return (
    <h1
      id={id}
      className={cn("mb-2 text-2xl font-semibold tracking-tight text-foreground", className)}
      {...rest}
    >
      {children}
    </h1>
  );
}

function MdH2({ children, id, className, ...rest }: ComponentPropsWithoutRef<"h2">) {
  return (
    <h2
      id={id}
      className={cn(
        "mb-4 mt-12 scroll-mt-28 border-b border-border pb-2 text-base font-semibold text-foreground first-of-type:mt-4",
        className,
      )}
      {...rest}
    >
      {children}
    </h2>
  );
}

function MdH3({ children, id, className, ...rest }: ComponentPropsWithoutRef<"h3">) {
  return (
    <h3 id={id} className={cn("mb-2 mt-8 text-sm font-semibold text-foreground", className)} {...rest}>
      {children}
    </h3>
  );
}

function MdP({ children }: MdProps) {
  return <p className="mb-4 text-[15px] leading-7 text-muted-foreground last:mb-0">{children}</p>;
}

function MdUl({ children }: MdProps) {
  return (
    <ul className="mb-4 space-y-2 pl-5 text-[15px] leading-7 text-muted-foreground marker:text-primary/55 [list-style-type:disc]">
      {children}
    </ul>
  );
}

function MdOl({ children }: MdProps) {
  return (
    <ol className="mb-4 space-y-2 pl-5 text-[15px] leading-7 text-muted-foreground marker:font-medium marker:text-foreground/75 [list-style-type:decimal]">
      {children}
    </ol>
  );
}

function MdLi({ children }: MdProps) {
  return <li className="leading-7 [&>p]:mb-0 [&>p]:mt-0">{children}</li>;
}

function MdStrong({ children }: MdProps) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

function MdHr() {
  return <hr className="my-10 border-0 border-t border-border" />;
}

function MdTable({ children }: MdProps) {
  return (
    <div className="my-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[280px] border-collapse text-left text-[13px]">{children}</table>
      </div>
    </div>
  );
}

function MdThead({ children }: MdProps) {
  return <thead className="bg-muted/60">{children}</thead>;
}

function MdTh({ children }: MdProps) {
  return (
    <th className="border-b border-border px-4 py-3 font-semibold text-foreground first:rounded-tl-xl last:rounded-tr-xl">
      {children}
    </th>
  );
}

function MdTd({ children }: MdProps) {
  return <td className="border-b border-border/60 px-4 py-3 align-top text-muted-foreground last:border-b-0">{children}</td>;
}

function MdTr({ children }: MdProps) {
  return <tr className="transition-colors hover:bg-muted/25">{children}</tr>;
}

function MdCode({ className, children }: MdProps & { inline?: boolean }) {
  const isBlock = Boolean(className?.startsWith("language-"));
  if (isBlock) {
    return (
      <code className="my-4 block overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
        {children}
      </code>
    );
  }
  return (
    <code className="rounded-md border border-border/80 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.8125rem] text-foreground/90">
      {children}
    </code>
  );
}

const markdownComponents = {
  a: DocLink,
  h1: MdH1,
  h2: MdH2,
  h3: MdH3,
  p: MdP,
  ul: MdUl,
  ol: MdOl,
  li: MdLi,
  strong: MdStrong,
  hr: MdHr,
  table: MdTable,
  thead: MdThead,
  tbody: ({ children }: MdProps) => <tbody>{children}</tbody>,
  tr: MdTr,
  th: MdTh,
  td: MdTd,
  code: MdCode,
};

export default function HelpCenter() {
  const tocItems = useMemo(() => buildToc(guideMarkdown), []);

  return (
    <div className="flex h-screen flex-col bg-gradient-to-b from-muted/40 via-background to-background">
      <header className="shrink-0 border-b border-border/80 bg-card/90 shadow-sm backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-start gap-3 px-4 py-4 sm:px-6">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/10">
            <BookOpen className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 pt-0.5">
            <h1 className="text-lg font-semibold leading-tight text-foreground">帮助中心</h1>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              面向日常客服与运营：登录与权限、邮件与订单关联、邮箱绑定、自动回复与拦截规则。配置或规则疑问请联系
              <span className="text-foreground/90">管理员</span> 或 <span className="text-foreground/90">AI 产品经理</span>。
            </p>
          </div>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)] lg:items-start lg:gap-10">
            <nav
              aria-label="本页导航"
              className="order-1 rounded-2xl border border-border/80 bg-card/70 p-4 shadow-sm ring-1 ring-border/25 lg:sticky lg:top-4 lg:order-none lg:self-start"
            >
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <List className="h-3.5 w-3.5 shrink-0" aria-hidden />
                本页导航
              </div>
              <ul className="space-y-0.5">
                {tocItems.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => scrollToHeading(item.id)}
                      className="w-full rounded-md px-2 py-1.5 text-left text-[13px] leading-snug text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {item.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>

            <article className="order-2 min-w-0 rounded-2xl border border-border/80 bg-card/50 px-5 py-8 shadow-sm ring-1 ring-border/30 sm:px-8 sm:py-10 lg:order-none">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSlug]}
                components={markdownComponents}
              >
                {guideMarkdown}
              </ReactMarkdown>
            </article>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
