import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, RefreshCw, BellRing } from "lucide-react";
import { toast } from "sonner";

type AlertRow = {
  id: string;
  source: string;
  severity: string;
  title: string;
  message: string | null;
  status: string;
  related_email_id: string | null;
  related_order_id: string | null;
  metadata: Record<string, unknown>;
  idempotency_key: string | null;
  email_sent_at: string | null;
  email_send_error: string | null;
  created_at: string;
  resolved_at: string | null;
};

const SEVERITY_CLS: Record<string, string> = {
  info: "bg-muted text-foreground/80 border-border",
  warning: "bg-warning/15 text-warning border-warning/30",
  critical: "bg-destructive/15 text-destructive border-destructive/30",
};

const STATUS_CLS: Record<string, string> = {
  open: "bg-warning/15 text-warning border-warning/30",
  acknowledged: "bg-primary/15 text-primary border-primary/30",
  resolved: "bg-success/15 text-success border-success/30",
};

export default function Alerts() {
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<string>("all");
  const [status, setStatus] = useState<string>("open");

  async function load() {
    setLoading(true);
    const { data, error } = await supabase
      .from("ops_alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    setLoading(false);
    if (error) {
      toast.error("加载告警失败：" + error.message);
      return;
    }
    setRows((data ?? []) as AlertRow[]);
  }

  useEffect(() => {
    load();
  }, []);

  async function updateStatus(row: AlertRow, targetStatus: "acknowledged" | "resolved") {
    if (row.status === targetStatus) return;
    const { error } = await supabase
      .from("ops_alerts")
      .update({
        status: targetStatus,
        resolved_at: targetStatus === "resolved" ? new Date().toISOString() : null,
      } as any)
      .eq("id", row.id);
    if (error) { toast.error("更新失败：" + error.message); return; }
    toast.success(targetStatus === "resolved" ? "已标记为已回复" : "已改回处理中");
    load();
  }

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (severity !== "all" && r.severity !== severity) return false;
      if (status !== "all" && r.status !== status) return false;
      if (search) {
        const s = search.toLowerCase();
        return (
          r.title.toLowerCase().includes(s) ||
          (r.message ?? "").toLowerCase().includes(s) ||
          r.source.toLowerCase().includes(s) ||
          (r.idempotency_key ?? "").toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [rows, search, severity, status]);

  return (
    <div className="h-screen flex flex-col">
      <div className="border-b p-3 flex items-center gap-2">
        <BellRing className="w-4 h-4" />
        <div className="font-semibold text-sm flex-1">运营告警</div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>
      <div className="border-b p-3 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索 标题 / 来源 / 内容 / 幂等键"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-7 h-8 text-sm"
          />
        </div>
        <Select value={severity} onValueChange={setSeverity}>
          <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部级别</SelectItem>
            <SelectItem value="critical">严重</SelectItem>
            <SelectItem value="warning">警告</SelectItem>
            <SelectItem value="info">信息</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 text-xs w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="open">待处理</SelectItem>
            <SelectItem value="acknowledged">处理中</SelectItem>
            <SelectItem value="resolved">已回复</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ScrollArea className="flex-1">
        <Card className="m-3 p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">级别</TableHead>
                <TableHead className="w-44">来源 / 时间</TableHead>
                <TableHead>标题</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-32">通知邮件</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-10">
                    暂无告警
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Badge variant="outline" className={SEVERITY_CLS[row.severity] ?? ""}>
                      {row.severity === "critical" ? "严重" : row.severity === "warning" ? "警告" : "信息"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="text-xs font-medium">{row.source}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(row.created_at).toLocaleString("zh-CN")}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{row.title}</div>
                    {row.message && (
                      <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{row.message}</div>
                    )}
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {row.related_email_id && <span>邮件 {row.related_email_id.slice(0, 8)}…</span>}
                      {row.related_email_id && row.related_order_id && <span> · </span>}
                      {row.related_order_id && <span>订单 {row.related_order_id.slice(0, 8)}…</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={STATUS_CLS[row.status] ?? ""}>
                      {row.status === "open" ? "待处理" : row.status === "acknowledged" ? "处理中" : row.status === "resolved" ? "已回复" : row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.email_sent_at ? (
                      <div className="text-success">
                        已发<br />
                        <span className="text-[10px] text-muted-foreground">{new Date(row.email_sent_at).toLocaleString("zh-CN")}</span>
                      </div>
                    ) : row.email_send_error ? (
                      <div className="text-destructive line-clamp-2" title={row.email_send_error}>
                        失败：{row.email_send_error}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">未发</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.status === "resolved" ? (
                      <Button size="sm" variant="ghost" onClick={() => updateStatus(row, "acknowledged")}>
                        改回处理中
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => updateStatus(row, "resolved")}>
                        标记已回复
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </ScrollArea>
    </div>
  );
}
