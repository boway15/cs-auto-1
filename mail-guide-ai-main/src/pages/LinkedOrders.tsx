import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmailBody } from "@/components/EmailBody";
import { RefreshCw, Eye, Pencil } from "lucide-react";
import { toast } from "sonner";

const FETCH_LIMIT = 500;

type OrderRow = Record<string, unknown>;
type EmailRow = Record<string, unknown>;

export type LinkedOrderRow = {
  kind: "linked";
  link_id: string;
  link_created_at: string;
  link_source: string;
  link_metadata: unknown;
  link_confidence: number | null;
  link_created_by: string | null;
  order: OrderRow;
  email: EmailRow;
};

export type UnlinkedMailRow = {
  kind: "unlinked";
  email: EmailRow;
};

export type MailOrderDisplayRow = LinkedOrderRow | UnlinkedMailRow;

type AssociationMode = "all" | "linked" | "unlinked";
type InterceptFilter = "all" | "hold" | "none";

function keywordMatchLinked(row: LinkedOrderRow, kw: string): boolean {
  const t = kw.trim().toLowerCase();
  if (!t) return true;
  const o = row.order;
  const e = row.email;
  const fields = [
    String(o?.order_no ?? ""),
    String(o?.customer_email ?? ""),
    String(e?.message_id ?? ""),
    String(e?.from_email ?? ""),
  ];
  return fields.some((f) => f.toLowerCase().includes(t));
}

function keywordMatchUnlinked(email: EmailRow, kw: string): boolean {
  const t = kw.trim().toLowerCase();
  if (!t) return true;
  const fields = [
    String(email.message_id ?? ""),
    String(email.from_email ?? ""),
    String(email.subject ?? ""),
    String(email.body_text ?? "").slice(0, 2000),
  ];
  return fields.some((f) => f.toLowerCase().includes(t));
}

function interceptMatchLinked(row: LinkedOrderRow, f: InterceptFilter): boolean {
  if (f === "all") return true;
  const hold = Boolean(row.order?.shipping_hold);
  if (f === "hold") return hold;
  return !hold;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function orderDisplayAmount(order: OrderRow): string {
  const a = order.amount ?? order.total_amount ?? order.TotalAmount;
  if (a == null || a === "") return "—";
  const n = typeof a === "number" ? a : Number(a);
  if (Number.isFinite(n)) return String(n);
  return String(a);
}

function orderLineItems(order: OrderRow): unknown[] {
  if (Array.isArray(order.line_items)) return order.line_items;
  const rd = asRecord(order.raw_data);
  if (rd && Array.isArray(rd.line_items)) return rd.line_items;
  if (rd && Array.isArray(rd.LineItems)) return rd.LineItems as unknown[];
  return [];
}

function orderShippingAddress(order: OrderRow): unknown {
  if (order.shipping_address != null) return order.shipping_address;
  const rd = asRecord(order.raw_data);
  return rd?.shipping_address ?? rd?.ShippingAddress ?? null;
}

function fmtDateTime(v: unknown): string {
  if (v == null || String(v).trim() === "") return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN");
}

function OrderDetailScalar({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-0.5 items-start">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="break-words min-w-0">{value}</span>
    </div>
  );
}

function pickAddrField(r: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function ShippingAddressBlock({ value }: { value: unknown }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  if (typeof value === "string")
    return <div className="whitespace-pre-wrap break-words text-xs">{value}</div>;
  const r = asRecord(value);
  if (!r) return <span className="text-muted-foreground">—</span>;
  const rows: [string, string][] = [
    ["收件人", pickAddrField(r, ["name", "Name"])],
    ["地址行 1", pickAddrField(r, ["line1", "Line1", "address1", "Address1", "line_1"])],
    ["地址行 2", pickAddrField(r, ["line2", "Line2", "address2", "Address2", "line_2"])],
    ["城市", pickAddrField(r, ["city", "City"])],
    ["省/州", pickAddrField(r, ["state", "State", "province", "Province"])],
    ["邮编", pickAddrField(r, ["zip", "Zip", "postal_code", "PostalCode", "postalCode"])],
    ["国家", pickAddrField(r, ["country", "Country"])],
    ["电话", pickAddrField(r, ["phone", "Phone"])],
  ].filter(([, v]) => v.length > 0);
  if (rows.length === 0) {
    return <pre className="text-[11px] overflow-x-auto max-h-40 rounded bg-muted/50 p-2">{JSON.stringify(r, null, 2)}</pre>;
  }
  return (
    <div className="space-y-1 text-xs">
      {rows.map(([lab, val]) => (
        <div key={lab} className="grid grid-cols-[72px_1fr] gap-1">
          <span className="text-muted-foreground shrink-0">{lab}</span>
          <span className="break-words">{val}</span>
        </div>
      ))}
    </div>
  );
}

function OrderLineItemsTable({ items }: { items: unknown[] }) {
  if (items.length === 0) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-[10px] h-8 w-[100px]">SKU</TableHead>
            <TableHead className="text-[10px] h-8 min-w-[200px]">名称</TableHead>
            <TableHead className="text-[10px] h-8 w-[80px]">规格</TableHead>
            <TableHead className="text-[10px] h-8 w-[56px] text-right">数量</TableHead>
            <TableHead className="text-[10px] h-8 w-[80px] text-right">单价</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((raw, i) => {
            const li = asRecord(raw) ?? {};
            const sku = String(li.sku ?? li.Sku ?? "—");
            const name = String(li.name ?? li.title ?? li.Title ?? li.Name ?? "—");
            const variant = String(li.variant ?? li.Variant ?? "");
            const qty = li.quantity ?? li.Quantity ?? li.qty;
            const unit = li.unit_price ?? li.unitPrice ?? li.UnitPrice ?? li.price ?? li.Price;
            const qtyStr = qty == null ? "—" : String(qty);
            let unitStr = "—";
            if (typeof unit === "number" && Number.isFinite(unit)) unitStr = String(unit);
            else if (unit != null && String(unit).trim() !== "") {
              const n = Number(unit);
              unitStr = Number.isFinite(n) ? String(n) : String(unit);
            }
            return (
              <TableRow key={i}>
                <TableCell className="text-[11px] font-mono py-1.5">{sku}</TableCell>
                <TableCell className="text-[11px] py-1.5 break-words">{name}</TableCell>
                <TableCell className="text-[11px] py-1.5 text-muted-foreground">{variant || "—"}</TableCell>
                <TableCell className="text-[11px] py-1.5 text-right tabular-nums">{qtyStr}</TableCell>
                <TableCell className="text-[11px] py-1.5 text-right tabular-nums">{unitStr}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function optionalStr(order: OrderRow, key: string): string | null {
  const v = order[key];
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function safeJsonStringify(v: unknown, indent = 2): string {
  try {
    return JSON.stringify(v, null, indent);
  } catch {
    return String(v);
  }
}

/** 从 orders.raw_data 顶层挑出可能与拦截/风控相关的键，便于调证。 */
function extractInterceptRelatedFromRaw(raw: unknown): Record<string, unknown> | null {
  const r = asRecord(raw);
  if (!r) return null;
  const re =
    /hold|intercept|risk|block|fraud|flag|restriction|denylist|allowlist|sync.?error|fulfillment|shipping_hold|pause|stop|compliance|review|warning|violation/i;
  const pick: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (re.test(k)) pick[k] = v;
  }
  return Object.keys(pick).length > 0 ? pick : null;
}

type HoldLogRow = Record<string, unknown>;

function InterceptHoldDetailSection({ order, holdLogs }: { order: OrderRow; holdLogs: HoldLogRow[] }) {
  const hold = Boolean(order.shipping_hold);
  const excerpt = extractInterceptRelatedFromRaw(order.raw_data);
  const hasLogs = holdLogs.length > 0;

  return (
    <div>
      <h4 className="font-medium text-xs text-muted-foreground mb-2">拦截详情</h4>
      <Card
        className={`p-3 space-y-3 text-xs ${hold ? "border-destructive/50 bg-destructive/5" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground shrink-0">发货拦截状态</span>
          {hold ? (
            <Badge variant="destructive" className="text-[10px]">
              已拦截
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">
              未拦截
            </Badge>
          )}
        </div>

        <div className="space-y-2 pt-1 border-t border-border/50">
          <OrderDetailScalar label="暂停原因（hold_reason）" value={optionalStr(order, "hold_reason") ?? "—"} />
          <OrderDetailScalar label="暂停时间（hold_at）" value={fmtDateTime(order.hold_at)} />
          <OrderDetailScalar label="暂停操作人（hold_by）" value={optionalStr(order, "hold_by") ?? "—"} />
          <OrderDetailScalar label="shipping_hold（库字段）" value={hold ? "true" : "false"} />
        </div>

        {hasLogs && (
          <div className="space-y-1.5 pt-1 border-t border-border/50">
            <div className="text-[11px] font-medium text-muted-foreground">
              拦截/放行流水（order_hold_logs，数据记录）
            </div>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-[10px] h-8 whitespace-nowrap">时间</TableHead>
                    <TableHead className="text-[10px] h-8 w-[72px]">动作</TableHead>
                    <TableHead className="text-[10px] h-8">原因分类</TableHead>
                    <TableHead className="text-[10px] h-8 min-w-[120px]">原因</TableHead>
                    <TableHead className="text-[10px] h-8">操作人</TableHead>
                    <TableHead className="text-[10px] h-8 w-[56px] text-center">Shopify</TableHead>
                    <TableHead className="text-[10px] h-8 min-w-[100px]">同步错误</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {holdLogs.map((log, logIdx) => (
                    <TableRow key={String(log.id ?? `log-${logIdx}`)}>
                      <TableCell className="text-[10px] py-1.5 whitespace-nowrap tabular-nums">
                        {fmtDateTime(log.created_at)}
                      </TableCell>
                      <TableCell className="text-[10px] py-1.5 font-mono">{String(log.action ?? "—")}</TableCell>
                      <TableCell className="text-[10px] py-1.5">{String(log.reason_category ?? "—")}</TableCell>
                      <TableCell className="text-[10px] py-1.5 break-words max-w-[200px]">
                        {String(log.reason ?? "—")}
                      </TableCell>
                      <TableCell className="text-[10px] py-1.5 break-all">{String(log.performed_by ?? "—")}</TableCell>
                      <TableCell className="text-[10px] py-1.5 text-center">
                        {log.shopify_synced === true ? "是" : log.shopify_synced === false ? "否" : "—"}
                      </TableCell>
                      <TableCell className="text-[10px] py-1.5 break-words text-muted-foreground max-w-[180px]">
                        {String(log.shopify_sync_error ?? "—")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-[10px] text-muted-foreground m-0">
              每条记录对应一次拦截或放行等操作；字段含义以数据库 `order_hold_logs` 为准。
            </p>
          </div>
        )}

        {excerpt && (
          <div className="space-y-1.5 pt-1 border-t border-border/50">
            <div className="text-[11px] font-medium text-muted-foreground">
              orders.raw_data 中与拦截/风控相关的字段摘录
            </div>
            <pre className="max-h-44 overflow-auto rounded-md bg-muted/60 p-2 text-[10px] leading-relaxed">
              {safeJsonStringify(excerpt)}
            </pre>
          </div>
        )}

        {hold && order.raw_data != null && (
          <div className="space-y-1.5 pt-1 border-t border-border/50">
            <div className="text-[11px] font-medium text-muted-foreground">
              订单原始数据（orders.raw_data，用于拦截调证）
            </div>
            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                展开查看完整 JSON
              </summary>
              <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/60 p-2 text-[10px] leading-relaxed">
                {safeJsonStringify(order.raw_data)}
              </pre>
            </details>
          </div>
        )}

        {hold && order.raw_data == null && (
          <p className="text-[11px] text-muted-foreground m-0 pt-1 border-t border-border/50">
            当前订单未保存 raw_data，无法在拦截区块展示原始 JSON。
          </p>
        )}

        {!hold && !hasLogs && !excerpt && (
          <p className="text-[11px] text-muted-foreground m-0">
            当前未处于发货拦截，且无 order_hold_logs 流水、raw_data 中也未匹配到拦截相关键摘录。
          </p>
        )}
      </Card>
    </div>
  );
}

function LinkRecordDataSection({ row }: { row: LinkedOrderRow }) {
  return (
    <div>
      <h4 className="font-medium text-xs text-muted-foreground mb-2">关联记录（email_order_links）</h4>
      <Card className="p-3 space-y-2 text-xs">
        <OrderDetailScalar label="关联 ID" value={row.link_id} />
        <OrderDetailScalar label="关联时间" value={fmtDateTime(row.link_created_at)} />
        <OrderDetailScalar label="关联来源（link_source）" value={row.link_source || "—"} />
        <OrderDetailScalar
          label="置信度（confidence）"
          value={row.link_confidence != null ? String(row.link_confidence) : "—"}
        />
        <OrderDetailScalar label="创建人（created_by）" value={row.link_created_by ?? "—"} />
        <div className="grid grid-cols-[100px_1fr] gap-x-2 items-start pt-1 border-t border-border/60">
          <span className="text-muted-foreground shrink-0 pt-0.5">metadata</span>
          <pre className="text-[10px] max-h-40 overflow-auto rounded-md bg-muted/60 p-2 m-0 leading-relaxed">
            {row.link_metadata != null ? safeJsonStringify(row.link_metadata) : "—"}
          </pre>
        </div>
        <p className="text-[10px] text-muted-foreground m-0">
          上表为邮件与订单关联行的库字段；业务扩展信息可写入 metadata。
        </p>
      </Card>
    </div>
  );
}

export default function LinkedOrders() {
  const [loading, setLoading] = useState(true);
  const [linkedRows, setLinkedRows] = useState<LinkedOrderRow[]>([]);
  const [unlinkedEmails, setUnlinkedEmails] = useState<EmailRow[]>([]);

  const [associationMode, setAssociationMode] = useState<AssociationMode>("linked");
  const [interceptFilter, setInterceptFilter] = useState<InterceptFilter>("all");
  const [keyword, setKeyword] = useState("");

  const [detailRow, setDetailRow] = useState<MailOrderDisplayRow | null>(null);
  const [holdLogs, setHoldLogs] = useState<HoldLogRow[]>([]);
  const [orderEditOpen, setOrderEditOpen] = useState(false);
  const [editOrder, setEditOrder] = useState<OrderRow | null>(null);
  const [editCustomerName, setEditCustomerName] = useState("");
  const [editOrderStatus, setEditOrderStatus] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: idRows, error: idErr } = await supabase.from("email_order_links").select("email_id");
      if (idErr) throw idErr;
      const linkedEmailIdSet = new Set(
        (idRows ?? []).map((r) => r.email_id as string).filter(Boolean),
      );

      const { data: linksData, error: linkErr } = await supabase
        .from("email_order_links")
        .select("id, created_at, link_source, metadata, confidence, created_by, orders(*), emails(*)")
        .order("created_at", { ascending: false })
        .limit(FETCH_LIMIT);
      if (linkErr) throw linkErr;

      const parsed: LinkedOrderRow[] = [];
      for (const row of linksData ?? []) {
        const o = row.orders as OrderRow | null;
        const em = row.emails as EmailRow | null;
        if (o && em && row.id) {
          const c = row.confidence;
          let link_confidence: number | null = null;
          if (typeof c === "number" && Number.isFinite(c)) link_confidence = c;
          else if (c != null && String(c).trim() !== "") {
            const n = Number(c);
            if (Number.isFinite(n)) link_confidence = n;
          }
          parsed.push({
            kind: "linked",
            link_id: row.id as string,
            link_created_at: String(row.created_at ?? ""),
            link_source: String(row.link_source ?? ""),
            link_metadata: row.metadata ?? null,
            link_confidence,
            link_created_by: row.created_by != null ? String(row.created_by) : null,
            order: o,
            email: em,
          });
        }
      }
      setLinkedRows(parsed);

      const { data: emailsData, error: emErr } = await supabase
        .from("emails")
        .select("id, message_id, from_email, from_name, subject, body_text, received_at, status, to_email")
        .order("received_at", { ascending: false })
        .limit(FETCH_LIMIT);
      if (emErr) throw emErr;
      const unlinked = (emailsData ?? []).filter((em) => em.id && !linkedEmailIdSet.has(String(em.id)));
      setUnlinkedEmails(unlinked);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!detailRow || detailRow.kind !== "linked") {
      setHoldLogs([]);
      return;
    }
    const oid = detailRow.order.id;
    if (oid == null || String(oid).trim() === "") {
      setHoldLogs([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("order_hold_logs")
        .select(
          "id, created_at, action, reason, reason_category, performed_by, email_id, shopify_synced, shopify_sync_error",
        )
        .eq("order_id", String(oid))
        .order("created_at", { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) {
        setHoldLogs([]);
        return;
      }
      setHoldLogs((data ?? []) as HoldLogRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [detailRow]);

  const linkedFiltered = useMemo(() => {
    return linkedRows.filter(
      (r) => keywordMatchLinked(r, keyword) && interceptMatchLinked(r, interceptFilter),
    );
  }, [linkedRows, keyword, interceptFilter]);

  const unlinkedFiltered = useMemo(() => {
    return unlinkedEmails.filter((em) => keywordMatchUnlinked(em, keyword));
  }, [unlinkedEmails, keyword]);

  const displayRows = useMemo((): MailOrderDisplayRow[] => {
    if (associationMode === "linked") return linkedFiltered;
    if (associationMode === "unlinked") {
      return unlinkedFiltered.map((email) => ({ kind: "unlinked" as const, email }));
    }
    const unlinkedAsRows: UnlinkedMailRow[] = unlinkedFiltered.map((email) => ({
      kind: "unlinked",
      email,
    }));
    return [...linkedFiltered, ...unlinkedAsRows];
  }, [associationMode, linkedFiltered, unlinkedFiltered]);

  const showAssocColumn = associationMode === "all";
  const tableColSpan = showAssocColumn ? 8 : 7;

  function openEditOrder(order: OrderRow) {
    setEditOrder(order);
    setEditCustomerName(String(order.customer_name ?? ""));
    setEditOrderStatus(String(order.order_status ?? ""));
    setOrderEditOpen(true);
  }

  async function saveOrderEdit() {
    if (!editOrder?.id) return;
    setEditSaving(true);
    const { error } = await supabase
      .from("orders")
      .update({
        customer_name: editCustomerName.trim() || null,
        order_status: editOrderStatus.trim() || null,
      })
      .eq("id", String(editOrder.id));
    setEditSaving(false);
    if (error) {
      const msg = error.message ?? "";
      if (/permission|policy|rls|42501/i.test(msg)) {
        toast.error("无权限：需要 admin / leader / agent 角色才能更新订单");
      } else {
        toast.error(msg);
      }
      return;
    }
    toast.success("订单信息已更新");
    setOrderEditOpen(false);
    setEditOrder(null);
    void load();
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="border-b bg-card px-4 py-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">邮件订单</h1>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-3xl">
              已关联列表最多 {FETCH_LIMIT} 条；未关联邮件在「排除已有 email_order_links 的 email_id」后从最近邮件中取最多 {FETCH_LIMIT} 条。
              {associationMode === "all" && (
                <span className="block mt-1">
                  「是否拦截」筛选仅作用于<strong>已关联</strong>行；未关联行始终展示。
                </span>
              )}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      </div>

      <div className="p-4 border-b bg-muted/20 shrink-0 flex flex-wrap gap-2 items-end">
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground block">是否关联订单</label>
          <Select value={associationMode} onValueChange={(v) => setAssociationMode(v as AssociationMode)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="linked">仅已关联</SelectItem>
              <SelectItem value="unlinked">仅未关联</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground block">是否拦截</label>
          <Select
            value={interceptFilter}
            onValueChange={(v) => setInterceptFilter(v as InterceptFilter)}
            disabled={associationMode === "unlinked"}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="hold">已拦截</SelectItem>
              <SelectItem value="none">未拦截</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 flex-1 min-w-[200px] max-w-md">
          <label className="text-[10px] text-muted-foreground block">关键词</label>
          <Input
            className="h-8 text-xs"
            placeholder={
              associationMode === "unlinked"
                ? "Message-ID、发件邮箱、主题、正文…"
                : "Message-ID、发件邮箱、订单号、订单邮箱…"
            }
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  {showAssocColumn && <TableHead className="w-[88px] text-xs">关联订单</TableHead>}
                  <TableHead className="text-xs">订单编号</TableHead>
                  <TableHead className="text-xs">订单邮箱</TableHead>
                  <TableHead className="w-[72px] text-xs">是否拦截</TableHead>
                  <TableHead className="text-xs min-w-[180px]">Message-ID</TableHead>
                  <TableHead className="text-xs">发件邮箱</TableHead>
                  <TableHead className="w-[152px] text-xs whitespace-nowrap">关联时间</TableHead>
                  <TableHead className="w-[140px] text-xs text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={tableColSpan} className="text-center text-muted-foreground text-sm py-10">
                      加载中…
                    </TableCell>
                  </TableRow>
                ) : displayRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={tableColSpan} className="text-center text-muted-foreground text-sm py-10">
                      无匹配数据
                    </TableCell>
                  </TableRow>
                ) : (
                  displayRows.map((row, idx) => {
                    const key =
                      row.kind === "linked"
                        ? `l-${row.link_id}`
                        : `u-${String(row.email.id ?? idx)}`;
                    const orderNo = row.kind === "linked" ? String(row.order.order_no ?? "—") : "—";
                    const custEmail = row.kind === "linked" ? String(row.order.customer_email ?? "—") : "—";
                    const hold =
                      row.kind === "linked" ? Boolean(row.order.shipping_hold) : null;
                    const msgId = String(row.email.message_id ?? "—");
                    const fromEm = String(row.email.from_email ?? "—");
                    return (
                      <TableRow key={key}>
                        {showAssocColumn && (
                          <TableCell className="text-xs">
                            <Badge variant={row.kind === "linked" ? "default" : "secondary"} className="text-[10px]">
                              {row.kind === "linked" ? "是" : "否"}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell className="text-xs font-medium">{orderNo}</TableCell>
                        <TableCell className="text-xs max-w-[160px] truncate" title={custEmail}>
                          {custEmail}
                        </TableCell>
                        <TableCell className="text-xs">
                          {row.kind === "linked" ? (
                            hold ? (
                              <Badge variant="outline" className="text-[10px] border-warning text-warning">
                                是
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">否</span>
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs font-mono break-all max-w-[240px]" title={msgId}>
                          {msgId}
                        </TableCell>
                        <TableCell className="text-xs max-w-[180px] truncate" title={fromEm}>
                          {fromEm}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap tabular-nums" title={row.kind === "linked" ? row.link_created_at : undefined}>
                          {row.kind === "linked" ? fmtDateTime(row.link_created_at) : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1 flex-wrap">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 text-[11px]"
                              onClick={() => setDetailRow(row)}
                            >
                              <Eye className="w-3 h-3 mr-1" />
                              详情
                            </Button>
                            {row.kind === "linked" && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[11px]"
                                onClick={() => openEditOrder(row.order)}
                              >
                                <Pencil className="w-3 h-3 mr-1" />
                                更新订单
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      </ScrollArea>

      <Dialog open={!!detailRow} onOpenChange={(o) => !o && setDetailRow(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>详情</DialogTitle>
          </DialogHeader>
          {detailRow && (
            <div className="space-y-4 text-sm">
              {detailRow.kind === "linked" && (
                <div className="space-y-4">
                  <div>
                    <h4 className="font-medium text-xs text-muted-foreground mb-2">订单信息</h4>
                    <Card className="p-3 space-y-3 text-xs">
                    <div className="space-y-2">
                      <OrderDetailScalar label="订单号" value={String(detailRow.order.order_no ?? "—")} />
                      <OrderDetailScalar label="订单邮箱" value={String(detailRow.order.customer_email ?? "—")} />
                      <OrderDetailScalar label="客户姓名" value={String(detailRow.order.customer_name ?? "—")} />
                      <OrderDetailScalar label="订单状态" value={String(detailRow.order.order_status ?? "—")} />
                      <OrderDetailScalar label="物流状态" value={String(detailRow.order.shipping_status ?? "—")} />
                      <OrderDetailScalar label="运单号" value={String(detailRow.order.tracking_no ?? "—")} />
                      <OrderDetailScalar
                        label="下单时间"
                        value={fmtDateTime(detailRow.order.ordered_at)}
                      />
                      <OrderDetailScalar
                        label="金额 / 币种"
                        value={`${orderDisplayAmount(detailRow.order)} ${String(detailRow.order.currency ?? "").trim()}`.trim()}
                      />
                      {optionalStr(detailRow.order, "financial_status") && (
                        <OrderDetailScalar label="财务状态" value={optionalStr(detailRow.order, "financial_status")!} />
                      )}
                      {optionalStr(detailRow.order, "fulfillment_status") && (
                        <OrderDetailScalar
                          label="履约状态"
                          value={optionalStr(detailRow.order, "fulfillment_status")!}
                        />
                      )}
                      <p className="text-[10px] text-muted-foreground m-0 pt-1 border-t border-border/60">
                        发货拦截、暂停原因/时间/操作人及调证用 raw_data 见下方<strong>拦截详情</strong>。
                      </p>
                      {optionalStr(detailRow.order, "shopify_tags") && (
                        <OrderDetailScalar label="店铺标签" value={optionalStr(detailRow.order, "shopify_tags")!} />
                      )}
                      <div className="grid grid-cols-[100px_1fr] gap-x-2 gap-y-1 items-start pt-1 border-t border-border/60">
                        <span className="text-muted-foreground shrink-0 pt-0.5">商品摘要</span>
                        <p className="text-xs break-words whitespace-pre-wrap min-w-0 m-0">
                          {String(detailRow.order.product_summary ?? "—")}
                        </p>
                      </div>
                      <div className="grid grid-cols-[100px_1fr] gap-x-2 items-start pt-1 border-t border-border/60">
                        <span className="text-muted-foreground shrink-0 pt-0.5">收货地址</span>
                        <ShippingAddressBlock value={orderShippingAddress(detailRow.order)} />
                      </div>
                      <div className="pt-1 border-t border-border/60 space-y-1.5">
                        <div className="text-muted-foreground">订单行（line_items）</div>
                        <OrderLineItemsTable items={orderLineItems(detailRow.order)} />
                      </div>
                      {(detailRow.order.created_at != null || detailRow.order.updated_at != null) && (
                        <div className="text-[11px] text-muted-foreground space-y-0.5">
                          {detailRow.order.created_at != null && (
                            <div>记录创建：{fmtDateTime(detailRow.order.created_at)}</div>
                          )}
                          {detailRow.order.updated_at != null && (
                            <div>记录更新：{fmtDateTime(detailRow.order.updated_at)}</div>
                          )}
                        </div>
                      )}
                      {detailRow.order.raw_data != null && (
                        <details className="text-[11px]">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                            原始数据（raw_data，JSON）
                          </summary>
                          <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted/60 p-2 text-[10px] leading-relaxed">
                            {(() => {
                              try {
                                return JSON.stringify(detailRow.order.raw_data, null, 2);
                              } catch {
                                return String(detailRow.order.raw_data);
                              }
                            })()}
                          </pre>
                        </details>
                      )}
                    </div>
                  </Card>
                  </div>
                  <InterceptHoldDetailSection order={detailRow.order} holdLogs={holdLogs} />
                  <LinkRecordDataSection row={detailRow} />
                </div>
              )}
              {detailRow.kind === "unlinked" && (
                <Card className="p-3 text-xs text-muted-foreground border-dashed">该邮件尚未关联订单</Card>
              )}
              <div>
                <h4 className="font-medium text-xs text-muted-foreground mb-2">邮件信息</h4>
                <Card className="p-3 space-y-1.5 text-xs">
                  <div>
                    <span className="text-muted-foreground">主题：</span>
                    {String(detailRow.email.subject ?? "—")}
                  </div>
                  <div>
                    <span className="text-muted-foreground">发件人：</span>
                    {String(detailRow.email.from_name ?? "")} &lt;{String(detailRow.email.from_email ?? "—")}&gt;
                  </div>
                  <div>
                    <span className="text-muted-foreground">收件人：</span>
                    {String(detailRow.email.to_email ?? "—")}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Message-ID：</span>
                    <span className="font-mono break-all">{String(detailRow.email.message_id ?? "—")}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">时间：</span>
                    {detailRow.email.received_at
                      ? new Date(String(detailRow.email.received_at)).toLocaleString("zh-CN")
                      : "—"}
                  </div>
                  <div>
                    <span className="text-muted-foreground">状态：</span>
                    {String(detailRow.email.status ?? "—")}
                  </div>
                  <div className="pt-2 border-t">
                    <div className="text-muted-foreground mb-1">正文</div>
                    <EmailBody content={String(detailRow.email.body_text ?? "")} className="text-xs max-h-48 overflow-y-auto" />
                  </div>
                </Card>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailRow(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={orderEditOpen}
        onOpenChange={(open) => {
          if (!open) {
            setOrderEditOpen(false);
            setEditOrder(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>更新订单信息 · {editOrder ? String(editOrder.order_no ?? "") : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">客户姓名</label>
              <Input value={editCustomerName} onChange={(e) => setEditCustomerName(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">订单状态</label>
              <Input value={editOrderStatus} onChange={(e) => setEditOrderStatus(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOrderEditOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void saveOrderEdit()} disabled={editSaving}>
              {editSaving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
