import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, FileWarning, Paperclip } from "lucide-react";
import {
  isOutboundImageAttachment,
  parseSendLogOutboundAttachments,
  signSendLogOutboundAttachmentUrls,
  type SendLogOutboundAttachment,
  type SignedOutboundAttachmentUrls,
} from "@/lib/outbound-attachments";

type Props = {
  metadata?: Record<string, unknown> | null;
};

/**
 * 发送日志详情：出站附件列表 / 图片预览 / 下载（发送日志页与工作台共用）。
 */
export function SendLogDetailAttachments({ metadata }: Props) {
  const [attachments, setAttachments] = useState<SendLogOutboundAttachment[]>([]);
  const [urls, setUrls] = useState<Array<SignedOutboundAttachmentUrls | null>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const atts = parseSendLogOutboundAttachments(metadata);
    setAttachments(atts);
    setUrls(atts.map(() => null));
    if (!atts.length) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const signed = await Promise.all(atts.map((a) => signSendLogOutboundAttachmentUrls(a)));
      if (!cancelled) {
        setUrls(signed);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metadata]);

  if (attachments.length === 0) return null;

  return (
    <div>
      <div className="text-muted-foreground mb-1 flex items-center gap-1">
        <Paperclip className="h-3.5 w-3.5" />
        发出附件（{attachments.length}）
      </div>
      {loading && (
        <div className="text-xs text-muted-foreground mb-2">正在加载附件链接…</div>
      )}
      <div className="space-y-2">
        {attachments.map((att, i) => {
          const signed = urls[i];
          const isImage = isOutboundImageAttachment(att);
          return (
            <div
              key={`${att.storage_path}-${i}`}
              className="rounded border border-border/60 bg-muted/30 p-2 text-xs space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate" title={att.filename}>
                    {att.filename}
                  </div>
                  <div className="text-muted-foreground truncate">{att.content_type}</div>
                </div>
                {signed?.downloadUrl ? (
                  <Button size="sm" variant="outline" className="h-7 shrink-0" asChild>
                    <a href={signed.downloadUrl} target="_blank" rel="noreferrer">
                      <Download className="h-3.5 w-3.5 mr-1" />
                      下载
                    </a>
                  </Button>
                ) : null}
              </div>
              {isImage && signed?.previewUrl ? (
                <a href={signed.previewUrl} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={signed.previewUrl}
                    alt={att.filename}
                    className="max-h-48 max-w-full rounded border border-border/50 object-contain bg-background"
                  />
                </a>
              ) : null}
              {signed?.error ? (
                <div className="flex items-center gap-1 text-muted-foreground">
                  <FileWarning className="h-3.5 w-3.5 shrink-0" />
                  <span>无法预览：文件已清理或无权访问</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
