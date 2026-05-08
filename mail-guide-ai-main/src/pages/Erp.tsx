import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Database, Edit3, PlugZap } from "lucide-react";
import { toast } from "sonner";

const DEFAULT_MAPPING = {
  order_no: "orderNumber",
  customer_email: "customerEmail",
  customer_name: "customerName",
  product_summary: "productName",
  shipping_status: "shippingStatus",
  tracking_no: "trackingNumber",
  order_status: "status",
  amount: "totalAmount",
  currency: "currency",
  ordered_at: "createdAt",
};

export default function ErpPage() {
  const [list, setList] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    base_url: "",
    auth_type: "bearer",
    auth_token: "",
    order_endpoint: "/orders",
    field_mapping: JSON.stringify(DEFAULT_MAPPING, null, 2),
  });

  async function load() {
    const { data } = await supabase.from("erp_configs").select("*").order("created_at", { ascending: false });
    setList(data ?? []);
  }
  useEffect(() => { load(); }, []);

  async function save() {
    let mapping;
    try { mapping = JSON.parse(form.field_mapping); } catch { toast.error("字段映射不是合法 JSON"); return; }
    const payload = { ...form, field_mapping: mapping, config_audit: [{ action: editingId ? "edit" : "create", at: new Date().toISOString() }] };
    const { error } = editingId
      ? await supabase.from("erp_configs").update(payload as any).eq("id", editingId)
      : await supabase.from("erp_configs").insert(payload as any);
    if (error) toast.error(error.message);
    else { toast.success("已保存"); setOpen(false); setEditingId(null); load(); }
  }

  async function testConnection() {
    if (!form.base_url || !form.order_endpoint) {
      toast.error("请先填写接口基础地址和订单查询路径");
      return;
    }
    setTesting(true);
    try {
      const url = `${form.base_url.replace(/\/$/, "")}${form.order_endpoint}?limit=1`;
      const headers: Record<string, string> = {};
      if (form.auth_token && form.auth_type === "bearer") headers.Authorization = `Bearer ${form.auth_token}`;
      if (form.auth_token && form.auth_type === "apikey") headers["X-API-Key"] = form.auth_token;
      const response = await fetch(url, { headers });
      const result = { ok: response.ok, status: response.status, tested_at: new Date().toISOString() };
      if (editingId) {
        await supabase.from("erp_configs").update({ last_tested_at: result.tested_at, last_test_result: result } as any).eq("id", editingId);
      }
      if (response.ok) toast.success(`ERP 测试成功：HTTP ${response.status}`);
      else toast.error(`ERP 测试失败：HTTP ${response.status}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  function editConfig(c: any) {
    setEditingId(c.id);
    setForm({
      name: c.name ?? "",
      base_url: c.base_url ?? "",
      auth_type: c.auth_type ?? "bearer",
      auth_token: c.auth_token ?? "",
      order_endpoint: c.order_endpoint ?? "/orders",
      field_mapping: JSON.stringify(c.field_mapping ?? DEFAULT_MAPPING, null, 2),
    });
    setOpen(true);
  }

  async function remove(id: string) {
    if (!confirm("删除此 ERP 配置？")) return;
    await supabase.from("erp_configs").delete().eq("id", id);
    load();
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">ERP 配置</h1>
          <p className="text-sm text-muted-foreground">配置 ERP 数据源、鉴权方式和字段映射，无需改动代码</p>
        </div>
        <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditingId(null); }}>
          <DialogTrigger asChild><Button><Plus className="w-4 h-4 mr-1" /> 添加 ERP</Button></DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>{editingId ? "编辑 ERP 数据源" : "添加 ERP 数据源"}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>名称</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="生产 ERP" /></div>
              <div><Label>接口基础地址</Label><Input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://erp.yourshop.com/api" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>鉴权方式</Label>
                  <Select value={form.auth_type} onValueChange={(v) => setForm({ ...form, auth_type: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bearer">Bearer Token</SelectItem>
                      <SelectItem value="apikey">API Key</SelectItem>
                      <SelectItem value="basic">Basic Auth</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div><Label>订单查询路径</Label><Input value={form.order_endpoint} onChange={(e) => setForm({ ...form, order_endpoint: e.target.value })} /></div>
              </div>
              <div><Label>鉴权凭证</Label><Input type="password" value={form.auth_token} onChange={(e) => setForm({ ...form, auth_token: e.target.value })} /></div>
              <div>
                <Label>字段映射 (JSON)</Label>
                <Textarea rows={10} value={form.field_mapping} onChange={(e) => setForm({ ...form, field_mapping: e.target.value })} className="font-mono text-xs" />
                <p className="text-xs text-muted-foreground mt-1">左边为系统标准字段，右边为 ERP 返回的字段名</p>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={testConnection} disabled={testing}>
                <PlugZap className={`w-4 h-4 mr-1 ${testing ? "animate-pulse" : ""}`} />测试连接
              </Button>
              <Button onClick={save}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-3">
        {list.map((c) => (
          <Card key={c.id} className="p-4 flex items-start gap-4">
            <div className="w-10 h-10 rounded bg-primary/10 text-primary flex items-center justify-center"><Database className="w-5 h-5" /></div>
            <div className="flex-1 min-w-0">
              <div className="font-medium flex items-center gap-2">{c.name} <Badge variant="outline">{c.auth_type}</Badge></div>
              <div className="text-sm text-muted-foreground truncate">{c.base_url}{c.order_endpoint}</div>
              <details className="mt-2">
                <summary className="text-xs text-primary cursor-pointer">查看字段映射</summary>
                <pre className="text-[11px] bg-muted p-2 rounded mt-1 overflow-auto">{JSON.stringify(c.field_mapping, null, 2)}</pre>
              </details>
              {c.last_tested_at && <div className="text-xs text-muted-foreground mt-2">上次测试：{new Date(c.last_tested_at).toLocaleString("zh-CN")} · HTTP {c.last_test_result?.status ?? "—"}</div>}
            </div>
            <Button size="icon" variant="ghost" onClick={() => editConfig(c)}><Edit3 className="w-4 h-4" /></Button>
            <Button size="icon" variant="ghost" onClick={() => remove(c.id)}><Trash2 className="w-4 h-4" /></Button>
          </Card>
        ))}
        {list.length === 0 && <Card className="p-8 text-center text-muted-foreground">暂无配置</Card>}
      </div>

      <Card className="p-4 mt-6 bg-info/10 border-info/30 text-sm">
        <div className="font-medium mb-1">📘 ERP 接口规范示例</div>
        <p className="text-muted-foreground mb-2">系统将按以下方式调用您的 ERP：</p>
        <pre className="text-[11px] bg-background p-2 rounded">{`GET {base_url}{order_endpoint}?email={客户邮箱}
Headers: Authorization: Bearer {auth_token}

返回 JSON 数组（按 field_mapping 解析）：
[{
  "orderNumber": "SO20260418001",
  "customerEmail": "alice@buyer.com",
  "customerName": "Alice",
  "productName": "Wireless Earbuds Pro",
  "shippingStatus": "shipped",
  "trackingNumber": "YT8829301",
  "status": "shipped",
  "totalAmount": 79.99,
  "currency": "USD",
  "createdAt": "2026-04-18T10:00:00Z"
}]`}</pre>
      </Card>
    </div>
  );
}
