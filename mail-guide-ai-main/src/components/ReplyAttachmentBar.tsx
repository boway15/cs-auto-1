import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import {
  formatOutboundFileSize,
  OUTBOUND_MAX_FILE_BYTES,
  OUTBOUND_MAX_FILES,
  OUTBOUND_MAX_TOTAL_BYTES,
  type OutboundAttachmentDraft,
  uploadOutboundAttachment,
  validateOutboundFile,
} from "@/lib/outbound-attachments";

export type ReplyAttachmentBarProps = {
  disabled?: boolean;
  userId: string;
  sessionId: string;
  items: OutboundAttachmentDraft[];
  onChange: (items: OutboundAttachmentDraft[]) => void;
  /** toolbar：仅「添加附件」按钮；list：仅文件列表；full：全部 */
  layout?: "full" | "toolbar" | "list";
};

export default function ReplyAttachmentBar({
  disabled,
  userId,
  sessionId,
  items,
  onChange,
  layout = "full",
}: ReplyAttachmentBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const showToolbar = layout === "full" || layout === "toolbar";
  const showList = layout === "full" || layout === "list";
  const sizeHint = `单文件 ≤${OUTBOUND_MAX_FILE_BYTES / 1024 / 1024}MB，总计 ≤${OUTBOUND_MAX_TOTAL_BYTES / 1024 / 1024}MB，最多 ${OUTBOUND_MAX_FILES} 个`;

  async function handleFilesSelected(fileList: FileList | null) {
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    if (inputRef.current) inputRef.current.value = "";

    if (items.length >= OUTBOUND_MAX_FILES) {
      toast.error(`最多只能添加 ${OUTBOUND_MAX_FILES} 个附件`);
      return;
    }

    let currentTotal = items.reduce((sum, item) => sum + item.file.size, 0);
    const next = [...items];

    for (const file of files) {
      if (next.length >= OUTBOUND_MAX_FILES) {
        toast.error(`最多只能添加 ${OUTBOUND_MAX_FILES} 个附件`);
        break;
      }
      const validation = validateOutboundFile(file, currentTotal);
      if (!validation.ok) {
        toast.error(validation.reason);
        continue;
      }

      const draft: OutboundAttachmentDraft = {
        id: crypto.randomUUID(),
        file,
        uploading: true,
      };
      next.push(draft);
      onChange([...next]);
      currentTotal += file.size;

      try {
        const { storagePath } = await uploadOutboundAttachment(userId, sessionId, file);
        onChange(
          next.map((item) =>
            item.id === draft.id ? { ...item, uploading: false, storagePath } : item,
          ),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        onChange(
          next.map((item) =>
            item.id === draft.id ? { ...item, uploading: false, error: message } : item,
          ),
        );
        toast.error(`上传失败：${file.name}`, { description: message });
      }
    }
  }

  function removeItem(id: string) {
    onChange(items.filter((item) => item.id !== id));
  }

  return (
    <div className={layout === "toolbar" ? "contents" : "space-y-2"}>
      {showToolbar ? (
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            disabled={disabled}
            onChange={(e) => void handleFilesSelected(e.target.files)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || items.length >= OUTBOUND_MAX_FILES}
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip className="w-4 h-4 mr-1" />
            添加附件
          </Button>
          {layout === "full" ? (
            <span className="text-xs text-muted-foreground">{sizeHint}</span>
          ) : null}
        </>
      ) : null}
      {showList && items.length > 0 ? (
        <ul className="space-y-1">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2 text-xs rounded-md border px-2 py-1.5 bg-muted/30"
            >
              <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{item.file.name}</span>
              <span className="text-muted-foreground shrink-0">
                {formatOutboundFileSize(item.file.size)}
              </span>
              {item.uploading ? (
                <span className="text-muted-foreground shrink-0">上传中…</span>
              ) : item.error ? (
                <span className="text-destructive shrink-0">失败</span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                disabled={disabled || item.uploading}
                onClick={() => removeItem(item.id)}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
