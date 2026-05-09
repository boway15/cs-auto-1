import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Mail, RefreshCw, PlugZap, AlertTriangle, CheckCircle2, Edit3 } from "lucide-react";
import { toast } from "sonner";

async function getFunctionErrorMessage(error: { message?: string; context?: Response } | null): Promise<string> {
  if (!error) return "未知错误";
  const fallback = error.message || "未知错误";
  const response = error.context;
  if (!response) return fallback;
  try {
    const payload = await response.clone().json();
    if (typeof payload?.message === "string" && payload.message.trim()) return payload.message;
    if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  } catch {
    // ignore parse failures and fallback to text/bodyless message
  }
  try {
    const text = (await response.clone().text()).trim();
    if (text) return text;
  } catch {
    // ignore text read failure
  }
  return fallback;
}

// ===== 邮箱服务商预设 =====
interface ProviderPreset {
  label: string;
  domains: string[];             // 用于自动识别
  incoming_host: string;
  incoming_port: number;
  smtp_host: string;
  smtp_port: number;
  use_ssl: boolean;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: "Gmail 个人",
    domains: ["gmail.com", "googlemail.com"],
    incoming_host: "imap.gmail.com",
    incoming_port: 993,
    smtp_host: "smtp.gmail.com",
    smtp_port: 465,
    use_ssl: true,
  },
  {
    label: "Google Workspace（Gmail 企业邮）",
    domains: [],
    incoming_host: "imap.gmail.com",
    incoming_port: 993,
    smtp_host: "smtp.gmail.com",
    smtp_port: 465,
    use_ssl: true,
  },
  {
    label: "Outlook / Office 365",
    domains: ["outlook.com", "hotmail.com", "live.com", "office365.com"],
    incoming_host: "outlook.office365.com",
    incoming_port: 993,
    smtp_host: "smtp.office365.com",
    smtp_port: 587,
    use_ssl: true,
  },
  {
    label: "网易企业邮（qiye.163.com）",
    domains: ["qiye.163.com"],
    incoming_host: "imap.qiye.163.com",
    incoming_port: 993,
    smtp_host: "smtp.qiye.163.com",
    smtp_port: 465,
    use_ssl: true,
  },
  {
    label: "163 邮箱",
    domains: ["163.com"],
    incoming_host: "imap.163.com",
    incoming_port: 993,
    smtp_host: "smtp.163.com",
    smtp_port: 465,
    use_ssl: true,
  },
  {
    label: "QQ 邮箱",
    domains: ["qq.com"],
    incoming_host: "imap.qq.com",
    incoming_port: 993,
    smtp_host: "smtp.qq.com",
    smtp_port: 465,
    use_ssl: true,
  },
  {
    label: "QQ 企业邮（exmail.qq.com）",
    domains: ["exmail.qq.com"],
    incoming_host: "imap.exmail.qq.com",
    incoming_port: 993,
    smtp_host: "smtp.exmail.qq.com",
    smtp_port: 465,
    use_ssl: true,
  },
  {
    label: "126 邮箱",
    domains: ["126.com"],
    incoming_host: "imap.126.com",
    incoming_port: 993,
    smtp_host: "smtp.126.com",
    smtp_port: 465,
    use_ssl: true,
  },
  {
    label: "自定义（手动填写）",
    domains: [],
    incoming_host: "",
    incoming_port: 993,
    smtp_host: "",
    smtp_port: 465,
    use_ssl: true,
  },
];

function detectProvider(email: string): ProviderPreset | null {
  const match = email.match(/@([\w.-]+)$/);
  if (!match) return null;
  const domain = match[1].toLowerCase();
  for (const p of PROVIDER_PRESETS) {
    if (p.domains.some((d) => domain === d || domain.endsWith("." + d))) return p;
  }
  return null;
}

const EMPTY_FORM = {
  email_address: "",
  display_name: "",
  protocol: "IMAP",
  incoming_host: "",
  incoming_port: 993,
  use_ssl: true,
  auth_user: "",
  auth_password: "",
  smtp_host: "",
  smtp_port: 465,
};

export default function MailboxesPage() {
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);

  function applyPreset(presetKey: string) {
    setSelectedPreset(presetKey);
    if (presetKey === "custom" || !presetKey) {
      return;
    }
    const p = PROVIDER_PRESETS.find((_, i) => `preset-${i}` === presetKey);
    if (!p) return;
    setForm((f) => ({
      ...f,
      incoming_host: p.incoming_host,
      incoming_port: p.incoming_port,
      use_ssl: p.use_ssl,
      smtp_host: p.smtp_host,
      smtp_port: p.smtp_port,
    }));
  }

  // 根据邮箱域名自动匹配预设
  function handleEmailChange(email: string) {
    setForm((f) => ({ ...f, email_address: email, auth_user: email }));
    const detected = detectProvider(email);
    if (detected) {
      const idx = PROVIDER_PRESETS.indexOf(detected);
      const key = `preset-${idx}`;
      if (key !== selectedPreset) {
        setSelectedPreset(key);
        setForm((f) => ({
          ...f,
          email_address: email,
          auth_user: email,
          incoming_host: detected.incoming_host,
          incoming_port: detected.incoming_port,
          use_ssl: detected.use_ssl,
          smtp_host: detected.smtp_host,
          smtp_port: detected.smtp_port,
        }));
      }
    }
  }

  async function load() {
    const { data } = await supabase.from("mailboxes").select("*").order("created_at", { ascending: false });
    setList(data ?? []);
  }
  useEffect(() => { load(); }, []);

  async function testConnection() {
    const host = form.incoming_host.trim();
    const user = (form.auth_user || form.email_address).trim();
    const port = Number(form.incoming_port);
    if (!host || !port || !user || !form.auth_password) {
      toast.error("请先填写收件服务器、端口、邮箱地址、授权码");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("test-mailbox", {
        body: {
          host,
          port,
          user,
          pass: form.auth_password,
          use_ssl: form.use_ssl,
        },
      });
      if (error) {
        const message = await getFunctionErrorMessage(error);
        setTestResult({ ok: false, message });
        toast.error("连接失败：" + message);
      } else {
        setTestResult(data);
        if (data?.ok) toast.success("连接成功，可保存");
        else toast.error("连接失败：" + (data?.message ?? "未知错误"));
      }
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    const payload = { ...form, auth_user: form.auth_user || form.email_address };
    if (editingId && !payload.auth_password) {
      delete (payload as Partial<typeof payload>).auth_password;
    }
    const { error } = editingId
      ? await supabase.from("mailboxes").update({
          ...payload,
          config_audit: [{ action: "edit", at: new Date().toISOString() }],
        } as any).eq("id", editingId)
      : await supabase.from("mailboxes").insert(payload);
    if (error) toast.error(error.message);
    else {
      toast.success(editingId ? "邮箱已更新" : "邮箱已添加");
      setOpen(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
      setTestResult(null);
      load();
    }
  }

  function editMailbox(mb: any) {
    setEditingId(mb.id);
    setForm({
      email_address: mb.email_address ?? "",
      display_name: mb.display_name ?? "",
      protocol: mb.protocol ?? "IMAP",
      incoming_host: mb.incoming_host ?? "",
      incoming_port: mb.incoming_port ?? 993,
      use_ssl: !!mb.use_ssl,
      auth_user: mb.auth_user ?? mb.email_address ?? "",
      auth_password: "",
      smtp_host: mb.smtp_host ?? "",
      smtp_port: mb.smtp_port ?? 465,
    });
    setTestResult({ ok: true, message: "编辑现有配置，可直接保存；如修改服务器或授权码建议重新测试。" });
    setOpen(true);
  }

  async function remove(id: string) {
    if (!confirm("确定删除此邮箱配置？")) return;
    const { error } = await supabase.from("mailboxes").delete().eq("id", id);
    if (error) toast.error(error.message);
    else { toast.success("已删除"); load(); }
  }

  async function toggleActive(id: string, active: boolean) {
    await supabase.from("mailboxes").update({ is_active: active }).eq("id", id);
    load();
  }

  const [syncingId, setSyncingId] = useState<string | null>(null);

  function presetLabel(): string | null {
    if (!selectedPreset || selectedPreset === "custom") return null;
    const idx = parseInt(selectedPreset.replace("preset-", ""), 10);
    return PROVIDER_PRESETS[idx]?.label ?? null;
  }
  async function syncOne(id: string) {
    setSyncingId(id);
    let totalInserted = 0;
    let rounds = 0;
    const MAX_ROUNDS = 20;
    try {
      while (rounds < MAX_ROUNDS) {
        rounds++;
        const { data, error } = await supabase.functions.invoke("sync-mailbox", { body: { mailbox_id: id, force_bulk: true } });
        if (error) { toast.error("同步失败：" + error.message); break; }
        const r = data?.results?.[0];
        if (r?.error) { toast.error("同步失败：" + r.error); break; }
        if (!r) { toast.error("同步异常：未获取到结果"); break; }
        totalInserted += r.inserted ?? 0;
        toast.message(`第 ${rounds} 轮：新增 ${r.inserted ?? 0} 封，剩余 ${r.remaining ?? 0} 封`);
        if (!r.remaining || r.remaining === 0) break;
      }
      toast.success(`同步完成，本次共新增 ${totalInserted} 封邮件（${rounds} 轮）`);
    } finally {
      setSyncingId(null);
      load();
    }
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">邮箱配置</h1>
          <p className="text-sm text-muted-foreground">配置用于收取客户邮件的 IMAP / POP3 邮箱</p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setForm(EMPTY_FORM); setSelectedPreset(""); setTestResult(null); setEditingId(null); } }}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-1" /> 添加邮箱</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>{editingId ? "编辑邮箱" : "添加邮箱"}</DialogTitle></DialogHeader>

            {/* 服务商预设 */}
            <div className="mb-3">
              <Label className="text-xs text-muted-foreground mb-1.5 block">快捷选择服务商（自动填入 IMAP/SMTP）</Label>
              <Select value={selectedPreset} onValueChange={applyPreset}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="选择服务商自动填入..." />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_PRESETS.map((p, i) => (
                    <SelectItem key={`preset-${i}`} value={`preset-${i}`}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div><Label>邮箱地址</Label><Input value={form.email_address} onChange={(e) => handleEmailChange(e.target.value)} placeholder="service@yourshop.com" /></div>
              <div><Label>显示名称</Label><Input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="官方客服" /></div>
              <div>
                <Label>协议</Label>
                <Select value={form.protocol} onValueChange={(v) => setForm({ ...form, protocol: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IMAP">IMAP（推荐）</SelectItem>
                    <SelectItem value="POP3">POP3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 pt-6"><Switch checked={form.use_ssl} onCheckedChange={(v) => setForm({ ...form, use_ssl: v })} /> <Label>使用 SSL</Label></div>
              <div><Label>收件服务器</Label><Input value={form.incoming_host} onChange={(e) => setForm({ ...form, incoming_host: e.target.value })} placeholder="imap.gmail.com" />{presetLabel() && <span className="text-[10px] text-muted-foreground mt-0.5 block">按照 {presetLabel()} 预设</span>}</div>
              <div><Label>收件端口</Label><Input type="number" value={form.incoming_port} onChange={(e) => setForm({ ...form, incoming_port: +e.target.value })} /></div>
              <div><Label>SMTP 服务器（发件）</Label><Input value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} placeholder="smtp.gmail.com" />{presetLabel() && <span className="text-[10px] text-muted-foreground mt-0.5 block">按照 {presetLabel()} 预设</span>}</div>
              <div><Label>SMTP 端口</Label><Input type="number" value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: +e.target.value })} /></div>
              <div className="col-span-2"><Label>授权码 / 应用专用密码</Label><Input type="password" value={form.auth_password} onChange={(e) => setForm({ ...form, auth_password: e.target.value })} placeholder={editingId ? "留空则保持原授权码；修改时请重新填写" : "非邮箱登录密码，需到邮箱后台生成应用专用密码"} /></div>
            </div>

            {testResult && (
              <Card className={`p-3 text-sm flex items-start gap-2 ${testResult.ok ? "bg-success/10 border-success/30" : "bg-destructive/10 border-destructive/30"}`}>
                {testResult.ok
                  ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-success shrink-0" />
                  : <AlertTriangle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />}
                <div>
                  <div className="font-medium">{testResult.ok ? "连接成功 ✅" : "连接失败"}</div>
                  {testResult.message && <div className="text-muted-foreground mt-1 break-all">{testResult.message}</div>}
                </div>
              </Card>
            )}

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={testConnection} disabled={testing}>
                <PlugZap className={`w-4 h-4 mr-1 ${testing ? "animate-pulse" : ""}`} />
                {testing ? "测试中..." : "测试连接"}
              </Button>
              <Button onClick={save} disabled={!testResult?.ok}>
                {editingId ? "保存修改" : testResult?.ok ? "保存" : "请先测试连接成功"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3">
        {list.map((mb) => (
          <Card key={mb.id} className="p-4">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded bg-primary/10 text-primary flex items-center justify-center"><Mail className="w-5 h-5" /></div>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{mb.display_name || mb.email_address}</div>
                <div className="text-sm text-muted-foreground truncate">{mb.email_address} · {mb.protocol} · {mb.incoming_host}:{mb.incoming_port}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {mb.last_synced_at ? `上次同步：${new Date(mb.last_synced_at).toLocaleString("zh-CN")}` : "尚未同步"}
                </div>
              </div>
              <Badge variant={mb.is_active ? "default" : "secondary"}>{mb.is_active ? "启用中" : "已停用"}</Badge>
              <Button size="sm" variant="outline" onClick={() => syncOne(mb.id)} disabled={syncingId === mb.id}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1 ${syncingId === mb.id ? "animate-spin" : ""}`} />
                {syncingId === mb.id ? "同步中" : "立即同步"}
              </Button>
              <Switch checked={mb.is_active} onCheckedChange={(v) => toggleActive(mb.id, v)} />
              <Button size="icon" variant="ghost" onClick={() => editMailbox(mb)}><Edit3 className="w-4 h-4" /></Button>
              <Button size="icon" variant="ghost" onClick={() => remove(mb.id)}><Trash2 className="w-4 h-4" /></Button>
            </div>
            {mb.last_error && (
              <div className="mt-3 p-2 rounded bg-destructive/10 border border-destructive/30 text-xs text-destructive flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div className="break-all"><span className="font-medium">上次同步失败：</span>{mb.last_error}</div>
              </div>
            )}
          </Card>
        ))}
        {list.length === 0 && <Card className="p-8 text-center text-muted-foreground">暂无邮箱，点击右上角添加</Card>}
      </div>

      <Card className="p-4 mt-6 bg-info/10 border-info/30 text-sm">
        <div className="font-medium mb-1">📥 收件说明</div>
        <p className="text-muted-foreground">添加邮箱时<strong>必须先点"测试连接"成功</strong>才能保存，避免无效配置。系统每 5 分钟自动增量同步一次；首次同步会拉取最近 30 天邮件。</p>
        <p className="text-muted-foreground mt-1">⚠️ 授权码须到邮箱后台生成"客户端授权码"或"应用专用密码"，不能用普通登录密码。网易企业邮（qiye.163.com）需先在管理后台启用 IMAP/SMTP 服务。</p>
      </Card>
    </div>
  );
}
