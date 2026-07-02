import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { BUSINESS_INTENT_OPTIONS } from "@/lib/customerService";
import {
  renderQuickReplyTemplate,
  type QuickReplyScope,
  type QuickReplyTemplateContext,
  type QuickReplyTemplateRow,
} from "@/lib/quick-reply-templates";

const PREVIEW_CONTEXT: QuickReplyTemplateContext = {
  from_name: "Alice",
  from_email: "alice@example.com",
  subject: "Need help with my order",
  reply_to_email: "alice@example.com",
  order_no: "SO20260428001",
  missing_elements: "order_no, attachment",
};

type QuickReplyDraft = {
  id: string | null;
  title: string;
  body_template: string;
  subject_template: string;
  category: string;
  business_intents: string[];
  sort_order: number;
  is_active: boolean;
  scope: QuickReplyScope;
};

function emptyDraft(scope: QuickReplyScope): QuickReplyDraft {
  return {
    id: null,
    title: "",
    body_template: "",
    subject_template: "",
    category: "",
    business_intents: [],
    sort_order: 0,
    is_active: true,
    scope,
  };
}

function rowToDraft(row: QuickReplyTemplateRow): QuickReplyDraft {
  return {
    id: row.id,
    title: row.title,
    body_template: row.body_template,
    subject_template: row.subject_template ?? "",
    category: row.category ?? "",
    business_intents: row.business_intents ?? [],
    sort_order: row.sort_order,
    is_active: row.is_active,
    scope: row.scope,
  };
}

function toggleIntent(draft: QuickReplyDraft, value: string, checked: boolean): QuickReplyDraft {
  const next = new Set(draft.business_intents);
  if (checked) next.add(value);
  else next.delete(value);
  return { ...draft, business_intents: Array.from(next) };
}

type QuickReplyTemplatesTabProps = {
  isAdmin: boolean;
  userId: string;
};

export default function QuickReplyTemplatesTab({ isAdmin, userId }: QuickReplyTemplatesTabProps) {
  const [teamRows, setTeamRows] = useState<QuickReplyTemplateRow[]>([]);
  const [personalRows, setPersonalRows] = useState<QuickReplyTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<QuickReplyDraft>(() => emptyDraft("personal"));
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<{ title: string; subject: string; body: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("quick_reply_templates")
      .select("*")
      .order("sort_order", { ascending: true });
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    const rows = (data ?? []) as QuickReplyTemplateRow[];
    setTeamRows(rows.filter((r) => r.scope === "team"));
    setPersonalRows(rows.filter((r) => r.scope === "personal"));
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate(scope: QuickReplyScope) {
    setDraft(emptyDraft(scope));
    setDialogOpen(true);
  }

  function openEdit(row: QuickReplyTemplateRow) {
    setDraft(rowToDraft(row));
    setDialogOpen(true);
  }

  function openPreviewRow(row: QuickReplyTemplateRow) {
    setPreview({
      title: row.title,
      subject: row.subject_template
        ? renderQuickReplyTemplate(row.subject_template, PREVIEW_CONTEXT)
        : "",
      body: renderQuickReplyTemplate(row.body_template, PREVIEW_CONTEXT),
    });
  }

  async function saveDraft() {
    const title = draft.title.trim();
    const body = draft.body_template.trim();
    if (!title || !body) {
      toast.error("请填写标题和正文");
      return;
    }
    setSaving(true);
    const payload = {
      title,
      body_template: body,
      subject_template: draft.subject_template.trim() || null,
      category: draft.category.trim() || null,
      business_intents: draft.business_intents,
      sort_order: draft.sort_order,
      is_active: draft.is_active,
      scope: draft.scope,
      owner_id: draft.scope === "personal" ? userId : null,
    };

    if (draft.id) {
      const { error } = await supabase
        .from("quick_reply_templates")
        .update(payload)
        .eq("id", draft.id);
      if (error) toast.error(error.message);
      else {
        toast.success("已保存");
        setDialogOpen(false);
        await load();
      }
    } else {
      const { error } = await supabase.from("quick_reply_templates").insert(payload);
      if (error) toast.error(error.message);
      else {
        toast.success("已创建");
        setDialogOpen(false);
        await load();
      }
    }
    setSaving(false);
  }

  async function deleteRow(row: QuickReplyTemplateRow) {
    if (!window.confirm(`确定删除模板「${row.title}」？`)) return;
    const { error } = await supabase.from("quick_reply_templates").delete().eq("id", row.id);
    if (error) toast.error(error.message);
    else {
      toast.success("已删除");
      await load();
    }
  }

  function renderTable(
    rows: QuickReplyTemplateRow[],
    scope: QuickReplyScope,
    canEdit: boolean,
  ) {
    if (loading) {
      return <p className="text-sm text-muted-foreground py-4">加载中…</p>;
    }
    if (rows.length === 0) {
      return (
        <p className="text-sm text-muted-foreground py-4">
          {scope === "team" ? "暂无团队模板" : "暂无个人模板"}
        </p>
      );
    }

    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>标题</TableHead>
            <TableHead className="hidden sm:table-cell">分类</TableHead>
            <TableHead className="hidden md:table-cell">排序</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right w-[140px]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{row.title}</TableCell>
              <TableCell className="hidden sm:table-cell text-muted-foreground">
                {row.category ?? "—"}
              </TableCell>
              <TableCell className="hidden md:table-cell">{row.sort_order}</TableCell>
              <TableCell>
                {row.is_active ? (
                  <Badge variant="secondary">启用</Badge>
                ) : (
                  <Badge variant="outline">停用</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="icon" onClick={() => openPreviewRow(row)}>
                    <Eye className="w-4 h-4" />
                  </Button>
                  {canEdit && (
                    <>
                      <Button variant="ghost" size="icon" onClick={() => openEdit(row)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => deleteRow(row)}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  const dialogReadOnly = draft.scope === "team" && !isAdmin;

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="text-base font-semibold">团队模板</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isAdmin
                ? "全员可在工作台使用的标准话术，仅管理员可编辑。"
                : "以下为团队共享模板，仅可预览；个人模板请在下方管理。"}
            </p>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => openCreate("team")}>
              <Plus className="w-4 h-4 mr-1" />
              新建团队模板
            </Button>
          )}
        </div>
        {renderTable(teamRows, "team", isAdmin)}
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="text-base font-semibold">我的模板</h2>
            <p className="text-sm text-muted-foreground mt-0.5">仅您本人可见，可在工作台快捷插入。</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => openCreate("personal")}>
            <Plus className="w-4 h-4 mr-1" />
            新建个人模板
          </Button>
        </div>
        {renderTable(personalRows, "personal", true)}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {draft.id ? "编辑模板" : "新建模板"}
              <Badge variant="outline" className="ml-2">
                {draft.scope === "team" ? "团队" : "个人"}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <Label>标题</Label>
              <Input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="列表显示名称，如「催交订单号」"
              />
            </div>
            <div>
              <Label>分类（可选）</Label>
              <Input
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                placeholder="如：缺信息、物流"
              />
            </div>
            <div>
              <Label>主题模板（可选）</Label>
              <Input
                value={draft.subject_template}
                onChange={(e) => setDraft({ ...draft, subject_template: e.target.value })}
                placeholder="支持 {{subject}} {{from_name}} 等"
              />
            </div>
            <div>
              <Label>正文模板</Label>
              <Textarea
                rows={8}
                value={draft.body_template}
                onChange={(e) => setDraft({ ...draft, body_template: e.target.value })}
                placeholder="支持 {{from_name}} {{order_no}} {{missing_elements}} 等"
              />
            </div>
            <div>
              <Label>适用意图（可多选，用于工作台排序）</Label>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 border rounded-md p-3 max-h-40 overflow-y-auto">
                {BUSINESS_INTENT_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={draft.business_intents.includes(opt.value)}
                      onCheckedChange={(v) =>
                        setDraft(toggleIntent(draft, opt.value, v === true))
                      }
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <Label className="text-xs text-muted-foreground">排序</Label>
                <Input
                  type="number"
                  className="w-24 mt-1"
                  value={draft.sort_order}
                  onChange={(e) =>
                    setDraft({ ...draft, sort_order: Number(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="flex items-center gap-2 pt-5">
                <Switch
                  checked={draft.is_active}
                  onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
                />
                <Label className="text-xs text-muted-foreground">启用</Label>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => openPreviewRow({
                id: draft.id ?? "",
                title: draft.title,
                body_template: draft.body_template,
                subject_template: draft.subject_template || null,
                category: draft.category || null,
                business_intents: draft.business_intents,
                scope: draft.scope,
                owner_id: draft.scope === "personal" ? userId : null,
                sort_order: draft.sort_order,
                is_active: draft.is_active,
              })}
              variant="secondary"
            >
              <Eye className="w-4 h-4 mr-1" />
              预览
            </Button>
            <Button onClick={saveDraft} disabled={saving || dialogReadOnly}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>变量预览</DialogTitle>
            {preview?.title ? (
              <p className="text-sm text-muted-foreground font-normal pt-1">
                当前模板：{preview.title}
              </p>
            ) : null}
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {preview?.subject ? (
              <div>
                <div className="text-xs text-muted-foreground mb-1">主题</div>
                <div className="rounded bg-muted p-2">{preview.subject}</div>
              </div>
            ) : null}
            <div>
              <div className="text-xs text-muted-foreground mb-1">正文</div>
              <pre className="rounded bg-muted p-3 whitespace-pre-wrap font-sans text-xs">
                {preview?.body}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
