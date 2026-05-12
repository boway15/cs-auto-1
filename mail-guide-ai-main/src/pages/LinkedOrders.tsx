import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { invokeGetOrderByEmail } from "@/lib/invoke-get-order-by-email";
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
import { RefreshCw, Eye } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";

const FETCH_LIMIT = 500;
const RISK_LOG_CHUNK = 100;

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

type AssociationMode = "all" | "linked" | "unlinked" | "parsed_unlinked";
type InterceptFilter = "all" | "hold" | "none";

type RiskLogBrief = {
  action: string;
  status: string;
  created_at: string;
  referenced_order_no: string | null;
  intercept_no: string;
};

/** 从 AI 分析写入的 ai_entities 取解析单号（与 process-email 写入结构一致） */
function parsedOrderNoFromEmail(email: EmailRow | null | undefined): string {
  if (!email) return "";
  const ent = asRecord(email.ai_entities);
  const raw = ent?.order_no;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw != null && typeof raw !== "object") {
    const s = String(raw).trim();
    return s || "";
  }
  return "";
}

function normalizeOrderNo(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * 按时间倒序：最近一条 release 成功 → 已放行；最近 hold 成功 → ERP 已拦截；
 * 最近 hold 仍为 pending → 拦截请求处理中（与 success 区分，避免列表误显示「拦截中」）。
 */
function riskInterceptOutcomeFromLogs(logs: RiskLogBrief[]): "hold" | "released" | "pending_hold" | "none" {
  const sorted = [...logs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  for (const l of sorted) {
    if (l.action === "release" && l.status === "success") return "released";
    if (l.action === "hold" && l.status === "success") return "hold";
    if (l.action === "hold" && l.status === "pending") return "pending_hold";
  }
  return "none";
}

/** 与 riskInterceptStateFromLogs 一致：pending 不算已落定状态 */
function riskInterceptStateFromLogs(logs: RiskLogBrief[]): "hold" | "released" | "none" {
  const o = riskInterceptOutcomeFromLogs(logs);
  if (o === "released") return "released";
  if (o === "hold") return "hold";
  return "none";
}

function isActivelyIntercepted(args: {
  shippingHold: boolean;
  riskLogs: RiskLogBrief[];
}): boolean {
  if (args.shippingHold) return true;
  const o = riskInterceptOutcomeFromLogs(args.riskLogs);
  return o === "hold" || o === "pending_hold";
}

function orderNoMatchBadge(parsed: string, linked: string): { label: string; variant: "default" | "secondary" | "outline" } | null {
  const p = normalizeOrderNo(parsed);
  const l = normalizeOrderNo(linked);
  if (!p && !l) return null;
  if (p && l) {
    if (p === l) return { label: "一致", variant: "secondary" };
    return { label: "不一致", variant: "outline" };
  }
  if (p && !l) return { label: "仅解析", variant: "outline" };
  return { label: "仅关联", variant: "secondary" };
}

function chunkIds<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function keywordMatchLinked(row: LinkedOrderRow, kw: string): boolean {
  const t = kw.trim().toLowerCase();
  if (!t) return true;
  const o = row.order;
  const e = row.email;
  const parsed = parsedOrderNoFromEmail(e);
  const fields = [
    String(o?.order_no ?? ""),
    String(o?.customer_email ?? ""),
    String(e?.message_id ?? ""),
    String(e?.from_email ?? ""),
    parsed,
  ];
  return fields.some((f) => f.toLowerCase().includes(t));
}

function keywordMatchUnlinked(email: EmailRow, kw: string): boolean {
  const t = kw.trim().toLowerCase();
  if (!t) return true;
  const parsed = parsedOrderNoFromEmail(email);
  const fields = [
    String(email.message_id ?? ""),
    String(email.from_email ?? ""),
    String(email.subject ?? ""),
    String(email.body_text ?? "").slice(0, 2000),
    parsed,
  ];
  return fields.some((f) => f.toLowerCase().includes(t));
}

function interceptMatchRow(args: {
  kind: "linked" | "unlinked";
  shippingHold: boolean;
  riskLogs: RiskLogBrief[];
  f: InterceptFilter;
}): boolean {
  if (args.f === "all") return true;
  const active = isActivelyIntercepted({ shippingHold: args.shippingHold, riskLogs: args.riskLogs });
  if (args.f === "hold") return active;
  return !active;
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
                      <TableCell className="text-[10px] py-1.5 min-w-0 max-w-[min(55vw,28rem)] break-words break-all">
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

type DetailRiskRow = Record<string, unknown>;

function MailRiskLogsSection({ rows }: { rows: DetailRiskRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground m-0">
        暂无该邮件的风控拦截记录（<span className="font-mono">risk_intercept_logs</span>）。凭邮件单号拦截且未关联本地订单时，记录在此而不会出现在上方「发货拦截」区块。
      </p>
    );
  }
  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="text-[10px] h-8 whitespace-nowrap">时间</TableHead>
            <TableHead className="text-[10px] h-8">编号</TableHead>
            <TableHead className="text-[10px] h-8 w-[56px]">动作</TableHead>
            <TableHead className="text-[10px] h-8 w-[72px]">状态</TableHead>
            <TableHead className="text-[10px] h-8">引用单号</TableHead>
            <TableHead className="text-[10px] h-8 min-w-[120px]">原因</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((log, logIdx) => (
            <TableRow key={String(log.id ?? `r-${logIdx}`)}>
              <TableCell className="text-[10px] py-1.5 whitespace-nowrap tabular-nums">
                {fmtDateTime(log.created_at)}
              </TableCell>
              <TableCell className="text-[10px] py-1.5 font-mono">{String(log.intercept_no ?? "—")}</TableCell>
              <TableCell className="text-[10px] py-1.5 font-mono">{String(log.action ?? "—")}</TableCell>
              <TableCell className="text-[10px] py-1.5">{String(log.status ?? "—")}</TableCell>
              <TableCell className="text-[10px] py-1.5 font-mono break-all max-w-[140px]">
                {log.referenced_order_no != null && String(log.referenced_order_no).trim()
                  ? String(log.referenced_order_no)
                  : "—"}
              </TableCell>
              <TableCell className="text-[10px] py-1.5 min-w-0 max-w-[min(55vw,28rem)] break-words break-all">
                {String(log.intercept_reason ?? "—")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-[10px] text-muted-foreground mt-2 m-0">
        完整审计见{" "}
        <Link to="/risk-logs" className="underline underline-offset-2 text-foreground">
          风控拦截记录
        </Link>
        。
      </p>
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
  const [riskLogsByEmailId, setRiskLogsByEmailId] = useState<Record<string, RiskLogBrief[]>>({});

  const [associationMode, setAssociationMode] = useState<AssociationMode>("all");
  const [interceptFilter, setInterceptFilter] = useState<InterceptFilter>("all");
  const [keyword, setKeyword] = useState("");

  const [detailRow, setDetailRow] = useState<MailOrderDisplayRow | null>(null);
  const [holdLogs, setHoldLogs] = useState<HoldLogRow[]>([]);
  const [detailRiskLogs, setDetailRiskLogs] = useState<DetailRiskRow[]>([]);
  const [orderRefreshId, setOrderRefreshId] = useState<string | null>(null);

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
        .select(
          "id, message_id, from_email, from_name, subject, body_text, received_at, status, to_email, ai_entities, association_status",
        )
        .order("received_at", { ascending: false })
        .limit(FETCH_LIMIT);
      if (emErr) throw emErr;
      const unlinked = (emailsData ?? []).filter((em) => em.id && !linkedEmailIdSet.has(String(em.id)));
      setUnlinkedEmails(unlinked);

      const emailIdSet = new Set<string>();
      for (const r of parsed) {
        if (r.email?.id) emailIdSet.add(String(r.email.id));
      }
      for (const em of unlinked) {
        if (em.id) emailIdSet.add(String(em.id));
      }
      const emailIds = [...emailIdSet];
      const byEmail: Record<string, RiskLogBrief[]> = {};
      for (const part of chunkIds(emailIds, RISK_LOG_CHUNK)) {
        if (part.length === 0) continue;
        const { data: riskData, error: riskErr } = await supabase
          .from("risk_intercept_logs")
          .select("email_id, action, status, created_at, referenced_order_no, intercept_no")
          .in("email_id", part);
        if (riskErr) {
          console.warn("risk_intercept_logs:", riskErr.message);
          continue;
        }
        for (const row of riskData ?? []) {
          const eid = row.email_id != null ? String(row.email_id) : "";
          if (!eid) continue;
          if (!byEmail[eid]) byEmail[eid] = [];
          byEmail[eid].push({
            action: String(row.action ?? ""),
            status: String(row.status ?? ""),
            created_at: String(row.created_at ?? ""),
            referenced_order_no: row.referenced_order_no != null ? String(row.referenced_order_no) : null,
            intercept_no: String(row.intercept_no ?? ""),
          });
        }
      }
      setRiskLogsByEmailId(byEmail);
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

  useEffect(() => {
    if (!detailRow?.email?.id) {
      setDetailRiskLogs([]);
      return;
    }
    const id = String(detailRow.email.id);
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("risk_intercept_logs")
        .select(
          "id, intercept_no, action, status, created_at, referenced_order_no, intercept_reason, order_id, error_message, erp_response",
        )
        .eq("email_id", id)
        .order("created_at", { ascending: false })
        .limit(40);
      if (cancelled) return;
      if (error) {
        setDetailRiskLogs([]);
        return;
      }
      setDetailRiskLogs((data ?? []) as DetailRiskRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [detailRow]);

  const linkedFiltered = useMemo(() => {
    return linkedRows.filter((r) => {
      if (!keywordMatchLinked(r, keyword)) return false;
      const logs = riskLogsByEmailId[String(r.email.id)] ?? [];
      return interceptMatchRow({
        kind: "linked",
        shippingHold: Boolean(r.order.shipping_hold),
        riskLogs: logs,
        f: interceptFilter,
      });
    });
  }, [linkedRows, keyword, interceptFilter, riskLogsByEmailId]);

  const unlinkedKeyword = useMemo(() => {
    return unlinkedEmails.filter((em) => keywordMatchUnlinked(em, keyword));
  }, [unlinkedEmails, keyword]);

  const unlinkedAfterRiskFilter = useMemo(() => {
    return unlinkedKeyword.filter((em) => {
      const logs = riskLogsByEmailId[String(em.id)] ?? [];
      return interceptMatchRow({
        kind: "unlinked",
        shippingHold: false,
        riskLogs: logs,
        f: interceptFilter,
      });
    });
  }, [unlinkedKeyword, riskLogsByEmailId, interceptFilter]);

  const unlinkedForDisplay = useMemo(() => {
    if (associationMode !== "parsed_unlinked") return unlinkedAfterRiskFilter;
    return unlinkedAfterRiskFilter.filter((em) => parsedOrderNoFromEmail(em));
  }, [associationMode, unlinkedAfterRiskFilter]);

  const displayRows = useMemo((): MailOrderDisplayRow[] => {
    if (associationMode === "linked") return linkedFiltered;
    if (associationMode === "unlinked" || associationMode === "parsed_unlinked") {
      return unlinkedForDisplay.map((email) => ({ kind: "unlinked" as const, email }));
    }
    const unlinkedAsRows: UnlinkedMailRow[] = unlinkedForDisplay.map((email) => ({
      kind: "unlinked",
      email,
    }));
    return [...linkedFiltered, ...unlinkedAsRows];
  }, [associationMode, linkedFiltered, unlinkedForDisplay]);

  const showAssocColumn = associationMode === "all";
  const tableColSpan = showAssocColumn ? 11 : 10;

  async function refreshLinkedOrder(order: OrderRow) {
    const id = String(order.id ?? "").trim();
    const orderNo = String(order.order_no ?? "").trim();
    if (!id) return;
    if (!orderNo) {
      toast.error("缺少订单号，无法更新订单信息");
      return;
    }
    setOrderRefreshId(id);
    try {
      const r = await invokeGetOrderByEmail(orderNo, String(order.customer_email ?? "").trim(), { refresh: true });
      if (r.kind === "auth") {
        toast.error("请先登录");
        return;
      }
      if (r.kind === "bad_request") {
        toast.error(r.message);
        return;
      }
      if (r.kind === "error") {
        toast.error(r.message);
        return;
      }
      if (r.kind === "not_found") {
        toast.message("未查到可更新订单", { description: r.description });
        return;
      }
      toast.success(
        r.source === "erp_oms"
          ? "订单查询成功，本地订单信息已更新为最新"
          : "未走 OMS 或本次为本地命中；已按当前数据源刷新展示（可检查 ERP_* 配置）",
      );
      await load();
      const { data: fresh } = await supabase.from("orders").select("*").eq("id", id).maybeSingle();
      if (fresh) {
        setDetailRow((prev) => {
          if (!prev || prev.kind !== "linked") return prev;
          if (String(prev.order.id) !== id) return prev;
          return { ...prev, order: fresh as OrderRow };
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新失败");
    } finally {
      setOrderRefreshId(null);
    }
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <div className="border-b bg-card px-4 py-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">邮件订单</h1>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-3xl">
              已关联列表最多 {FETCH_LIMIT} 条；未关联邮件在排除已有 <span className="font-mono">email_order_links</span>{" "}
              后从最近邮件取最多 {FETCH_LIMIT} 条。列表展示<strong>解析单号</strong>（
              <span className="font-mono">ai_entities.order_no</span>）与<strong>关联订单号</strong>；「是否拦截」含本地{" "}
              <span className="font-mono">shipping_hold</span> 与该邮件在{" "}
              <span className="font-mono">risk_intercept_logs</span> 中最近的 hold/release 成功记录。
              {associationMode === "all" && (
                <span className="block mt-1">
                  「全部」模式下同时列出已关联与未关联行；筛选「是否拦截」对两类行均生效。
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
            <SelectTrigger className="h-8 w-[168px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="linked">仅已关联</SelectItem>
              <SelectItem value="unlinked">仅未关联</SelectItem>
              <SelectItem value="parsed_unlinked">有解析单号·未关联</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground block">是否拦截</label>
          <Select
            value={interceptFilter}
            onValueChange={(v) => setInterceptFilter(v as InterceptFilter)}
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
              associationMode === "linked"
                ? "Message-ID、发件邮箱、解析/关联订单号、订单邮箱…"
                : "Message-ID、发件、主题、正文、解析单号…"
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
                  <TableHead className="text-xs min-w-[120px]">发件邮箱</TableHead>
                  <TableHead className="text-xs min-w-[160px]">Message-ID</TableHead>
                  {showAssocColumn && <TableHead className="w-[80px] text-xs">关联订单</TableHead>}
                  <TableHead className="text-xs min-w-[100px]">解析单号</TableHead>
                  <TableHead className="text-xs min-w-[100px]">关联订单号</TableHead>
                  <TableHead className="w-[72px] text-xs">对比</TableHead>
                  <TableHead className="text-xs">订单邮箱</TableHead>
                  <TableHead className="w-[88px] text-xs">拦截</TableHead>
                  <TableHead className="w-[140px] text-xs whitespace-nowrap">关联时间</TableHead>
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
                    const eid = String(row.email.id ?? "");
                    const riskLogs = riskLogsByEmailId[eid] ?? [];
                    const parsed = parsedOrderNoFromEmail(row.email);
                    const linkedNo =
                      row.kind === "linked" ? String(row.order.order_no ?? "").trim() : "";
                    const match = orderNoMatchBadge(parsed, linkedNo);
                    const shippingHold = row.kind === "linked" ? Boolean(row.order.shipping_hold) : false;
                    const riskOutcome = riskInterceptOutcomeFromLogs(riskLogs);
                    const activeIntercept = isActivelyIntercepted({ shippingHold, riskLogs });
                    const riskState = riskInterceptStateFromLogs(riskLogs);
                    const listInterceptPending =
                      activeIntercept && !shippingHold && riskOutcome === "pending_hold";
                    const custEmail = row.kind === "linked" ? String(row.order.customer_email ?? "—") : "—";
                    const msgId = String(row.email.message_id ?? "—");
                    const fromEm = String(row.email.from_email ?? "—");
                    return (
                      <TableRow key={key}>
                        <TableCell className="text-xs max-w-[180px] truncate" title={fromEm}>
                          {fromEm}
                        </TableCell>
                        <TableCell className="text-xs font-mono break-all max-w-[200px]" title={msgId}>
                          {msgId}
                        </TableCell>
                        {showAssocColumn && (
                          <TableCell className="text-xs">
                            <Badge variant={row.kind === "linked" ? "default" : "secondary"} className="text-[10px]">
                              {row.kind === "linked" ? "是" : "否"}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell className="text-xs font-mono max-w-[120px] truncate" title={parsed || undefined}>
                          {parsed || "—"}
                        </TableCell>
                        <TableCell className="text-xs font-mono max-w-[120px] truncate" title={linkedNo || undefined}>
                          {linkedNo || "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {match ? (
                            <Badge variant={match.variant} className="text-[9px] px-1 py-0">
                              {match.label}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs max-w-[140px] truncate" title={custEmail}>
                          {custEmail}
                        </TableCell>
                        <TableCell className="text-xs">
                          {listInterceptPending ? (
                            <Badge variant="outline" className="text-[10px] border-warning text-warning" title="ERP 拦截请求处理中，尚未写入成功">
                              拦截中
                            </Badge>
                          ) : activeIntercept ? (
                            <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive" title="含本地 shipping_hold 或风控 hold 成功">
                              已拦截
                            </Badge>
                          ) : riskState === "released" ? (
                            <span className="text-muted-foreground text-[10px]">已放行</span>
                          ) : (
                            <span className="text-muted-foreground">否</span>
                          )}
                        </TableCell>
                        <TableCell
                          className="text-xs text-muted-foreground whitespace-nowrap tabular-nums"
                          title={row.kind === "linked" ? row.link_created_at : undefined}
                        >
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
                                disabled={orderRefreshId === String(row.order.id)}
                                onClick={() => void refreshLinkedOrder(row.order)}
                              >
                                <RefreshCw
                                  className={`w-3 h-3 mr-1 ${orderRefreshId === String(row.order.id) ? "animate-spin" : ""}`}
                                />
                                {orderRefreshId === String(row.order.id) ? "更新中…" : "更新订单"}
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
        <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>邮件与订单详情</DialogTitle>
          </DialogHeader>
          {detailRow &&
            (() => {
              const dparsed = parsedOrderNoFromEmail(detailRow.email);
              const dlinked =
                detailRow.kind === "linked" ? String(detailRow.order.order_no ?? "").trim() : "";
              const dmatch = orderNoMatchBadge(dparsed, dlinked);
              return (
                <div className="space-y-4 text-sm">
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <h4 className="font-medium text-xs text-muted-foreground mb-1">邮件信息</h4>
                      <Card className="p-3 space-y-1.5 text-xs">
                        <div>
                          <span className="text-muted-foreground">主题：</span>
                          {String(detailRow.email.subject ?? "—")}
                        </div>
                        <div>
                          <span className="text-muted-foreground">发件人：</span>
                          {String(detailRow.email.from_name ?? "")} &lt;
                          {String(detailRow.email.from_email ?? "—")}&gt;
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
                        <div>
                          <span className="text-muted-foreground">关联状态：</span>
                          {String(detailRow.email.association_status ?? "—")}
                        </div>
                        <div className="pt-2 border-t">
                          <div className="text-muted-foreground mb-1">正文</div>
                          <EmailBody
                            content={String(detailRow.email.body_text ?? "")}
                            className="text-xs max-h-56 overflow-y-auto"
                          />
                        </div>
                      </Card>
                    </div>

                    {detailRow.kind === "linked" ? (
                      <>
                        <div>
                          <h4 className="font-medium text-xs text-muted-foreground mb-2">订单信息</h4>
                          <Card className="p-3 space-y-3 text-xs">
                            <div className="space-y-2">
                              <OrderDetailScalar label="解析单号（AI）" value={dparsed || "—"} />
                              <OrderDetailScalar label="关联订单号" value={String(detailRow.order.order_no ?? "—")} />
                              {dmatch ? (
                                <div className="flex flex-wrap items-center gap-2 text-[10px]">
                                  <span className="text-muted-foreground">解析与关联</span>
                                  <Badge variant={dmatch.variant} className="text-[10px]">
                                    {dmatch.label}
                                  </Badge>
                                </div>
                              ) : null}
                              <OrderDetailScalar label="订单邮箱" value={String(detailRow.order.customer_email ?? "—")} />
                              <OrderDetailScalar label="客户姓名" value={String(detailRow.order.customer_name ?? "—")} />
                              <OrderDetailScalar label="订单状态" value={String(detailRow.order.order_status ?? "—")} />
                              <OrderDetailScalar label="物流状态" value={String(detailRow.order.shipping_status ?? "—")} />
                              <OrderDetailScalar label="运单号" value={String(detailRow.order.tracking_no ?? "—")} />
                              <OrderDetailScalar label="下单时间" value={fmtDateTime(detailRow.order.ordered_at)} />
                              <OrderDetailScalar
                                label="金额 / 币种"
                                value={`${orderDisplayAmount(detailRow.order)} ${String(detailRow.order.currency ?? "").trim()}`.trim()}
                              />
                              {optionalStr(detailRow.order, "financial_status") && (
                                <OrderDetailScalar
                                  label="财务状态"
                                  value={optionalStr(detailRow.order, "financial_status")!}
                                />
                              )}
                              {optionalStr(detailRow.order, "fulfillment_status") && (
                                <OrderDetailScalar
                                  label="履约状态"
                                  value={optionalStr(detailRow.order, "fulfillment_status")!}
                                />
                              )}
                              <p className="text-[10px] text-muted-foreground m-0 pt-1 border-t border-border/60">
                                本地发货拦截见下方<strong>拦截详情</strong>；凭邮件单号 ERP 拦截见<strong>风控拦截（本邮件）</strong>。
                              </p>
                              {optionalStr(detailRow.order, "shopify_tags") && (
                                <OrderDetailScalar
                                  label="店铺标签"
                                  value={optionalStr(detailRow.order, "shopify_tags")!}
                                />
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
                        <div>
                          <h4 className="font-medium text-xs text-muted-foreground mb-2">风控拦截（本邮件）</h4>
                          <MailRiskLogsSection rows={detailRiskLogs} />
                        </div>
                        <LinkRecordDataSection row={detailRow} />
                      </>
                    ) : (
                      <>
                        <div>
                          <h4 className="font-medium text-xs text-muted-foreground mb-2">订单与解析</h4>
                          <Card className="p-3 space-y-2 text-xs border-dashed">
                            <OrderDetailScalar label="解析单号（AI）" value={dparsed || "—"} />
                            <OrderDetailScalar label="关联订单号" value="—（尚未建立 email_order_links）" />
                            {dmatch ? (
                              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                                <span className="text-muted-foreground">解析与关联</span>
                                <Badge variant={dmatch.variant} className="text-[10px]">
                                  {dmatch.label}
                                </Badge>
                              </div>
                            ) : null}
                            <p className="text-[10px] text-muted-foreground m-0 pt-1">
                              可在工作台将邮件与订单关联；若已凭邮件单号发起 ERP 拦截，记录见下方。
                            </p>
                            <Button variant="outline" size="sm" className="h-8 text-xs w-full mt-1" asChild>
                              <Link to="/">打开工作台</Link>
                            </Button>
                          </Card>
                        </div>
                        <div>
                          <h4 className="font-medium text-xs text-muted-foreground mb-2">风控拦截（本邮件）</h4>
                          <MailRiskLogsSection rows={detailRiskLogs} />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailRow(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
