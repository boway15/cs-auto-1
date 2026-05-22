import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { TableListPagination } from "@/components/TableListPagination";
import { clampListPage, listPageCount, listPageRange } from "@/lib/list-pagination";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search, RefreshCw, BellRing, Settings } from "lucide-react";
import { toast } from "sonner";

/** 发件人选「未在库中指定」时写库为 NULL，发信端读环境变量 ALERT_SENDER_ADDRESS */
const OPS_ALERT_SENDER_USE_ENV = "__use_env__";

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
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [listPage, setListPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [severity, setSeverity] = useState<string>("all");
  const [status, setStatus] = useState<string>("open");

  const [configOpen, setConfigOpen] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [mailboxOptions, setMailboxOptions] = useState<{ email_address: string; display_name: string | null }[]>([]);
  const [senderSelect, setSenderSelect] = useState<string>(OPS_ALERT_SENDER_USE_ENV);
  const [recipientsInput, setRecipientsInput] = useState("");
  /** null = 尚未拉取；对象内 null 表示库中为 NULL（走环境变量） */
  const [opsSummary, setOpsSummary] = useState<{ sender: string | null; recipients: string | null } | null>(null);

  async function loadOpsAlertSummary() {
    if (!isAdmin) return;
    const { data, error } = await supabase
      .from("automation_settings")
      .select("ops_alert_sender_email, ops_alert_recipient_emails")
      .eq("singleton", "default")
      .maybeSingle();
    if (error) {
      if (error.message.includes("column") || error.code === "42703") {
        setOpsSummary(null);
        return;
      }
      console.warn("load ops alert summary:", error.message);
      setOpsSummary(null);
      return;
    }
    setOpsSummary({
      sender: data?.ops_alert_sender_email ?? null,
      recipients: data?.ops_alert_recipient_emails ?? null,
    });
  }

  async function openConfigDialog() {
    setConfigOpen(true);
    setConfigLoading(true);
    try {
      const [settingsRes, mailRes] = await Promise.all([
        supabase
          .from("automation_settings")
          .select("ops_alert_sender_email, ops_alert_recipient_emails")
          .eq("singleton", "default")
          .maybeSingle(),
        supabase.from("mailboxes").select("email_address, display_name").order("created_at", { ascending: false }),
      ]);
      if (settingsRes.error) {
        toast.error("读取配置失败：" + settingsRes.error.message);
        setConfigOpen(false);
        return;
      }
      if (mailRes.error) {
        toast.error("读取邮箱列表失败：" + mailRes.error.message);
      }
      setMailboxOptions((mailRes.data ?? []) as { email_address: string; display_name: string | null }[]);
      const s = settingsRes.data;
      setSenderSelect(s?.ops_alert_sender_email?.trim() ? s.ops_alert_sender_email.trim() : OPS_ALERT_SENDER_USE_ENV);
      setRecipientsInput(s?.ops_alert_recipient_emails ?? "");
    } finally {
      setConfigLoading(false);
    }
  }

  async function saveOpsAlertConfig() {
    const senderEmail = senderSelect === OPS_ALERT_SENDER_USE_ENV ? null : senderSelect.trim();
    if (senderEmail) {
      const ok = mailboxOptions.some((m) => m.email_address === senderEmail);
      if (!ok) {
        toast.error("发件邮箱须为已绑定的邮箱，请从下拉中选择");
        return;
      }
    }
    const recRaw = recipientsInput.trim();
    const recipientsDb = recRaw.length > 0 ? recipientsInput : null;

    setSavingConfig(true);
    const { error } = await supabase
      .from("automation_settings")
      .update({
        ops_alert_sender_email: senderEmail,
        ops_alert_recipient_emails: recipientsDb,
      } as never)
      .eq("singleton", "default");
    setSavingConfig(false);
    if (error) {
      toast.error("保存失败：" + error.message);
      return;
    }
    toast.success("告警通知配置已保存（Edge 约数秒内生效）");
    setConfigOpen(false);
    void loadOpsAlertSummary();
  }

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setListPage(0);
  }, [severity, status, searchDebounced]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase.from("ops_alerts").select("*", { count: "exact" });
      if (severity !== "all") query = query.eq("severity", severity);
      if (status !== "all") query = query.eq("status", status);
      if (searchDebounced) {
        const s = `%${searchDebounced}%`;
        query = query.or(
          `title.ilike.${s},message.ilike.${s},source.ilike.${s},idempotency_key.ilike.${s}`,
        );
      }
      const { from, to } = listPageRange(listPage);
      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(from, to);
      if (error) throw error;
      setRows((data ?? []) as AlertRow[]);
      setListTotal(count ?? 0);
    } catch (error) {
      const message = typeof error === "object" && error && "message" in error
        ? String((error as { message: string }).message)
        : "请稍后重试";
      toast.error("加载告警失败：" + message);
      setRows([]);
      setListTotal(0);
    } finally {
      setLoading(false);
    }
  }, [severity, status, searchDebounced, listPage]);

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

  useEffect(() => {
    void loadOpsAlertSummary();
  }, [isAdmin]);

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
    toast.success(targetStatus === "resolved" ? "已标记为已处理" : "已改回处理中");
    load();
  }

  return (
    <div className="h-screen flex flex-col">
      <div className="border-b p-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <BellRing className="w-4 h-4 shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold text-sm">运营告警</div>
            {isAdmin && opsSummary !== null && (
              <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                通知发件：
                {opsSummary.sender ? (
                  <span className="text-foreground/80">{opsSummary.sender}</span>
                ) : (
                  "未指定（环境变量 ALERT_SENDER_ADDRESS）"
                )}
                {" · "}
                收件：
                {opsSummary.recipients ? (
                  <span className="text-foreground/80">{opsSummary.recipients}</span>
                ) : (
                  "未指定（环境变量 ALERT_EMAIL_TO）"
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isAdmin && (
            <Button size="sm" variant="secondary" onClick={() => void openConfigDialog()}>
              <Settings className="w-3.5 h-3.5 mr-1" />
              告警通知配置
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </div>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>运营告警通知</DialogTitle>
            <DialogDescription>
              发件须为「邮箱配置」中已绑定且填写 SMTP 的账号；收件可填多个，英文逗号或分号分隔。留空发件或收件表示使用服务器环境变量（ALERT_SENDER_ADDRESS / ALERT_EMAIL_TO）。
            </DialogDescription>
          </DialogHeader>
          {configLoading ? (
            <div className="text-sm text-muted-foreground py-6 text-center">加载中…</div>
          ) : (
            <div className="space-y-4 py-1">
              <div className="space-y-2">
                <Label>发件邮箱</Label>
                <Select value={senderSelect} onValueChange={setSenderSelect}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="选择发件邮箱" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={OPS_ALERT_SENDER_USE_ENV}>未指定（环境变量 ALERT_SENDER_ADDRESS）</SelectItem>
                    {mailboxOptions.map((m) => (
                      <SelectItem key={m.email_address} value={m.email_address}>
                        {m.display_name ? `${m.display_name} · ` : ""}
                        {m.email_address}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ops-alert-recipients">收件邮箱</Label>
                <Input
                  id="ops-alert-recipients"
                  placeholder="a@x.com, b@y.com"
                  value={recipientsInput}
                  onChange={(e) => setRecipientsInput(e.target.value)}
                  className="h-9"
                />
                <p className="text-[11px] text-muted-foreground">多个地址请用英文逗号或分号分隔；留空则使用 ALERT_EMAIL_TO。</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfigOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void saveOpsAlertConfig()} disabled={configLoading || savingConfig}>
              {savingConfig ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            <SelectItem value="resolved">已处理</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <Card className="m-3 p-0 overflow-hidden flex flex-col">
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
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-10">
                    {loading ? "加载中…" : "暂无告警"}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row) => (
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
                      {row.status === "open" ? "待处理" : row.status === "acknowledged" ? "处理中" : row.status === "resolved" ? "已处理" : row.status}
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
                        标记已处理
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TableListPagination
            page={listPageSafe}
            total={listTotal}
            loading={loading}
            onPageChange={setListPage}
            className="rounded-b-lg"
          />
        </Card>
      </ScrollArea>
    </div>
  );
}
