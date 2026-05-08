import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Edit3, Eye } from "lucide-react";
import { toast } from "sonner";

const TRIGGER_LABELS: Record<string, string> = {
  missing_order_no: "缺少订单号",
  missing_image: "售后缺少图片",
  missing_product: "缺少产品名称",
  missing_any: "任意要素缺失（兜底）",
};

export default function TemplatesPage() {
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    trigger_type: "missing_order_no",
    subject_template: "",
    body_template: "",
    auto_send: false,
  });

  async function load() {
    const { data } = await supabase.from("reply_templates").select("*").order("created_at", { ascending: false });
    setList(data ?? []);
  }
  useEffect(() => { load(); }, []);

  async function save() {
    const payload = { ...form, variables: ["from_name", "from_email", "subject", "order_no", "missing_elements"], updated_by: null };
    const { error } = editingId
      ? await supabase.from("reply_templates").update(payload as any).eq("id", editingId)
      : await supabase.from("reply_templates").insert(payload as any);
    if (error) toast.error(error.message);
    else {
      toast.success(editingId ? "模板已更新" : "已保存");
      setOpen(false);
      setEditingId(null);
      setForm({ name: "", trigger_type: "missing_order_no", subject_template: "", body_template: "", auto_send: false });
      load();
    }
  }

  function editTemplate(t: any) {
    setEditingId(t.id);
    setForm({
      name: t.name ?? "",
      trigger_type: t.trigger_type ?? "missing_order_no",
      subject_template: t.subject_template ?? "",
      body_template: t.body_template ?? "",
      auto_send: !!t.auto_send,
    });
    setOpen(true);
  }

  function renderPreview(template: string) {
    return template
      .replaceAll("{{from_name}}", "Alice")
      .replaceAll("{{from_email}}", "alice@example.com")
      .replaceAll("{{subject}}", "Need help with my order")
      .replaceAll("{{order_no}}", "SO20260428001")
      .replaceAll("{{missing_elements}}", "order_no, image");
  }

  async function toggle(id: string, v: boolean) {
    await supabase.from("reply_templates").update({ is_active: v }).eq("id", id);
    load();
  }
  async function toggleAutoSend(id: string, v: boolean) {
    const { error } = await supabase.from("reply_templates").update({ auto_send: v } as any).eq("id", id);
    if (error) toast.error(error.message);
    else {
      toast.success(v ? "已开启自动发送" : "已关闭自动发送");
      load();
    }
  }
  async function remove(id: string) {
    if (!confirm("删除此模板？")) return;
    await supabase.from("reply_templates").delete().eq("id", id);
    load();
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">回复模板</h1>
          <p className="text-sm text-muted-foreground">
            用于要素缺失（无订单号、无图片等）场景。开启"自动发送"后，匹配此模板的邮件将直接通过 SMTP 发出；否则只生成草稿等待人工发送。
          </p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditingId(null); }}>
          <DialogTrigger asChild><Button><Plus className="w-4 h-4 mr-1" /> 新建模板</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editingId ? "编辑模板" : "新建模板"}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>模板名称</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div>
                <Label>触发类型</Label>
                <Select value={form.trigger_type} onValueChange={(v) => setForm({ ...form, trigger_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TRIGGER_LABELS).map(([k, v]) => (<SelectItem key={k} value={k}>{v}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div><Label>主题模板</Label><Input value={form.subject_template} onChange={(e) => setForm({ ...form, subject_template: e.target.value })} placeholder="支持 {{subject}} {{from_name}} 占位符" /></div>
              <div><Label>正文模板</Label><Textarea rows={8} value={form.body_template} onChange={(e) => setForm({ ...form, body_template: e.target.value })} placeholder="支持 {{from_name}} {{from_email}} {{subject}} 占位符" /></div>
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="text-sm font-medium">收到邮件后自动发送</div>
                  <div className="text-xs text-muted-foreground">建议仅对"信息补全类"开启（如缺订单号、缺图片）</div>
                </div>
                <Switch checked={form.auto_send} onCheckedChange={(v) => setForm({ ...form, auto_send: v })} />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setPreviewOpen(true)}><Eye className="w-4 h-4 mr-1" />变量预览</Button>
              <Button onClick={save}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3">
        {list.map((t) => (
          <Card key={t.id} className="p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="font-medium flex items-center gap-2">
                  {t.name}
                  <Badge variant="outline">{TRIGGER_LABELS[t.trigger_type] ?? t.trigger_type}</Badge>
                  {t.auto_send && <Badge>自动发送</Badge>}
                </div>
                {t.subject_template && <div className="text-sm text-muted-foreground mt-1">主题：{t.subject_template}</div>}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">启用</Label>
                  <Switch checked={t.is_active} onCheckedChange={(v) => toggle(t.id, v)} />
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">自动发送</Label>
                  <Switch checked={!!t.auto_send} onCheckedChange={(v) => toggleAutoSend(t.id, v)} />
                </div>
                <Button size="icon" variant="ghost" onClick={() => editTemplate(t)}><Edit3 className="w-4 h-4" /></Button>
                <Button size="icon" variant="ghost" onClick={() => remove(t.id)}><Trash2 className="w-4 h-4" /></Button>
              </div>
            </div>
            <pre className="text-xs bg-muted p-3 rounded whitespace-pre-wrap font-sans">{t.body_template}</pre>
          </Card>
        ))}
        {list.length === 0 && <Card className="p-8 text-center text-muted-foreground">暂无模板</Card>}
      </div>
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>变量预览</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground mb-1">主题</div>
              <div className="rounded bg-muted p-2">{renderPreview(form.subject_template || "Re: {{subject}}")}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">正文</div>
              <pre className="rounded bg-muted p-3 whitespace-pre-wrap font-sans text-xs">{renderPreview(form.body_template)}</pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
