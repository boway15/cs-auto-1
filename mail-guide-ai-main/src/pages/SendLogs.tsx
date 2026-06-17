import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { TableListPagination } from "@/components/TableListPagination";
import { clampListPage, listPageCount, listPageRange } from "@/lib/list-pagination";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefreshCw, Search, Eye, CheckCircle2, XCircle, Download } from "lucide-react";
import { cstDayEndIso, cstDayStartIso, formatDateTimeCST } from "@/lib/format-datetime";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";

type Log = {
  id: string;
  created_at: string;
  send_type: string;
  status: string;
  from_email: string | null;
  to_email: string;
  subject: string | null;
  content: string | null;
  send_no: string | null;
  smtp_response: string | null;
  error_message: string | null;
  message_id: string | null;
  order_id: string | null;
  order_no?: string | null;
  sent_by?: string | null;
  operator_label?: string | null;
  metadata?: Record<string, unknown> | null;
};

const sendTypeMap: Record<string, { label: string; cls: string }> = {
  manual: { label: "手工回复", cls: "bg-primary/15 text-primary border-primary/30" },
  ai_draft: { label: "AI 草稿", cls: "bg-accent text-accent-foreground border-border" },
  auto_template: { label: "自动模板", cls: "bg-warning/15 text-warning border-warning/30" },
  erp_notify: { label: "ERP 拦截通知", cls: "bg-info/15 text-info border-info/30" },
};

function orderNoFromLog(log: Log): string | null {
  if (log.order_no) return log.order_no;
  const meta = log.metadata;
  if (meta && typeof meta.order_no === "string") return meta.order_no;
  return null;
}

function templateCodeFromLog(log: Log): string | null {
  const meta = log.metadata;
  if (meta && typeof meta.template_code === "string") return meta.template_code;
  return null;
}

function siteCodeFromLog(log: Log): string | null {
  const meta = log.metadata;
  if (meta && typeof meta.site_code === "string") return meta.site_code;
  return null;
}

function siteNameFromLog(log: Log): string | null {
  const meta = log.metadata;
  if (meta && typeof meta.site_name === "string") return meta.site_name;
  return null;
}

function operatorLabelFromLog(
  log: Log,
  profileNames: Map<string, string | null>,
): string | null {
  if (log.send_type !== "manual") return null;
  const meta = log.metadata;
  if (meta) {
    const displayName =
      typeof meta.operator_display_name === "string" ? meta.operator_display_name.trim() : "";
    const email = typeof meta.operator_email === "string" ? meta.operator_email.trim() : "";
    if (displayName && email) return `${displayName} (${email})`;
    if (displayName) return displayName;
    if (email) return email;
  }
  if (log.sent_by) {
    const name = profileNames.get(log.sent_by);
    if (name) return name;
    return log.sent_by;
  }
  return null;
}

type SendLogFilters = {
  statusFilter: "all" | "sent" | "failed";
  typeFilter: string;
  fromFilter: string;
  dateFrom: string;
  dateTo: string;
  searchDebounced: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySendLogFilters<T extends { eq: (...args: unknown[]) => T; gte: (...args: unknown[]) => T; lte: (...args: unknown[]) => T; or: (...args: unknown[]) => T }>(
  query: T,
  filters: SendLogFilters,
): T {
  let q = query;
  if (filters.statusFilter !== "all") q = q.eq("status", filters.statusFilter);
  if (filters.typeFilter !== "all") q = q.eq("send_type", filters.typeFilter);
  if (filters.fromFilter) q = q.eq("from_email", filters.fromFilter);
  if (filters.dateFrom) q = q.gte("created_at", cstDayStartIso(filters.dateFrom));
  if (filters.dateTo) q = q.lte("created_at", cstDayEndIso(filters.dateTo));
  if (filters.searchDebounced) {
    const s = `%${filters.searchDebounced}%`;
    q = q.or(
      `to_email.ilike.${s},from_email.ilike.${s},subject.ilike.${s},send_no.ilike.${s}`,
    );
  }
  return q;
}

export default function SendLogs() {
  const { hasMailboxAccess, grantsLoading } = useAuth();
  const [logs, setLogs] = useState<Log[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [listPage, setListPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "sent" | "failed">("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [fromFilter, setFromFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [detail, setDetail] = useState<Log | null>(null);
  const [fromOptions, setFromOptions] = useState<string[]>([]);
  const [stats, setStats] = useState({ total: 0, sent: 0, failed: 0 });

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setListPage(0);
  }, [statusFilter, typeFilter, fromFilter, dateFrom, dateTo, searchDebounced]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const filters: SendLogFilters = {
        statusFilter,
        typeFilter,
        fromFilter,
        dateFrom,
        dateTo,
        searchDebounced,
      };

      const [sentRes, failedRes, totalRes, fromRes] = await Promise.all([
        applySendLogFilters(
          supabase.from("email_send_logs").select("*", { count: "exact", head: true }),
          filters,
        ).eq("status", "sent"),
        applySendLogFilters(
          supabase.from("email_send_logs").select("*", { count: "exact", head: true }),
          filters,
        ).eq("status", "failed"),
        applySendLogFilters(
          supabase.from("email_send_logs").select("*", { count: "exact", head: true }),
          filters,
        ),
        supabase
          .from("email_send_logs")
          .select("from_email")
          .not("from_email", "is", null)
          .order("created_at", { ascending: false })
          .limit(300),
      ]);
      setStats({
        total: totalRes.count ?? 0,
        sent: sentRes.count ?? 0,
        failed: failedRes.count ?? 0,
      });
      const fromSet = new Set<string>();
      for (const row of fromRes.data ?? []) {
        if (row.from_email) fromSet.add(row.from_email);
      }
      setFromOptions([...fromSet]);

      let query = applySendLogFilters(
        supabase.from("email_send_logs").select("*", { count: "exact" }),
        filters,
      );

      const { from, to } = listPageRange(listPage);
      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(from, to);

      if (error) throw error;
      setListTotal(count ?? 0);

      const rows = (data ?? []).map((log) => {
        const meta = (log.metadata ?? null) as Record<string, unknown> | null;
        return {
          ...log,
          metadata: meta,
          order_no: orderNoFromLog({ ...log, metadata: meta }),
        };
      });

      const orderIdsNeedingLookup = Array.from(
        new Set(
          rows
            .filter((log) => log.order_id && !log.order_no)
            .map((log) => log.order_id as string),
        ),
      );
      let orderNoById = new Map<string, string>();
      if (orderIdsNeedingLookup.length > 0) {
        const { data: orders, error: ordersError } = await supabase
          .from("orders")
          .select("id, order_no")
          .in("id", orderIdsNeedingLookup);
        if (ordersError) {
          console.warn("Failed to load send log orders", ordersError);
        } else {
          orderNoById = new Map((orders ?? []).map((order) => [order.id, order.order_no]));
        }
      }

      const enriched = rows.map((log) => ({
        ...log,
        order_no: log.order_no ?? (log.order_id ? orderNoById.get(log.order_id) ?? null : null),
      }));

      const sentByIds = Array.from(
        new Set(
          enriched
            .filter((log) => log.send_type === "manual" && log.sent_by)
            .map((log) => log.sent_by as string),
        ),
      );
      let profileNames = new Map<string, string | null>();
      if (sentByIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from("profiles")
          .select("user_id, display_name")
          .in("user_id", sentByIds);
        if (profilesError) {
          console.warn("Failed to load send log operators", profilesError);
        } else {
          profileNames = new Map(
            (profiles ?? []).map((p) => [p.user_id, p.display_name]),
          );
        }
      }

      const withOperators = enriched.map((log) => ({
        ...log,
        operator_label: operatorLabelFromLog(log, profileNames),
      }));

      const q = searchDebounced.toLowerCase();
      setLogs(
        q
          ? withOperators.filter((l) => {
              const tc = templateCodeFromLog(l)?.toLowerCase() ?? "";
              const op = l.operator_label?.toLowerCase() ?? "";
              return (
                l.order_no?.toLowerCase().includes(q) ||
                tc.includes(q) ||
                op.includes(q) ||
                l.to_email?.toLowerCase().includes(q) ||
                l.from_email?.toLowerCase().includes(q) ||
                l.subject?.toLowerCase().includes(q) ||
                l.send_no?.toLowerCase().includes(q)
              );
            })
          : withOperators,
      );
    } catch (error) {
      const message = typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "请稍后重试";
      console.error("Failed to load send logs", error);
      toast.error(`发送日志加载失败：${message}`);
      setLogs([]);
      setListTotal(0);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, fromFilter, dateFrom, dateTo, searchDebounced, listPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const listPageCountVal = listPageCount(listTotal);
  const listPageSafe = clampListPage(listPage, listPageCountVal);

  useEffect(() => {
    if (listPage > 0 && listPage >= listPageCountVal) {
      setListPage(Math.max(0, listPageCountVal - 1));
    }
  }, [listPage, listPageCountVal]);

  function exportCsv() {
    const header = ["时间", "发送编号", "类型", "状态", "发件人", "人工账号", "收件人", "订单号", "主题", "SMTP响应", "错误"];
    const rows = logs.map((l) => [
      formatDateTimeCST(l.created_at),
      l.send_no ?? l.id,
      sendTypeMap[l.send_type]?.label ?? l.send_type,
      l.status,
      l.from_email ?? "",
      l.operator_label ?? "",
      l.to_email ?? "",
      l.order_no ?? "",
      l.subject ?? "",
      l.smtp_response ?? "",
      l.error_message ?? "",
    ]);
    const csv = [header, ...rows].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `send-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="h-screen flex flex-col p-6 overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">发送日志</h1>
          <p className="text-sm text-muted-foreground">本系统所有外发邮件记录</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="w-4 h-4 mr-2" />导出 CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />刷新
          </Button>
        </div>
      </div>

      {!hasMailboxAccess && !grantsLoading && (
        <Card className="p-3 mb-4 text-sm text-muted-foreground border-warning/40 bg-warning/10">
          当前账号未分配授权邮箱，仅显示空列表。请联系管理员配置邮箱授权。
        </Card>
      )}

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">总发送</div>
          <div className="text-2xl font-semibold mt-1">{stats.total}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3 text-success" /> 成功
          </div>
          <div className="text-2xl font-semibold mt-1 text-success">{stats.sent}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <XCircle className="w-3 h-3 text-destructive" /> 失败
          </div>
          <div className="text-2xl font-semibold mt-1 text-destructive">{stats.failed}</div>
        </Card>
      </div>

      <div className="flex gap-2 mb-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索发件人、收件人、主题、订单..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-7 h-8 text-sm"
          />
        </div>
        {(["all", "sent", "failed"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={statusFilter === f ? "default" : "outline"}
            className="h-8 text-xs"
            onClick={() => setStatusFilter(f)}
          >
            {f === "all" ? "全部" : f === "sent" ? "成功" : "失败"}
          </Button>
        ))}
        <select className="h-8 rounded-md border bg-background px-2 text-xs" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">全部类型</option>
          {Object.entries(sendTypeMap).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="h-8 rounded-md border bg-background px-2 text-xs" value={fromFilter} onChange={(e) => setFromFilter(e.target.value)}>
          <option value="">全部发件邮箱</option>
          {fromOptions.map((from) => <option key={from} value={from}>{from}</option>)}
        </select>
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 w-36 text-xs" />
        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 w-36 text-xs" />
      </div>

      <Card className="flex-1 overflow-hidden flex flex-col min-h-0">
        <ScrollArea className="flex-1 min-h-0">
          <Table className="table-fixed w-full">
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead className="w-32">时间</TableHead>
                <TableHead className="w-36 min-w-[9rem]">类型</TableHead>
                <TableHead className="w-20">状态</TableHead>
                <TableHead>发件人</TableHead>
                <TableHead>人工账号</TableHead>
                <TableHead>收件人</TableHead>
                <TableHead>主题</TableHead>
                <TableHead className="w-20">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">{loading ? "加载中…" : "暂无记录"}</TableCell></TableRow>
              ) : logs.map((l) => {
                const t = sendTypeMap[l.send_type] ?? { label: l.send_type, cls: "" };
                return (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTimeCST(l.created_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap w-36 min-w-[9rem]">
                      <Badge variant="outline" className={`text-[10px] py-0 h-5 whitespace-nowrap ${t.cls}`}>{t.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {l.status === "sent" ? (
                        <Badge variant="outline" className="text-[10px] py-0 h-5 bg-success/15 text-success border-success/30">成功</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] py-0 h-5 bg-destructive/15 text-destructive border-destructive/30">失败</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm truncate max-w-[200px]">{l.from_email || "—"}</TableCell>
                    <TableCell className="text-sm truncate max-w-[180px]">{l.operator_label || "—"}</TableCell>
                    <TableCell className="text-sm truncate max-w-[200px]">{l.to_email}</TableCell>
                    <TableCell className="text-sm truncate max-w-[300px]">{l.subject || "(无主题)"}</TableCell>
                    <TableCell>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDetail(l)}>
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
        <TableListPagination
          page={listPageSafe}
          total={listTotal}
          loading={loading}
          onPageChange={setListPage}
        />
      </Card>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>发送详情</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><span className="text-muted-foreground">发件人：</span>{detail.from_email || "—"}</div>
                <div><span className="text-muted-foreground">收件人：</span>{detail.to_email}</div>
                {detail.send_type === "manual" && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">人工账号：</span>
                    {detail.operator_label || "—"}
                  </div>
                )}
                <div><span className="text-muted-foreground">类型：</span>{sendTypeMap[detail.send_type]?.label ?? detail.send_type}</div>
                <div><span className="text-muted-foreground">状态：</span>{detail.status === "sent" ? "成功" : "失败"}</div>
                <div className="col-span-2"><span className="text-muted-foreground">时间：</span>{formatDateTimeCST(detail.created_at)}</div>
                <div className="col-span-2"><span className="text-muted-foreground">Message-ID：</span><span className="font-mono text-xs">{detail.message_id || "—"}</span></div>
                <div><span className="text-muted-foreground">发送编号：</span>{detail.send_no || "—"}</div>
                <div><span className="text-muted-foreground">订单号：</span>{orderNoFromLog(detail) || "—"}</div>
                {templateCodeFromLog(detail) && (
                  <div><span className="text-muted-foreground">ERP 场景：</span>{templateCodeFromLog(detail)}</div>
                )}
                {siteCodeFromLog(detail) && (
                  <div><span className="text-muted-foreground">站点编码：</span>{siteCodeFromLog(detail)}</div>
                )}
                {siteNameFromLog(detail) && (
                  <div><span className="text-muted-foreground">站点名称：</span>{siteNameFromLog(detail)}</div>
                )}
                <div className="col-span-2"><span className="text-muted-foreground">SMTP响应：</span>{detail.smtp_response || "—"}</div>
              </div>
              <div>
                <div className="text-muted-foreground mb-1">主题</div>
                <div className="p-2 bg-muted/50 rounded">{detail.subject || "(无主题)"}</div>
              </div>
              {detail.content && (
                <div>
                  <div className="text-muted-foreground mb-1">正文</div>
                  <ScrollArea className="h-48">
                    <div className="p-2 bg-muted/50 rounded whitespace-pre-wrap text-xs">{detail.content}</div>
                  </ScrollArea>
                </div>
              )}
              {detail.error_message && (
                <div>
                  <div className="text-destructive mb-1">错误信息</div>
                  <div className="p-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive">{detail.error_message}</div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
