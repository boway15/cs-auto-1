import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { AlertTriangle, Eye, RefreshCw, Search } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
import { toast } from "sonner";

type RiskLog = any;

const statusMap: Record<string, string> = {
  pending: "待执行",
  success: "成功",
  failed: "失败",
  retrying: "重试中",
};

export default function RiskLogs() {
  const { isAdmin } = useAuth();
  const [logs, setLogs] = useState<RiskLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<RiskLog | null>(null);
  const [riskAutoInterceptEnabled, setRiskAutoInterceptEnabled] = useState(false);
  const [riskSettingLoaded, setRiskSettingLoaded] = useState(false);
  const [savingRiskSetting, setSavingRiskSetting] = useState(false);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("risk_intercept_logs")
      .select("*, orders(order_no, customer_email), emails(subject, from_email)")
      .order("created_at", { ascending: false })
      .limit(200);
    setLogs(data ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!isAdmin) {
      setRiskSettingLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("automation_settings")
        .select("risk_auto_intercept_enabled")
        .eq("singleton", "default")
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        if (!error.message.includes("column") && error.code !== "42703") {
          console.warn("automation_settings risk_auto_intercept_enabled:", error.message);
        }
        setRiskAutoInterceptEnabled(false);
      } else {
        setRiskAutoInterceptEnabled(!!(data as { risk_auto_intercept_enabled?: boolean } | null)?.risk_auto_intercept_enabled);
      }
      setRiskSettingLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  async function saveRiskAutoIntercept(enabled: boolean) {
    const prev = riskAutoInterceptEnabled;
    setRiskAutoInterceptEnabled(enabled);
    setSavingRiskSetting(true);
    const { error } = await supabase
      .from("automation_settings")
      .update({ risk_auto_intercept_enabled: enabled } as never)
      .eq("singleton", "default");
    setSavingRiskSetting(false);
    if (error) {
      setRiskAutoInterceptEnabled(prev);
      toast.error("保存失败：" + error.message);
      return;
    }
    toast.success("自动拦截设置已保存");
  }

  const filtered = logs.filter((log) => {
    if (status !== "all" && log.status !== status) return false;
    if (!search) return true;
    const haystack = [
      log.intercept_no,
      log.orders?.order_no,
      log.referenced_order_no,
      log.orders?.customer_email,
      log.emails?.subject,
      log.emails?.from_email,
      log.intercept_reason,
    ].join(" ").toLowerCase();
    return haystack.includes(search.toLowerCase());
  });

  return (
    <div className="h-screen flex flex-col p-6 overflow-hidden">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-warning" /> 拦截记录
          </h1>
          <p className="text-sm text-muted-foreground">自动/人工暂停发货动作、第三方同步结果与失败审计</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isAdmin && riskSettingLoaded && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5">
              <Label htmlFor="risk-auto-intercept" className="text-xs font-medium cursor-pointer whitespace-nowrap">
                自动拦截与补偿
              </Label>
              <Switch
                id="risk-auto-intercept"
                checked={riskAutoInterceptEnabled}
                disabled={savingRiskSetting}
                onCheckedChange={(v) => void saveRiskAutoIntercept(v)}
              />
            </div>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-4">
        {(["success", "failed", "retrying", "pending"] as const).map((key) => (
          <Card key={key} className="p-4">
            <div className="text-xs text-muted-foreground">{statusMap[key]}</div>
            <div className="text-2xl font-semibold mt-1">{logs.filter((l) => l.status === key).length}</div>
          </Card>
        ))}
      </div>

      <div className="flex gap-2 mb-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索编号、订单、邮箱、主题" className="pl-7 h-8 text-sm" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="success">成功</SelectItem>
            <SelectItem value="failed">失败</SelectItem>
            <SelectItem value="retrying">重试中</SelectItem>
            <SelectItem value="pending">待执行</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>编号</TableHead>
                <TableHead>订单</TableHead>
                <TableHead>触发</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>原因</TableHead>
                <TableHead>时间</TableHead>
                <TableHead className="w-20">详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">暂无记录</TableCell></TableRow>
              ) : filtered.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-mono text-xs">{log.intercept_no}</TableCell>
                  <TableCell>
                    <div className="text-sm">
                      {log.orders?.order_no ?? log.referenced_order_no ?? "—"}
                      {!log.orders?.order_no && log.referenced_order_no ? (
                        <span className="ml-1 text-[10px] text-muted-foreground">（仅邮件单号）</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{log.orders?.customer_email ?? "—"}</div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className="font-normal text-muted-foreground bg-muted/40 border-border/70 shadow-none"
                    >
                      {log.trigger_source === "auto" ? "自动" : log.trigger_source === "manual" ? "人工" : log.trigger_source === "retry" ? "补偿" : log.trigger_source}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        log.status === "failed"
                          ? "font-normal border-destructive/25 bg-destructive/5 text-destructive/80 shadow-none"
                          : "font-normal text-muted-foreground bg-muted/40 border-border/70 shadow-none"
                      }
                    >
                      {statusMap[log.status] ?? log.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate">{log.intercept_reason || log.reason_category || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(log.created_at), { addSuffix: true, locale: zhCN })}
                  </TableCell>
                  <TableCell>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDetail(log)}>
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </Card>

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[min(90vh,900px)] w-[min(96vw,56rem)] max-w-[min(96vw,56rem)] overflow-y-auto overflow-x-hidden">
          <DialogHeader><DialogTitle>拦截详情</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm min-w-0">
              <div className="grid grid-cols-2 gap-3 min-w-0">
                <div className="min-w-0 break-words"><span className="text-muted-foreground">编号：</span>{detail.intercept_no}</div>
                <div className="min-w-0 break-words"><span className="text-muted-foreground">动作：</span>{detail.action === "hold" ? "暂停发货" : "恢复发货"}</div>
                <div className="min-w-0 break-words"><span className="text-muted-foreground">状态：</span>{statusMap[detail.status] ?? detail.status}</div>
                <div className="min-w-0 break-words"><span className="text-muted-foreground">重试：</span>{detail.retry_count}</div>
                <div className="col-span-2 min-w-0 break-words"><span className="text-muted-foreground">邮件：</span>{detail.emails?.subject ?? "—"}</div>
                <div className="col-span-2 min-w-0 break-words">
                  <span className="text-muted-foreground">引用单号：</span>
                  {detail.referenced_order_no ?? detail.orders?.order_no ?? "—"}
                  {!detail.order_id && detail.referenced_order_no ? (
                    <span className="text-muted-foreground text-xs">（未关联本地订单）</span>
                  ) : null}
                </div>
                <div className="col-span-2 min-w-0 whitespace-pre-wrap break-words break-all">
                  <span className="text-muted-foreground">原因：</span>
                  {detail.intercept_reason || "—"}
                </div>
              </div>
              {detail.error_message && (
                <div className="p-2 rounded border border-destructive/30 bg-destructive/10 text-destructive text-xs min-w-0 whitespace-pre-wrap break-words break-all">
                  {detail.error_message}
                </div>
              )}
              <pre className="max-h-[min(50vh,22rem)] overflow-auto rounded bg-muted p-3 text-xs min-w-0 whitespace-pre-wrap break-all">{JSON.stringify({
                shopify_response: detail.shopify_response,
                erp_response: detail.erp_response,
              }, null, 2)}</pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
