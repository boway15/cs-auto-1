import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Trash2, RefreshCw, PlugZap, AlertTriangle, CheckCircle2, Store } from "lucide-react";
import { toast } from "sonner";

const EMPTY_FORM = {
  shop_domain: "",
  display_name: "",
  access_token: "",
  api_version: "2024-10",
};

export default function ShopsPage() {
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("shopify_shops").select("*").order("created_at", { ascending: false });
    setList(data ?? []);
  }
  useEffect(() => { load(); }, []);

  function normalizeDomain(v: string) {
    return v.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  async function testConnection() {
    if (!form.shop_domain || !form.access_token) {
      toast.error("请填写店铺域名和 Access Token");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("shopify-test-connection", {
        body: {
          shop_domain: normalizeDomain(form.shop_domain),
          access_token: form.access_token,
          api_version: form.api_version,
        },
      });
      if (error) {
        setTestResult({ ok: false, message: error.message });
        toast.error("测试失败：" + error.message);
      } else {
        setTestResult(data);
        if (data?.ok) toast.success(data.message || "连接成功");
        else toast.error("连接失败：" + (data?.message ?? "未知错误"));
      }
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    const payload = { ...form, shop_domain: normalizeDomain(form.shop_domain) };
    const { error } = await supabase.from("shopify_shops").insert(payload);
    if (error) toast.error(error.message);
    else {
      toast.success("店铺已添加");
      setOpen(false);
      setForm(EMPTY_FORM);
      setTestResult(null);
      load();
    }
  }

  async function remove(id: string) {
    if (!confirm("确定删除此店铺？已同步的订单不会被删除。")) return;
    const { error } = await supabase.from("shopify_shops").delete().eq("id", id);
    if (error) toast.error(error.message);
    else { toast.success("已删除"); load(); }
  }

  async function toggleActive(id: string, active: boolean) {
    await supabase.from("shopify_shops").update({ is_active: active }).eq("id", id);
    load();
  }

  async function syncOne(id: string) {
    setSyncingId(id);
    try {
      let totalInserted = 0;
      let totalUpdated = 0;
      let rounds = 0;
      const MAX_ROUNDS = 10;
      while (rounds < MAX_ROUNDS) {
        rounds++;
        const { data, error } = await supabase.functions.invoke("shopify-sync-orders", { body: { shop_id: id } });
        if (error) { toast.error("同步失败：" + error.message); break; }
        const r = data?.results?.[0];
        if (!r) { toast.error("同步异常"); break; }
        if (!r.ok) { toast.error("同步失败：" + r.error); break; }
        totalInserted += r.inserted ?? 0;
        totalUpdated += r.updated ?? 0;
        toast.message(`第 ${rounds} 轮：新增 ${r.inserted}、更新 ${r.updated}`);
        if (!r.has_more) break;
      }
      toast.success(`同步完成，新增 ${totalInserted}、更新 ${totalUpdated}`);
    } finally {
      setSyncingId(null);
      load();
    }
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">Shopify 店铺</h1>
          <p className="text-sm text-muted-foreground">绑定 Shopify 店铺，自动同步订单到工作台</p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setForm(EMPTY_FORM); setTestResult(null); } }}>
          <DialogTrigger asChild>
            <Button><Plus className="w-4 h-4 mr-1" /> 绑定店铺</Button>
          </DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader><DialogTitle>绑定 Shopify 店铺</DialogTitle></DialogHeader>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>店铺域名</Label>
                <Input
                  value={form.shop_domain}
                  onChange={(e) => setForm({ ...form, shop_domain: e.target.value })}
                  placeholder="mystore.myshopify.com"
                />
                <p className="text-[11px] text-muted-foreground mt-1">填 Shopify 后台 .myshopify.com 域名，无需 https://</p>
              </div>
              <div>
                <Label>显示名称</Label>
                <Input
                  value={form.display_name}
                  onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                  placeholder="主店铺"
                />
              </div>
              <div>
                <Label>API 版本</Label>
                <Input
                  value={form.api_version}
                  onChange={(e) => setForm({ ...form, api_version: e.target.value })}
                />
              </div>
              <div className="col-span-2">
                <Label>Admin API Access Token</Label>
                <Input
                  type="password"
                  value={form.access_token}
                  onChange={(e) => setForm({ ...form, access_token: e.target.value })}
                  placeholder="shpat_xxxxxxxxxxxx"
                />
              </div>
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
                {testResult?.ok ? "保存" : "请先测试连接成功"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3">
        {list.map((s) => (
          <Card key={s.id} className="p-4">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded bg-primary/10 text-primary flex items-center justify-center"><Store className="w-5 h-5" /></div>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{s.display_name || s.shop_domain}</div>
                <div className="text-sm text-muted-foreground truncate">{s.shop_domain} · API {s.api_version}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {s.last_synced_at ? `上次同步：${new Date(s.last_synced_at).toLocaleString("zh-CN")}` : "尚未同步"}
                </div>
              </div>
              <Badge variant={s.is_active ? "default" : "secondary"}>{s.is_active ? "启用中" : "已停用"}</Badge>
              <Button size="sm" variant="outline" onClick={() => syncOne(s.id)} disabled={syncingId === s.id}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1 ${syncingId === s.id ? "animate-spin" : ""}`} />
                {syncingId === s.id ? "同步中" : "立即同步"}
              </Button>
              <Switch checked={s.is_active} onCheckedChange={(v) => toggleActive(s.id, v)} />
              <Button size="icon" variant="ghost" onClick={() => remove(s.id)}><Trash2 className="w-4 h-4" /></Button>
            </div>
            {s.last_error && (
              <div className="mt-3 p-2 rounded bg-destructive/10 border border-destructive/30 text-xs text-destructive flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div className="break-all"><span className="font-medium">上次同步失败：</span>{s.last_error}</div>
              </div>
            )}
          </Card>
        ))}
        {list.length === 0 && <Card className="p-8 text-center text-muted-foreground">暂无店铺，点击右上角绑定</Card>}
      </div>

      <Card className="p-4 mt-6 bg-info/10 border-info/30 text-sm space-y-2">
        <div className="font-medium">📘 如何获取 Admin API Access Token</div>
        <ol className="text-muted-foreground space-y-1 list-decimal list-inside text-xs">
          <li>Shopify 后台 → <strong>Settings → Apps and sales channels → Develop apps</strong>（首次需启用 "Allow custom app development"）</li>
          <li>点击 <strong>Create an app</strong>，填写名称（如 "Lovable Sync"）</li>
          <li>进入 <strong>Configuration → Admin API integration → Configure</strong>，勾选权限：
            <code className="ml-1 px-1 rounded bg-background">read_orders</code>、
            <code className="px-1 rounded bg-background">write_orders</code>、
            <code className="px-1 rounded bg-background">read_fulfillments</code>、
            <code className="px-1 rounded bg-background">read_customers</code>
          </li>
          <li>点 <strong>Install app</strong> → 复制 <code className="px-1 rounded bg-background">shpat_xxx</code> Token 粘贴到上方</li>
          <li>系统每 5 分钟自动增量同步；首次绑定将拉取最近 30 天订单</li>
        </ol>
        <p className="text-muted-foreground text-xs">⚠️ 超过 60 天的历史订单需额外申请 <code className="px-1 rounded bg-background">read_all_orders</code> 权限。</p>
      </Card>
    </div>
  );
}
