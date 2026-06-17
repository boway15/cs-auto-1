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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

const SCENES: { code: string; title: string; hint: string }[] = [
  { code: "risk_shopify", title: "Shopify 风控拦截通知", hint: "Shopify 系统提示的风控订单" },
  { code: "risk_payoneer", title: "Payoneer 风控拦截通知", hint: "Payoneer 邮件通知的风控订单" },
  { code: "risk_qty_ge_4", title: "购买数量≥4拦截通知", hint: "单订单购买数量 ≥ 4" },
  { code: "po_box", title: "PO BOX 拦截通知", hint: "收件地址为 PO Box 需核实物理地址" },
];

type ErpTpl = {
  id: string;
  template_code: string;
  name: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
};

type SiteRow = {
  id: string;
  site_code: string;
  site_name: string;
  sender_email: string;
  is_active: boolean;
};

const PREVIEW_ORDER_NO = "SO20260428001";
const PREVIEW_ITEM_COUNT = 4;
const PREVIEW_SITE_CODE = "sedeta-us";
const PREVIEW_SITE_NAME = "SEDETA US Store";

function renderPreview(template: string) {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    if (key === "order_no") return PREVIEW_ORDER_NO;
    if (key === "item_count") return String(PREVIEW_ITEM_COUNT);
    if (key === "site_code") return PREVIEW_SITE_CODE;
    if (key === "site_name") return PREVIEW_SITE_NAME;
    return "";
  });
}

const emptySiteForm = (): Omit<SiteRow, "id"> & { id?: string } => ({
  site_code: "",
  site_name: "",
  sender_email: "",
  is_active: true,
});

export default function ErpNotifyTemplatesPage() {
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [mailboxes, setMailboxes] = useState<{ email_address: string }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ErpTpl>>({});
  const [preview, setPreview] = useState<{ title: string; subject: string; body: string } | null>(null);
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  const [siteForm, setSiteForm] = useState(emptySiteForm());
  const [siteSaving, setSiteSaving] = useState(false);

  async function load() {
    const [{ data: tpls, error }, { data: mbs }, { data: siteRows, error: siteErr }] = await Promise.all([
      supabase.from("erp_notify_templates").select("id, template_code, name, subject_template, body_template, is_active").order("template_code"),
      supabase.from("mailboxes").select("email_address").eq("is_active", true).order("email_address"),
      supabase.from("erp_site_mailboxes").select("*").order("site_code"),
    ]);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (siteErr) {
      toast.error(siteErr.message);
      return;
    }
    setMailboxes(mbs ?? []);
    setSites((siteRows ?? []) as SiteRow[]);
    const list = (tpls ?? []) as ErpTpl[];
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
    const { error } = await supabase
      .from("erp_notify_templates")
      .update({
        subject_template: d.subject_template,
        body_template: d.body_template,
        is_active: d.is_active,
      })
      .eq("id", d.id);
    if (error) toast.error(error.message);
    else {
      toast.success("已保存");
      load();
    }
  }

  function openSiteCreate() {
    setSiteForm(emptySiteForm());
    setSiteDialogOpen(true);
  }

  function openSiteEdit(row: SiteRow) {
    setSiteForm({ ...row });
    setSiteDialogOpen(true);
  }

  async function saveSite() {
    const code = siteForm.site_code.trim();
    const name = siteForm.site_name.trim();
    const email = siteForm.sender_email.trim();
    if (!code) {
      toast.error("请填写站点编码");
      return;
    }
    if (!email) {
      toast.error("请选择发件邮箱");
      return;
    }
    setSiteSaving(true);
    try {
      if (siteForm.id) {
        const { error } = await supabase
          .from("erp_site_mailboxes")
          .update({
            site_name: name,
            sender_email: email,
            is_active: siteForm.is_active,
          })
          .eq("id", siteForm.id);
        if (error) throw error;
        toast.success("站点已更新");
      } else {
        const { error } = await supabase.from("erp_site_mailboxes").insert({
          site_code: code,
          site_name: name,
          sender_email: email,
          is_active: siteForm.is_active,
        });
        if (error) throw error;
        toast.success("站点已添加");
      }
      setSiteDialogOpen(false);
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("duplicate") || msg.includes("unique")) {
        toast.error("站点编码已存在");
      } else {
        toast.error(msg);
      }
    } finally {
      setSiteSaving(false);
    }
  }

  async function deleteSite(row: SiteRow) {
    if (!confirm(`确定删除站点「${row.site_code}」？删除后 ERP 传入该 site_code 将返回 422。`)) return;
    const { error } = await supabase.from("erp_site_mailboxes").delete().eq("id", row.id);
    if (error) toast.error(error.message);
    else {
      toast.success("已删除");
      load();
    }
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">迅捷回邮模板</h1>
        <p className="text-sm text-muted-foreground mt-1">
          ERP 调用 <code className="text-xs">erp-notify-customer</code> 时须传{" "}
          <code className="text-xs">site_code</code>，发件邮箱由下方「站点邮箱关联」决定。模板变量：{" "}
          <code className="text-xs">{"{{order_no}}"}</code>、<code className="text-xs">{"{{item_count}}"}</code>、
          <code className="text-xs">{"{{site_code}}"}</code>、<code className="text-xs">{"{{site_name}}"}</code>
          （<code className="text-xs">item_count</code> 为订单购买总件数，ERP 必传正整数）。
        </p>
      </div>

      <Card className="p-4 mb-6 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-medium">站点邮箱关联</h2>
            <p className="text-xs text-muted-foreground mt-1">
              一个站点对应一个发件邮箱；邮箱须在「邮箱配置」中已启用并完成 SMTP。
            </p>
          </div>
          <Button size="sm" onClick={openSiteCreate}>
            <Plus className="w-4 h-4 mr-1" /> 新增站点
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>站点编码</TableHead>
              <TableHead>站点名称</TableHead>
              <TableHead>发件邮箱</TableHead>
              <TableHead className="w-20">启用</TableHead>
              <TableHead className="w-28">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sites.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-sm text-center py-6">
                  暂无站点，请新增。ERP 传入的 site_code 须与此处一致。
                </TableCell>
              </TableRow>
            ) : (
              sites.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.site_code}</TableCell>
                  <TableCell>{row.site_name || "—"}</TableCell>
                  <TableCell className="text-sm">{row.sender_email}</TableCell>
                  <TableCell>
                    {row.is_active ? (
                      <Badge variant="outline" className="text-[10px]">启用</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">停用</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => openSiteEdit(row)}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => deleteSite(row)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

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
                      subject: renderPreview(d.subject_template),
                      body: renderPreview(d.body_template),
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

      <Dialog open={siteDialogOpen} onOpenChange={setSiteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{siteForm.id ? "编辑站点" : "新增站点"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>站点编码 (site_code)</Label>
              <Input
                className="mt-1 font-mono"
                value={siteForm.site_code}
                onChange={(e) => setSiteForm((f) => ({ ...f, site_code: e.target.value }))}
                disabled={!!siteForm.id}
                placeholder="sedeta-us"
              />
              {siteForm.id && (
                <p className="text-xs text-muted-foreground mt-1">编码创建后不可修改</p>
              )}
            </div>
            <div>
              <Label>站点名称</Label>
              <Input
                className="mt-1"
                value={siteForm.site_name}
                onChange={(e) => setSiteForm((f) => ({ ...f, site_name: e.target.value }))}
                placeholder="SEDETA US Store"
              />
              <p className="text-xs text-muted-foreground mt-1">用于模板 {"{{site_name}}"}，ERP 无需传</p>
            </div>
            <div>
              <Label>发件邮箱</Label>
              <Select
                value={siteForm.sender_email}
                onValueChange={(v) => setSiteForm((f) => ({ ...f, sender_email: v }))}
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
            <div className="flex items-center gap-2">
              <Switch
                checked={siteForm.is_active}
                onCheckedChange={(v) => setSiteForm((f) => ({ ...f, is_active: v }))}
              />
              <Label>启用</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSiteDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void saveSite()} disabled={siteSaving}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
