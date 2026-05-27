import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eye } from "lucide-react";
import { toast } from "sonner";

const SLOT_ORDER = "ar_missing_order";
const SLOT_ORDER_OR_ATT = "ar_missing_order_or_attachment";

/** 与迁移种子一致；保存时写回库，不在界面展示编辑 */
const SLOT_FIXED_DB_NAME: Record<string, string> = {
  [SLOT_ORDER]: "自动回复-缺失订单号",
  [SLOT_ORDER_OR_ATT]: "自动回复-缺失订单号或附件",
};

const BUSINESS_INTENT_OPTIONS: { value: string; label: string }[] = [
  { value: "order_cancel", label: "订单取消" },
  { value: "address_change", label: "订单改地址" },
  { value: "logistics", label: "物流问题" },
  { value: "damaged", label: "破损" },
  { value: "defect", label: "产品缺陷" },
  { value: "description_mismatch", label: "商品描述不符" },
  { value: "other", label: "其它" },
];

const FIRST_CONTACT_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "不限首封（不校验窗口，满足其它条件即可自动回复）" },
  { value: 3, label: "近 3 天首封" },
  { value: 7, label: "近 7 天首封" },
  { value: 15, label: "近 15 天首封" },
  { value: 30, label: "近 30 天首封（默认）" },
];

/** 与 `process-email` 中 `renderTemplate` 的 `values` 键一致；下方「预览用标量」仅用于本页弹窗示意。 */
const REPLY_TEMPLATE_PLACEHOLDER_REF: { key: string; desc: string; previewSample: string }[] = [
  { key: "from_name", desc: "发件人显示名；为空时发信端会退回为邮箱地址", previewSample: "Alice" },
  { key: "from_email", desc: "发件人邮箱", previewSample: "alice@example.com" },
  { key: "subject", desc: "客户邮件主题", previewSample: "Need help with my order" },
  { key: "order_no", desc: "解析到的订单号（可能为空）", previewSample: "SO20260428001" },
  { key: "missing_elements", desc: "缺失要素（英文键，与发信端 join 一致）", previewSample: "order_no, attachment" },
];

const REPLY_TEMPLATE_PREVIEW_VALUES: Record<string, string> = Object.fromEntries(
  REPLY_TEMPLATE_PLACEHOLDER_REF.map((r) => [r.key, r.previewSample]),
);

/** 与 Edge Function `renderTemplate` 相同规则：已知键替换为标量，未知键替换为空串。 */
function applyReplyTemplatePreview(template: string): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => REPLY_TEMPLATE_PREVIEW_VALUES[key] ?? "");
}

type SlotDraft = {
  id: string | null;
  trigger_type: string;
  subject_template: string;
  body_template: string;
  auto_send: boolean;
  auto_reply_first_contact_days: number;
  enabled_business_intents: string[];
};

function emptySlotDraft(trigger_type: string): SlotDraft {
  return {
    id: null,
    trigger_type,
    subject_template: "",
    body_template: "",
    auto_send: false,
    auto_reply_first_contact_days: 30,
    enabled_business_intents: [],
  };
}

function normalizeFirstContactDays(raw: unknown): number {
  if (typeof raw === "number" && FIRST_CONTACT_OPTIONS.some((o) => o.value === raw)) return raw;
  return 30;
}

function rowToDraft(row: any, fallback: SlotDraft): SlotDraft {
  const raw = row?.enabled_business_intents;
  const intents = Array.isArray(raw) ? (raw as string[]) : [];
  return {
    id: row?.id ?? null,
    trigger_type: row?.trigger_type ?? fallback.trigger_type,
    subject_template: row?.subject_template ?? "",
    body_template: row?.body_template ?? "",
    auto_send: !!row?.auto_send,
    auto_reply_first_contact_days: normalizeFirstContactDays(row?.auto_reply_first_contact_days),
    enabled_business_intents: intents,
  };
}

function toggleIntent(
  draft: SlotDraft,
  setDraft: (d: SlotDraft) => void,
  value: string,
  checked: boolean,
) {
  const next = new Set(draft.enabled_business_intents);
  if (checked) next.add(value);
  else next.delete(value);
  setDraft({ ...draft, enabled_business_intents: Array.from(next) });
}

function SlotEditor({
  title,
  description,
  draft,
  setDraft,
  onSave,
  onPreview,
}: {
  title: string;
  description: string;
  draft: SlotDraft;
  setDraft: (d: SlotDraft) => void;
  onSave: (draft: SlotDraft) => void;
  onPreview: (title: string, draft: SlotDraft) => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3">
        <div>
          <div className="font-medium flex items-center gap-2 flex-wrap">
            {title}
            <Badge variant="outline">{draft.trigger_type}</Badge>
            {draft.auto_send && <Badge>自动回复</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        </div>
        <div>
          <Label>适用意图（可多选）</Label>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 border rounded-md p-3">
            {BUSINESS_INTENT_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={draft.enabled_business_intents.includes(opt.value)}
                  onCheckedChange={(v) => toggleIntent(draft, setDraft, opt.value, v === true)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <Label>主题模板</Label>
          <Input
            value={draft.subject_template}
            onChange={(e) => setDraft({ ...draft, subject_template: e.target.value })}
            placeholder="支持 {{subject}} {{from_name}} 等占位符"
          />
        </div>
        <div>
          <Label>正文模板</Label>
          <Textarea
            rows={8}
            value={draft.body_template}
            onChange={(e) => setDraft({ ...draft, body_template: e.target.value })}
            placeholder="支持 {{from_name}} {{from_email}} {{subject}} {{order_no}} {{missing_elements}}"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-xs text-muted-foreground">自动回复</Label>
          <Switch checked={draft.auto_send} onCheckedChange={(v) => setDraft({ ...draft, auto_send: v })} />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <Label className="shrink-0 text-xs text-muted-foreground">首封窗口</Label>
          <Select
            value={String(draft.auto_reply_first_contact_days)}
            onValueChange={(v) => setDraft({ ...draft, auto_reply_first_contact_days: Number(v) })}
          >
            <SelectTrigger className="sm:max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" sideOffset={4}>
              {FIRST_CONTACT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground -mt-1">
          仅对本条模板生效：选定天数内同一发件人无其它邮件才视为首封；选「不限首封」则不做该校验（与 process-email 一致）。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPreview(title, draft)}
          >
            <Eye className="w-4 h-4 mr-1" />
            变量预览
          </Button>
          <Button size="sm" onClick={() => onSave(draft)} disabled={!draft.id}>
            保存本条
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function TemplatesPage() {
  const location = useLocation();
  const [slotOrder, setSlotOrder] = useState<SlotDraft>(() => emptySlotDraft(SLOT_ORDER));
  const [slotOrderOrAtt, setSlotOrderOrAtt] = useState<SlotDraft>(() => emptySlotDraft(SLOT_ORDER_OR_ATT));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBody, setPreviewBody] = useState({ subject: "", body: "" });
  const [previewSlotLabel, setPreviewSlotLabel] = useState("");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const hashScrollKeyRef = useRef<string | null>(null);

  async function load() {
    const { data: rows, error } = await supabase
      .from("reply_templates")
      .select("*")
      .in("trigger_type", [SLOT_ORDER, SLOT_ORDER_OR_ATT])
      .order("trigger_type", { ascending: true });
    if (error) console.warn("reply_templates:", error.message);
    const list = rows ?? [];
    const a = list.find((r) => r.trigger_type === SLOT_ORDER);
    const b = list.find((r) => r.trigger_type === SLOT_ORDER_OR_ATT);
    setSlotOrder(rowToDraft(a, emptySlotDraft(SLOT_ORDER)));
    setSlotOrderOrAtt(rowToDraft(b, emptySlotDraft(SLOT_ORDER_OR_ATT)));
    if (!a || !b) {
      toast.error("未找到双槽模板，请先执行数据库迁移（ar_missing_order / ar_missing_order_or_attachment）");
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (location.hash !== "#auto-reply-settings") {
      hashScrollKeyRef.current = null;
      return;
    }
    const scrollKey = `${location.pathname}${location.hash}`;
    if (hashScrollKeyRef.current === scrollKey) return;
    hashScrollKeyRef.current = scrollKey;
    const el = document.getElementById("auto-reply-settings");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [location.hash, location.pathname]);

  function intentsOverlap(a: string[], b: string[]): string[] {
    const setB = new Set(b);
    return a.filter((x) => setB.has(x));
  }

  async function saveSlot(draft: SlotDraft) {
    if (!draft.id) {
      toast.error("模板未加载，无法保存");
      return;
    }
    const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
    const other = draft.trigger_type === SLOT_ORDER ? slotOrderOrAtt : slotOrder;
    const overlap = intentsOverlap(draft.enabled_business_intents, other.enabled_business_intents);
    if (overlap.length > 0) {
      toast.error(`以下意图不能同时在两条模板中勾选：${overlap.join("、")}`);
      return;
    }
    const variables = ["from_name", "from_email", "subject", "order_no", "missing_elements"];
    const fixedName = SLOT_FIXED_DB_NAME[draft.trigger_type] ?? draft.trigger_type;
    const { error } = await supabase
      .from("reply_templates")
      .update({
        name: fixedName,
        subject_template: draft.subject_template,
        body_template: draft.body_template,
        is_active: draft.auto_send,
        auto_send: draft.auto_send,
        auto_reply_first_contact_days: draft.auto_reply_first_contact_days,
        enabled_business_intents: draft.enabled_business_intents,
        variables,
        updated_by: null,
      } as any)
      .eq("id", draft.id);
    if (error) toast.error(error.message);
    else {
      toast.success("已保存");
      await load();
      requestAnimationFrame(() => {
        if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = scrollTop;
      });
    }
  }

  function openPreview(title: string, draft: SlotDraft) {
    setPreviewSlotLabel(title);
    setPreviewBody({
      subject: applyReplyTemplatePreview(draft.subject_template || "Re: {{subject}}"),
      body: applyReplyTemplatePreview(draft.body_template),
    });
    setPreviewOpen(true);
  }

  return (
    <div ref={scrollContainerRef} className="p-6 h-full overflow-auto">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">自动回邮模板</h1>
        <p className="text-sm text-muted-foreground mt-1">
          系统固定两条自动回邮模板，不支持新建或删除。每条可单独配置首封窗口、主题/正文、适用意图及「自动回复」。
        </p>
      </div>

      <div id="auto-reply-settings" className="grid gap-4 scroll-mt-4">
        <SlotEditor
          title="模板一：缺失订单号"
          description="适用于取消订单、改地址、物流等仅需补充订单号的场景（以 process-email 判定为准）。"
          draft={slotOrder}
          setDraft={setSlotOrder}
          onSave={saveSlot}
          onPreview={openPreview}
        />
        <SlotEditor
          title="模板二：缺失订单号或附件"
          description="适用于破损、缺陷、描述不符等需单号或附件（或两者）的场景；一封内可同时说明。"
          draft={slotOrderOrAtt}
          setDraft={setSlotOrderOrAtt}
          onSave={saveSlot}
          onPreview={openPreview}
        />
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>变量预览</DialogTitle>
            {previewSlotLabel ? (
              <p className="text-sm text-muted-foreground font-normal pt-1">当前模板：{previewSlotLabel}</p>
            ) : null}
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div>
              <div className="text-xs font-medium text-foreground mb-2">支持的占位符与预览用标量</div>
              <p className="text-xs text-muted-foreground mb-2">
                占位符写法为 <code className="rounded bg-muted px-1">{"{{键名}}"}</code>
                ，与发信端替换规则一致；下表第二列为本弹窗替换时使用的固定样例，非模板正文的一部分。
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[28%]">占位符</TableHead>
                    <TableHead className="w-[32%]">预览标量</TableHead>
                    <TableHead>含义</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {REPLY_TEMPLATE_PLACEHOLDER_REF.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-mono text-xs align-top">{`{{${r.key}}}`}</TableCell>
                      <TableCell className="text-xs align-top">{r.previewSample}</TableCell>
                      <TableCell className="text-xs text-muted-foreground align-top">{r.desc}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="border-t pt-3 space-y-3">
              <div className="text-xs font-medium text-foreground">替换占位符后的主题 / 正文</div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">主题</div>
                <div className="rounded bg-muted p-2 text-sm">{previewBody.subject}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">正文</div>
                <pre className="rounded bg-muted p-3 whitespace-pre-wrap font-sans text-xs">{previewBody.body}</pre>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
