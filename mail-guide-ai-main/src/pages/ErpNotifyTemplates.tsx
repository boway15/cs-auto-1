import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Eye } from "lucide-react";
import { toast } from "sonner";

const SCENES: { code: string; title: string; hint: string }[] = [
  { code: "risk_shopify", title: "Shopify 风控拦截通知", hint: "Shopify 系统提示的风控订单" },
  { code: "risk_payoneer", title: "Payoneer 风控拦截通知", hint: "Payoneer 邮件通知的风控订单" },
  { code: "risk_qty_ge_4", title: "购买数量≥4拦截通知", hint: "单订单购买数量 ≥ 4" },
];

type ErpTpl = {
  id: string;
  template_code: string;
  name: string;
  subject_template: string;
  body_template: string;
  sender_email: string | null;
  is_active: boolean;
};

function renderPreview(template: string, orderNo: string) {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => (key === "order_no" ? orderNo : ""));
}

export default function ErpNotifyTemplatesPage() {
  const [rows, setRows] = useState<ErpTpl[]>([]);
  const [mailboxes, setMailboxes] = useState<{ email_address: string }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ErpTpl>>({});
  const [preview, setPreview] = useState<{ title: string; subject: string; body: string } | null>(null);

  async function load() {
    const [{ data: tpls, error }, { data: mbs }] = await Promise.all([
      supabase.from("erp_notify_templates").select("*").order("template_code"),
      supabase.from("mailboxes").select("email_address").eq("is_active", true).order("email_address"),
    ]);
    if (error) {
      toast.error(error.message);
      return;
    }
    setMailboxes(mbs ?? []);
    const list = (tpls ?? []) as ErpTpl[];
    setRows(list);
    const map: Record<string, ErpTpl> = {};
    for (const r of list) map[r.template_code] = { ...r };
    setDrafts(map);
  }

  useEffect(() => {
    load();
  }, []);

  function updateDraft(code: string, patch: Partial<ErpTpl>) {
    setDrafts((d) => ({
      ...d,
      [code]: { ...d[code], ...patch },
    }));
  }

  async function saveOne(code: string) {
    const d = drafts[code];
    if (!d?.id) {
      toast.error("模板未加载");
      return;
    }
    if (!d.sender_email?.trim()) {
      toast.error("请选择发件邮箱");
      return;
    }
    const { error } = await supabase
      .from("erp_notify_templates")
      .update({
        subject_template: d.subject_template,
        body_template: d.body_template,
        sender_email: d.sender_email.trim(),
        is_active: d.is_active,
      })
      .eq("id", d.id);
    if (error) toast.error(error.message);
    else {
      toast.success("已保存");
      load();
    }
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">迅捷回邮模板</h1>
        <p className="text-sm text-muted-foreground mt-1">
          固定三种场景，供 ERP 调用 <code className="text-xs">erp-notify-customer</code> 发信。变量仅支持{" "}
          <code className="text-xs">{"{{order_no}}"}</code>。
        </p>
      </div>

      <div className="grid gap-4">
        {SCENES.map((scene) => {
          const d = drafts[scene.code];
          if (!d) {
            return (
              <Card key={scene.code} className="p-4 text-muted-foreground text-sm">
                {scene.title}：未找到模板记录，请执行数据库迁移。
              </Card>
            );
          }
          return (
            <Card key={scene.code} className="p-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium flex items-center gap-2">
                    {scene.title}
                    <Badge variant="outline" className="text-[10px] font-mono">{scene.code}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{scene.hint}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Label className="text-xs">启用</Label>
                  <Switch
                    checked={d.is_active}
                    onCheckedChange={(v) => updateDraft(scene.code, { is_active: v })}
                  />
                </div>
              </div>

              <div>
                <Label>发件邮箱（本场景专用）</Label>
                <Select
                  value={d.sender_email ?? ""}
                  onValueChange={(v) => updateDraft(scene.code, { sender_email: v })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="选择已配置 SMTP 的邮箱" />
                  </SelectTrigger>
                  <SelectContent>
                    {mailboxes.map((m) => (
                      <SelectItem key={m.email_address} value={m.email_address}>
                        {m.email_address}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>邮件主题</Label>
                <Input
                  className="mt-1"
                  value={d.subject_template}
                  onChange={(e) => updateDraft(scene.code, { subject_template: e.target.value })}
                />
              </div>

              <div>
                <Label>邮件正文</Label>
                <Textarea
                  className="mt-1 min-h-[140px] font-mono text-sm"
                  value={d.body_template}
                  onChange={(e) => updateDraft(scene.code, { body_template: e.target.value })}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPreview({
                      title: scene.title,
                      subject: renderPreview(d.subject_template, "SO20260428001"),
                      body: renderPreview(d.body_template, "SO20260428001"),
                    })
                  }
                >
                  <Eye className="w-4 h-4 mr-1" /> 预览
                </Button>
                <Button size="sm" onClick={() => saveOne(scene.code)}>
                  保存
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{preview?.title} — 预览</DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-muted-foreground">主题：</span>
                {preview.subject}
              </div>
              <pre className="whitespace-pre-wrap rounded border p-3 bg-muted/30 text-xs">{preview.body}</pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
