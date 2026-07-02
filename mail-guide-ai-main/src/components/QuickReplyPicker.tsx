import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MessageSquare } from "lucide-react";
import { toast } from "sonner";
import {
  fetchActiveQuickReplyTemplates,
  groupQuickReplyTemplates,
  renderQuickReplyTemplate,
  type QuickReplyGroup,
  type QuickReplyTemplateContext,
  type QuickReplyTemplateRow,
} from "@/lib/quick-reply-templates";

export type QuickReplyPickerProps = {
  disabled?: boolean;
  context: QuickReplyTemplateContext;
  businessIntent?: string | null;
  onInsert: (payload: {
    body: string;
    subject?: string;
    templateId: string;
    mode: "append" | "replace";
  }) => void;
};

export default function QuickReplyPicker({
  disabled,
  context,
  businessIntent,
  onInsert,
}: QuickReplyPickerProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [groups, setGroups] = useState<QuickReplyGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<QuickReplyTemplateRow | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [alsoUpdateSubject, setAlsoUpdateSubject] = useState(false);

  useEffect(() => {
    if (!popoverOpen) return;
    let cancelled = false;
    setLoading(true);
    fetchActiveQuickReplyTemplates()
      .then((rows) => {
        if (!cancelled) setGroups(groupQuickReplyTemplates(rows, businessIntent));
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error("加载快捷回复失败", {
            description: e instanceof Error ? e.message : String(e),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [popoverOpen, businessIntent]);

  function pickTemplate(row: QuickReplyTemplateRow) {
    setPending(row);
    setAlsoUpdateSubject(!!row.subject_template?.trim());
    setConfirmOpen(true);
    setPopoverOpen(false);
  }

  function confirmInsert(mode: "append" | "replace") {
    if (!pending) return;
    const body = renderQuickReplyTemplate(pending.body_template, context);
    const subject =
      alsoUpdateSubject && pending.subject_template?.trim()
        ? renderQuickReplyTemplate(pending.subject_template, context)
        : undefined;
    onInsert({ body, subject, templateId: pending.id, mode });
    setConfirmOpen(false);
    setPending(null);
  }

  const previewBody = pending
    ? renderQuickReplyTemplate(pending.body_template, context)
    : "";

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled}>
            <MessageSquare className="w-4 h-4 mr-1" />
            快捷回复
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <div className="max-h-72 overflow-y-auto p-2">
            {loading ? (
              <p className="text-sm text-muted-foreground px-2 py-3">加载中…</p>
            ) : groups.length === 0 ? (
              <p className="text-sm text-muted-foreground px-2 py-3">暂无可用模板</p>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="mb-2 last:mb-0">
                  <div className="text-xs font-medium text-muted-foreground px-2 py-1">
                    {group.label}
                  </div>
                  {group.templates.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className="w-full text-left text-sm rounded-md px-2 py-1.5 hover:bg-muted"
                      onClick={() => pickTemplate(row)}
                    >
                      {row.title}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>插入快捷回复</DialogTitle>
            {pending ? (
              <p className="text-sm text-muted-foreground font-normal pt-1">
                模板：{pending.title}
              </p>
            ) : null}
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <pre className="rounded bg-muted p-3 whitespace-pre-wrap font-sans text-xs max-h-40 overflow-y-auto">
              {previewBody}
            </pre>
            {pending?.subject_template?.trim() ? (
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={alsoUpdateSubject}
                  onCheckedChange={(v) => setAlsoUpdateSubject(v === true)}
                />
                <Label className="text-sm font-normal cursor-pointer">同时更新邮件主题</Label>
              </label>
            ) : null}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button variant="secondary" onClick={() => confirmInsert("append")}>
              追加到正文
            </Button>
            <Button onClick={() => confirmInsert("replace")}>替换正文</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
