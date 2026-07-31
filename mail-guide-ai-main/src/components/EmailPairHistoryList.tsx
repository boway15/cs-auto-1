import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { EmailBody } from "@/components/EmailBody";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  buildPairConversationTimeline,
  isSendLogSuccess,
  sendTypeLabel,
  type WorkbenchSendLog,
} from "@/lib/workbench-send-logs";
import { formatDateTimeCST } from "@/lib/format-datetime";
import { cn } from "@/lib/utils";

type HistoryEmail = {
  id: string;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  status?: string;
  processing_status?: string;
  from_email?: string;
  from_name?: string | null;
};

type Props = {
  currentEmail: HistoryEmail | null;
  historyEmails: HistoryEmail[];
  sendLogs: WorkbenchSendLog[];
  loading?: boolean;
  decodeSubject: (s: string | null) => string | null;
  onSelectInbound: (emailId: string) => void;
};

function previewText(content: string | null | undefined, max = 160): string {
  const t = String(content ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "(无正文预览)";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 同发件人/收件人往来：入站（收）与已发（发）按时间混排。
 * 收 → 跳转对应邮件；发 → 弹出发送详情（对齐发送日志页）。
 */
export function EmailPairHistoryList({
  currentEmail,
  historyEmails,
  sendLogs,
  loading,
  decodeSubject,
  onSelectInbound,
}: Props) {
  const [detailLog, setDetailLog] = useState<WorkbenchSendLog | null>(null);
  const items = buildPairConversationTimeline({
    currentEmail,
    historyEmails,
    sendLogs,
  });
  const inboundCount = items.filter((i) => i.kind === "inbound").length;
  const outboundCount = items.filter((i) => i.kind === "outbound").length;

  // 切换邮件或重拉发送日志时关闭详情，避免沿用上一条的 from_email 等字段
  useEffect(() => {
    setDetailLog(null);
  }, [currentEmail?.id, sendLogs]);

  if (loading) {
    return <div className="text-xs text-muted-foreground">往来记录加载中...</div>;
  }

  if (items.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        暂无同一发件人与收件人的往来记录
      </div>
    );
  }

  return (
    <>
      <div className="space-y-2">
        <div className="text-[10px] text-muted-foreground px-0.5">
          收 {inboundCount} · 发 {outboundCount}（按时间，新→旧；点击「发」查看全文）
        </div>
        {items.map((item) => {
          if (item.kind === "inbound") {
            const { email, isCurrent } = item;
            return (
              <button
                key={item.id}
                type="button"
                disabled={isCurrent}
                onClick={() => {
                  if (!isCurrent) onSelectInbound(email.id);
                }}
                className={cn(
                  "w-full text-left rounded border p-3 transition-colors",
                  isCurrent
                    ? "border-primary/30 bg-primary/5 cursor-default"
                    : "hover:bg-accent",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                      <Badge variant="secondary" className="text-[10px] h-5 font-normal">
                        收
                      </Badge>
                      {isCurrent ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] h-5 font-normal border-primary/40 text-primary"
                        >
                          当前
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-sm font-medium truncate">
                      {decodeSubject(email.subject) || "(无主题)"}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      <EmailBody content={email.body_text} className="text-xs line-clamp-2" />
                    </div>
                  </div>
                  <div className="shrink-0 text-right space-y-1">
                    {email.status ? (
                      <StatusBadge status={email.status} processingStatus={email.processing_status} />
                    ) : null}
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(email.received_at).toLocaleString("zh-CN")}
                    </div>
                  </div>
                </div>
              </button>
            );
          }

          const { log } = item;
          const ok = isSendLogSuccess(log.status);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setDetailLog({ ...log })}
              className={cn(
                "w-full text-left rounded border p-3 transition-colors hover:bg-accent/60",
                ok ? "bg-primary/[0.03] border-primary/20" : "bg-destructive/5 border-destructive/30",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 mb-1">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] h-5 font-normal",
                        ok
                          ? "border-primary/40 text-primary"
                          : "border-destructive/40 text-destructive",
                      )}
                    >
                      发
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] h-5 font-normal">
                      {sendTypeLabel(log.send_type)}
                    </Badge>
                    {!ok ? (
                      <Badge variant="destructive" className="text-[10px] h-5 font-normal">
                        失败
                      </Badge>
                    ) : null}
                    <span className="text-[10px] text-muted-foreground">点击查看详情</span>
                  </div>
                  <div className="text-sm font-medium truncate">
                    {log.subject || "(无主题)"}
                  </div>
                  {log.from_email ? (
                    <div className="text-[10px] text-muted-foreground mt-0.5 truncate" title={log.from_email}>
                      发件：{log.from_email}
                    </div>
                  ) : null}
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">
                    {previewText(log.content)}
                  </div>
                  {!ok && log.error_message ? (
                    <p className="text-[10px] text-destructive mt-1 break-words line-clamp-2">
                      {log.error_message}
                    </p>
                  ) : null}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(log.created_at).toLocaleString("zh-CN")}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <Dialog open={!!detailLog} onOpenChange={(open) => !open && setDetailLog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>发送详情</DialogTitle>
          </DialogHeader>
          {detailLog && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-muted-foreground">发件人：</span>
                  {detailLog.from_email || "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">收件人：</span>
                  {detailLog.to_email}
                </div>
                <div>
                  <span className="text-muted-foreground">类型：</span>
                  {sendTypeLabel(detailLog.send_type)}
                </div>
                <div>
                  <span className="text-muted-foreground">状态：</span>
                  {isSendLogSuccess(detailLog.status) ? "成功" : "失败"}
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">时间：</span>
                  {formatDateTimeCST(detailLog.created_at)}
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">Message-ID：</span>
                  <span className="font-mono text-xs">{detailLog.message_id || "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">发送编号：</span>
                  {detailLog.send_no || "—"}
                </div>
                <div className="col-span-2">
                  <span className="text-muted-foreground">SMTP响应：</span>
                  {detailLog.smtp_response || "—"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">主题</div>
                <div className="p-2 bg-muted/50 rounded">{detailLog.subject || "(无主题)"}</div>
              </div>
              {detailLog.content ? (
                <div>
                  <div className="text-muted-foreground mb-1">正文</div>
                  <ScrollArea className="h-48">
                    <div className="p-2 bg-muted/50 rounded whitespace-pre-wrap text-xs">
                      {detailLog.content}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
              {detailLog.error_message ? (
                <div>
                  <div className="text-muted-foreground mb-1">错误</div>
                  <div className="p-2 bg-destructive/10 text-destructive rounded text-xs break-words">
                    {detailLog.error_message}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
