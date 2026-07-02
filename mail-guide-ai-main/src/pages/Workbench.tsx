import { useEffect, useState, useCallback, useMemo, useRef } from "react";

// 前端 RFC 2047 解码兜底：解决服务端同步时未解码的 =?utf-8?B?xxx?= 字符串
function decodeRfc2047(s: string | null): string | null {
  if (!s) return s;
  if (!/=\?/i.test(s)) return s;
  let text = s.replace(/\?=\s*=\?/g, "?==?=");
  text = text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, encoding, data) => {
    try {
      // 清理畸形的 charset（如 "=?=gb18030?..." 中的 "=gb18030" → "gb18030"）
      let cleanCharset = charset.replace(/^=+/, "");
      if (!cleanCharset) cleanCharset = "utf-8";

      if (encoding.toUpperCase() === "B") {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        try {
          return new TextDecoder(cleanCharset).decode(bytes);
        } catch {
          // 如果指定 charset 无效，回退到 utf-8
          return new TextDecoder("utf-8").decode(bytes);
        }
      } else {
        const bytes: number[] = [];
        for (let i = 0; i < data.length; i++) {
          if (data[i] === "_") bytes.push(0x20);
          else if (data[i] === "=" && i + 2 < data.length) {
            bytes.push(parseInt(data.substring(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(data.charCodeAt(i));
        }
        try {
          return new TextDecoder(cleanCharset).decode(new Uint8Array(bytes));
        } catch {
          return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
        }
      }
    } catch {
      return _m;
    }
  });
  return text || s;
}
import { supabase } from "@/lib/supabase";
import { fetchAccessibleMailboxes } from "@/lib/accessible-mailboxes";
import { invokeGetOrderByEmail } from "@/lib/invoke-get-order-by-email";
import { formatFunctionsInvokeError, formatInvokeBodyField } from "@/lib/format-functions-invoke-error";
import {
  enqueueAttachmentRepairForEmail,
  shouldEnqueueAttachmentRepairOnFailure,
  invokeRepairSingleEmailWithRetry,
  formatSyncPhaseProgress,
  getSyncPhaseLabel,
  runPhasedMailboxSync,
} from "@/lib/sync-mailbox-phased";
import {
  BODY_REPAIR_COOLDOWN_MS,
  deriveBodyRepairUiStatusFromTask,
  fetchAttachmentRepairTaskStatus,
  fetchBodyRepairTaskStatus,
  formatAttachmentRepairTaskHint,
  formatBodyRepairTaskHint,
  invokeProcessEmailAfterBodyRepair,
  invokeRepairEmailBody,
  hasReadableEmailBodyForDisplay,
  needsEmailBodyRepair,
  isEmailBodyEmpty,
  type BodyRepairUiStatus,
} from "@/lib/email-body";
import { StatusBadge } from "@/components/StatusBadge";
import { TableListPagination } from "@/components/TableListPagination";
import { WorkbenchDateRangePicker } from "@/components/WorkbenchDateRangePicker";
import { EmailBody } from "@/components/EmailBody";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ASSOCIATION_FILTER_OPTIONS,
  BUSINESS_INTENT_OPTIONS,
  associationStatusLabel,
  coerceAssociationFilter,
  coerceIntentFilter,
  coerceMailboxFilter,
  effectiveAssociationStatus,
  businessIntentLabel,
  computeSlaBucket,
  isKnownBusinessIntent,
  SLA_BUCKET_LABEL,
  type BusinessIntent,
  type SlaBucket,
} from "@/lib/customerService";
import {
  fetchWorkbenchEmailList,
  clampWorkbenchDateRange,
  defaultWorkbenchListDateFrom,
  defaultWorkbenchListDateTo,
  WORKBENCH_LIST_PAGE_SIZE,
  workbenchListDateRangeLabel,
  type WorkbenchListFilters,
  type WorkbenchListStatusFilter,
} from "@/lib/workbench-email-list";
import {
  clearWorkbenchListScrollTop,
  defaultWorkbenchViewState,
  isDefaultWorkbenchQueryState,
  readInitialWorkbenchViewState,
  readWorkbenchListScrollAnchor,
  readWorkbenchListScrollTop,
  serializeWorkbenchViewStateToParams,
  writeWorkbenchListScrollAnchor,
  writeWorkbenchListScrollTop,
  type WorkbenchListScrollAnchor,
  type WorkbenchViewState,
} from "@/lib/workbench-view-state";
import {
  displayAttachmentFilename,
  isPlaceholderAttachment,
  placeholderAttachmentCount,
  partitionWorkbenchAttachments,
} from "@/lib/workbench-attachments";
import QuickReplyPicker from "@/components/QuickReplyPicker";
import ReplyAttachmentBar from "@/components/ReplyAttachmentBar";
import { buildQuickReplyContextFromEmail } from "@/lib/quick-reply-templates";
import {
  sanitizeOutboundFilename,
  type OutboundAttachmentDraft,
} from "@/lib/outbound-attachments";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sparkles,
  Send,
  Link2,
  Unlink,
  Search,
  RefreshCw,
  Package,
  AlertCircle,
  Mail as MailIcon,
  PauseCircle,
  Clock3,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { formatListDateTimeCST } from "@/lib/format-datetime";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

type Email = any;
type Order = any;
type Draft = any;
const ATTACHMENT_REPAIR_COOLDOWN_MS = 6 * 60 * 1000;
const WORKBENCH_EMAIL_ID_PARAM = "email";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readEmailIdFromUrl(): string | null {
  const id = new URLSearchParams(window.location.search).get(WORKBENCH_EMAIL_ID_PARAM);
  return id && UUID_RE.test(id) ? id : null;
}

/** 用于邮箱筛选：兼容 `Name <a@b.com>` 与纯地址 */
function normalizeEmailAddress(s: string | null | undefined): string {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return "";
  const angle = t.match(/<([^>]+@[^>]+)>/);
  return (angle ? angle[1] : t).trim();
}

export default function Workbench() {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const {
    user,
    isAdmin,
    hasAllMailboxAccess,
    hasMailboxAccess,
    allowedMailboxIds,
    grantsLoading,
    authGateLoading,
  } = useAuth();
  const canOperate = hasMailboxAccess && !grantsLoading;
  const initialViewState = useMemo(() => readInitialWorkbenchViewState(), []);

  useEffect(() => {
    try {
      window.localStorage.removeItem("mail-guide-ai:workbench-view:v1");
    } catch {
      // ignore
    }
  }, []);
  const initialSelectedId = initialViewState.email ?? readEmailIdFromUrl();
  const [emails, setEmails] = useState<Email[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const selectedIdRef = useRef<string | null>(initialSelectedId);
  const listScrollViewportRef = useRef<HTMLDivElement>(null);
  const savedListScrollOnMount = readWorkbenchListScrollTop();
  const savedListScrollAnchorOnMount = readWorkbenchListScrollAnchor();
  /** 仅左侧菜单切走再回工作台时恢复；浏览器标签切换不触发 */
  const shouldRestoreListScrollRef = useRef(
    savedListScrollOnMount != null || savedListScrollAnchorOnMount != null,
  );
  const pendingListScrollRestoreRef = useRef<number | null>(
    shouldRestoreListScrollRef.current ? savedListScrollOnMount : null,
  );
  const pendingListScrollAnchorRef = useRef<WorkbenchListScrollAnchor | null>(
    shouldRestoreListScrollRef.current ? savedListScrollAnchorOnMount : null,
  );
  /** 列表静默刷新后恢复当前滚动，避免 realtime 重载把位置打回顶部 */
  const listScrollPreserveAfterLoadRef = useRef<number | null>(null);
  const [searchInput, setSearchInput] = useState(initialViewState.search);
  const [search, setSearch] = useState(initialViewState.search);
  const [listDateRange, setListDateRange] = useState(() =>
    clampWorkbenchDateRange(initialViewState.dateFrom, initialViewState.dateTo),
  );
  const listDateFrom = listDateRange.dateFrom;
  const listDateTo = listDateRange.dateTo;
  const [listPage, setListPage] = useState(initialViewState.page);
  const [listTotal, setListTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [selectedEmailDetail, setSelectedEmailDetail] = useState<Email | null>(null);
  const [filter, setFilter] = useState<WorkbenchListStatusFilter>(initialViewState.status);
  const [intentFilter, setIntentFilter] = useState<string>(initialViewState.intent);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [savingIntent, setSavingIntent] = useState(false);
  const [mailboxFilter, setMailboxFilter] = useState<string>(initialViewState.mailbox);
  const [associationFilter, setAssociationFilter] = useState<string>(initialViewState.association);
  const [timeFilter, setTimeFilter] = useState<"all" | SlaBucket>(initialViewState.sla);
  const [mailboxes, setMailboxes] = useState<{ id: string; email_address: string; display_name: string | null }[]>([]);

  const [orders, setOrders] = useState<Order[]>([]);
  const linkedOrderIds = useMemo(() => new Set(orders.map((o) => o.id)), [orders]);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [conversationEmails, setConversationEmails] = useState<Email[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [bodyRepairingId, setBodyRepairingId] = useState<string | null>(null);
  const [bodyRepairUiStatus, setBodyRepairUiStatus] = useState<BodyRepairUiStatus>("idle");
  const [refreshingEmailDetail, setRefreshingEmailDetail] = useState(false);
  const bodyRepairInFlightRef = useRef<string | null>(null);
  const bodyRepairCooldownUntilRef = useRef<Map<string, number>>(new Map());
  const attachmentRepairInFlightRef = useRef<string | null>(null);
  const attachmentRepairCooldownUntilRef = useRef<Map<string, number>>(new Map());
  const repairEmailBodyIfNeededRef = useRef<(emailId: string, force?: boolean) => void>(() => {});
  const missingAnalysisInFlightRef = useRef<string | null>(null);
  const [bodyRepairTaskHint, setBodyRepairTaskHint] = useState<string | null>(null);
  const [attachmentRepairTaskHint, setAttachmentRepairTaskHint] = useState<string | null>(null);
  const [conversationCollapsed, setConversationCollapsed] = useState(true);
  const [timelineCollapsed, setTimelineCollapsed] = useState(true);
  /** 更多查询（时间/意图/关联/时效），默认收起；上行邮箱、中行状态、下行搜索+更多查询 */
  const [listFiltersCollapsed, setListFiltersCollapsed] = useState(initialViewState.filtersCollapsed);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [generating, setGenerating] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [replyContent, setReplyContent] = useState("");
  const [replySubjectOverride, setReplySubjectOverride] = useState<string | null>(null);
  const [lastQuickReplyTemplateId, setLastQuickReplyTemplateId] = useState<string | null>(null);
  const [replyAttachmentSessionId] = useState(() => crypto.randomUUID());
  const [replyAttachments, setReplyAttachments] = useState<OutboundAttachmentDraft[]>([]);
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  /** 手工关联弹窗：从 OMS 拉单 */
  const [erpPullOrderNo, setErpPullOrderNo] = useState("");
  const [erpPullEmail, setErpPullEmail] = useState("");
  const [erpPulling, setErpPulling] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [holdDialog, setHoldDialog] = useState<{
    open: boolean;
    order?: Order;
    /** 无本地关联订单时，按邮件解析/AI 写入的单号拦截 */
    emailProvidedOrderNo?: string | null;
  }>({ open: false });
  const [holdReason, setHoldReason] = useState("");
  const [holdCategory, setHoldCategory] = useState("cancel_order");
  const [holdSubmitting, setHoldSubmitting] = useState(false);
  const [holdConfirmOpen, setHoldConfirmOpen] = useState(false);
  const [holdPending, setHoldPending] = useState<
    | {
        mode: "linked";
        orderId: string;
        orderNo: string;
        reason: string;
        category: string;
      }
    | {
        mode: "email_provided";
        orderNo: string;
        reason: string;
        category: string;
      }
    | null
  >(null);

  const [orderRefreshId, setOrderRefreshId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);

  /** 私有桶 email-attachments：正文预览与下载链接分离，避免图片被 download 策略拦截预览 */
  const [attachmentPreviewUrls, setAttachmentPreviewUrls] = useState<Record<number, string>>({});
  const [attachmentDownloadUrls, setAttachmentDownloadUrls] = useState<Record<number, string>>({});
  const [repairingSelectedAttachments, setRepairingSelectedAttachments] = useState(false);
  const [autoRepairingAttachmentEmailId, setAutoRepairingAttachmentEmailId] = useState<string | null>(null);

  /** 订单补偿任务状态（用于 compensating ↔ not_found 展示） */
  const [compensationByEmailId, setCompensationByEmailId] = useState<
    Record<string, { status: string }>
  >({});

  const selectedListRow = emails.find((e) => e.id === selectedId);
  const selected =
    selectedEmailDetail?.id === selectedId ? selectedEmailDetail : selectedListRow;

  function compensationHint(emailId: string | null | undefined) {
    if (!emailId) return undefined;
    return compensationByEmailId[emailId];
  }

  function normalizeOrderNoForCompare(s: string | null | undefined) {
    return String(s ?? "").trim().toUpperCase();
  }

  /** 邮件分析写入 ai_entities.order_no */
  const emailProvidedOrderNo = String(
    (selected?.ai_entities as Record<string, unknown> | undefined)?.order_no ?? "",
  ).trim();

  const hideEmailOnlyHoldButton =
    !!emailProvidedOrderNo &&
    orders.length === 1 &&
    normalizeOrderNoForCompare(orders[0]?.order_no) === normalizeOrderNoForCompare(emailProvidedOrderNo);

  const loadCompensationHints = useCallback(async (list: Email[]) => {
    const ids = list
      .filter((e) => {
        const linked = (e.email_order_links?.length ?? 0) > 0;
        if (linked) return false;
        const st = String(e.association_status ?? "").trim();
        return st === "compensating" || st === "not_provided" || st === "not_found";
      })
      .map((e) => e.id);
    if (ids.length === 0) {
      setCompensationByEmailId({});
      return;
    }
    const { data: tasks } = await supabase
      .from("order_compensation_tasks")
      .select("email_id, status, updated_at")
      .in("email_id", ids)
      .order("updated_at", { ascending: false });
    const map: Record<string, { status: string }> = {};
    for (const row of tasks ?? []) {
      if (!map[row.email_id]) map[row.email_id] = { status: row.status };
    }
    setCompensationByEmailId(map);
  }, []);

  const listFilters = useMemo((): WorkbenchListFilters => {
    const mb =
      mailboxFilter !== "all"
        ? mailboxes.find((m) => m.id === mailboxFilter)
        : undefined;
    return {
      dateFrom: listDateFrom,
      dateTo: listDateTo,
      status: filter,
      mailboxId: mailboxFilter,
      mailboxToEmail: mb?.email_address ?? null,
      association: associationFilter,
      intent: intentFilter,
      slaBucket: timeFilter,
      search,
    };
  }, [
    listDateFrom,
    listDateTo,
    filter,
    mailboxFilter,
    mailboxes,
    associationFilter,
    intentFilter,
    timeFilter,
    search,
  ]);

  const listFiltersKey = useMemo(() => JSON.stringify(listFilters), [listFilters]);

  const mailboxSelectValue = useMemo(
    () => coerceMailboxFilter(mailboxFilter, mailboxes.map((m) => m.id)),
    [mailboxFilter, mailboxes],
  );
  const intentSelectValue = useMemo(() => coerceIntentFilter(intentFilter), [intentFilter]);
  const associationSelectValue = useMemo(
    () => coerceAssociationFilter(associationFilter),
    [associationFilter],
  );

  const workbenchViewState = useMemo<WorkbenchViewState>(
    () => ({
      dateFrom: listDateFrom,
      dateTo: listDateTo,
      status: filter,
      mailbox: mailboxFilter,
      intent: intentFilter,
      association: associationFilter,
      sla: timeFilter,
      search: searchInput.trim(),
      page: listPage,
      email: selectedId,
      filtersCollapsed: listFiltersCollapsed,
    }),
    [
      listDateFrom,
      listDateTo,
      filter,
      mailboxFilter,
      intentFilter,
      associationFilter,
      timeFilter,
      searchInput,
      listPage,
      selectedId,
      listFiltersCollapsed,
    ],
  );

  useEffect(() => {
    selectedIdRef.current = selectedId;
    setSearchParams(
      (prev) => {
        return serializeWorkbenchViewStateToParams(prev, workbenchViewState);
      },
      { replace: true },
    );
  }, [selectedId, setSearchParams, workbenchViewState]);

  const loadEmails = useCallback(
    async (opts?: { keepSelection?: boolean; selectFirst?: boolean }): Promise<Email[]> => {
      const keepSelection = opts?.keepSelection ?? true;
      const selectFirst = opts?.selectFirst ?? false;
      if (keepSelection && !selectFirst && !shouldRestoreListScrollRef.current) {
        const viewport = listScrollViewportRef.current;
        if (viewport) listScrollPreserveAfterLoadRef.current = viewport.scrollTop;
      }
      setListLoading(true);
      try {
        const { rows, total } = await fetchWorkbenchEmailList(
          supabase,
          listFilters,
          listPage,
        );
        const list = rows as Email[];
        setEmails(list);
        setListTotal(total);
        await loadCompensationHints(list);
        const currentSelectedId = selectedIdRef.current;
        if (selectFirst || !keepSelection) {
          if (list.length === 0) {
            setSelectedId(null);
            setSelectedEmailDetail(null);
          } else {
            setSelectedId(list[0].id);
          }
        } else if (!currentSelectedId && list.length > 0) {
          setSelectedId(list[0].id);
        }
        return list;
      } catch (error) {
        const message =
          typeof error === "object" && error && "message" in error
            ? String((error as { message: string }).message)
            : "请稍后重试";
        console.error("Failed to load workbench email list", error);
        toast.error(`邮件列表加载失败：${message}`);
        setEmails([]);
        setListTotal(0);
        return [];
      } finally {
        setListLoading(false);
      }
    },
    [listFilters, listPage, loadCompensationHints],
  );

  const loadEmailsRef = useRef(loadEmails);
  loadEmailsRef.current = loadEmails;

  const triggerMissingAnalysisIfNeeded = useCallback(async (emailId: string, emailRow: Email) => {
    if (missingAnalysisInFlightRef.current === emailId) return;
    if (needsEmailBodyRepair(emailRow) || emailRow.ai_analyzed_at) return;
    missingAnalysisInFlightRef.current = emailId;
    try {
      const r = await invokeProcessEmailAfterBodyRepair(emailId);
      if (!r.ok) {
        console.warn("[triggerMissingAnalysis]", r.error);
      }
    } finally {
      if (missingAnalysisInFlightRef.current === emailId) {
        missingAnalysisInFlightRef.current = null;
      }
    }
  }, []);

  const loadDetail = useCallback(async (
    email: Email,
    options?: { skipBodyRepair?: boolean; skipAnalysisCompensation?: boolean },
  ) => {
    const emailId = email.id;

    const { data: fullRow, error: fullErr } = await supabase
      .from("emails")
      .select("*")
      .eq("id", emailId)
      .maybeSingle();
    if (fullErr) {
      console.warn("[loadDetail full email]", fullErr.message);
    } else if (fullRow) {
      setSelectedEmailDetail(fullRow as Email);
      setEmails((prev) =>
        prev.map((row) => (row.id === emailId ? { ...row, ...(fullRow as Email) } : row)),
      );
      if (!options?.skipBodyRepair && needsEmailBodyRepair(fullRow as Email)) {
        setBodyRepairUiStatus("idle");
        void repairEmailBodyIfNeededRef.current(emailId);
      } else if (
        !options?.skipAnalysisCompensation &&
        hasReadableEmailBodyForDisplay(fullRow.body_text, fullRow.body_html) &&
        !fullRow.ai_analyzed_at
      ) {
        void triggerMissingAnalysisIfNeeded(emailId, fullRow as Email);
      }
    }

    setConversationLoading(true);
    if (email.from_email && email.to_email) {
      const { data: history } = await supabase
        .from("emails")
        .select("id, from_email, from_name, to_email, subject, body_text, received_at, status, is_read")
        .eq("from_email", email.from_email)
        .eq("to_email", email.to_email)
        .neq("id", emailId)
        .order("received_at", { ascending: false })
        .limit(10);
      setConversationEmails(history ?? []);
    } else {
      setConversationEmails([]);
    }
    setConversationLoading(false);

    const { data: links } = await supabase
      .from("email_order_links")
      .select("id, link_source, orders(*)")
      .eq("email_id", emailId);
    const linkRows = links ?? [];
    setOrders(
      linkRows.map((l: any) => ({ ...l.orders, _link_id: l.id, _link_source: l.link_source }))
    );

    const { data: compTask } = await supabase
      .from("order_compensation_tasks")
      .select("id, status")
      .eq("email_id", emailId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (compTask?.status) {
      setCompensationByEmailId((prev) => ({
        ...prev,
        [emailId]: { status: compTask.status },
      }));
    }

    // 补偿已失败但 emails 仍为 compensating / not_provided 时回写为 not_found
    if (
      linkRows.length === 0 &&
      compTask?.status === "failed" &&
      ["compensating", "not_provided"].includes(String(email.association_status ?? "").trim())
    ) {
      const { error: repairFailedErr } = await supabase
        .from("emails")
        .update({ association_status: "not_found" } as any)
        .eq("id", emailId);
      if (!repairFailedErr) {
        setEmails((prev) =>
          prev.map((row) =>
            row.id === emailId ? { ...row, association_status: "not_found" } : row,
          ),
        );
      } else {
        console.warn("[association_status repair failed task]", repairFailedErr.message);
      }
    }

    // 已有订单关联行但 emails.association_status 未回写时，对齐为 linked（历史数据 / 更新被拒等）
    if (linkRows.length > 0 && String(email.association_status ?? "").trim() !== "linked") {
      const { error: repairErr } = await supabase
        .from("emails")
        .update({
          association_status: "linked",
          processing_status: "associated",
        } as any)
        .eq("id", emailId);
      if (!repairErr) {
        setEmails((prev) =>
          prev.map((row) =>
            row.id === emailId
              ? {
                  ...row,
                  association_status: "linked",
                  processing_status: "associated",
                  email_order_links: linkRows.map((l: { id: string }) => ({ id: l.id })),
                }
              : row,
          ),
        );
      } else {
        console.warn("[association_status repair]", repairErr.message);
      }
    }

    const { data: recs } = await supabase
      .from("email_order_recommendations")
      .select("id, score, reason, status, orders(*)")
      .eq("email_id", emailId)
      .eq("status", "pending")
      .order("score", { ascending: false });
    setRecommendations(recs ?? []);

    const { data: events } = await supabase
      .from("email_processing_events")
      .select("*")
      .eq("email_id", emailId)
      .order("created_at", { ascending: false });
    setTimeline(events ?? []);

    const { data: ds } = await supabase
      .from("ai_drafts")
      .select("*")
      .eq("email_id", emailId)
      .order("version", { ascending: false });
    setDrafts(ds ?? []);
    if (ds && ds.length > 0) {
      setReplyContent(ds[0].draft_content);
      setSelectedDraftId(ds[0].id);
    } else {
      setReplyContent("");
      setSelectedDraftId(null);
    }
    setReplySubjectOverride(null);
    setLastQuickReplyTemplateId(null);
    setReplyAttachments([]);
    setGuidance("");
  }, [triggerMissingAnalysisIfNeeded]);

  /** 局部刷新当前邮件：正文、AI、订单、时间线、列表行；不重置列表筛选与选中项 */
  const refreshSelectedEmail = useCallback(
    async (opts?: { silent?: boolean; showToast?: boolean }) => {
      if (!selectedId) return false;
      const base =
        selectedEmailDetail?.id === selectedId
          ? selectedEmailDetail
          : emails.find((e) => e.id === selectedId);
      if (!base) return false;
      if (!opts?.silent) setRefreshingEmailDetail(true);
      try {
        await loadDetail(base as Email, { skipBodyRepair: true });
        if (opts?.showToast) {
          toast.message("已刷新本邮件", {
            description: "正文、AI 分析、订单关联与时间线已更新。",
          });
        }
        return true;
      } catch (e) {
        console.warn("[refreshSelectedEmail]", e);
        return false;
      } finally {
        if (!opts?.silent) setRefreshingEmailDetail(false);
      }
    },
    [selectedId, selectedEmailDetail, emails, loadDetail],
  );

  const repairSelectedEmailAttachments = useCallback(async (opts?: {
    emailId?: string;
    silent?: boolean;
    force?: boolean;
    autoTriggered?: boolean;
  }) => {
    const emailId = opts?.emailId ?? selected?.id;
    if (!emailId) return false;
    if (attachmentRepairInFlightRef.current === emailId) return false;
    const cooldownUntil = attachmentRepairCooldownUntilRef.current.get(emailId) ?? 0;
    if (!opts?.force && Date.now() < cooldownUntil) return false;

    attachmentRepairInFlightRef.current = emailId;
    attachmentRepairCooldownUntilRef.current.set(emailId, Date.now() + ATTACHMENT_REPAIR_COOLDOWN_MS);
    if (selected?.id === emailId) setRepairingSelectedAttachments(true);
    if (opts?.autoTriggered && selected?.id === emailId) setAutoRepairingAttachmentEmailId(emailId);
    try {
      const { row, errorMessage, retries } = await invokeRepairSingleEmailWithRetry({
        emailId,
        maxRetries: 4,
        retryDelayMs: 12_000,
      });
      if (errorMessage) {
        if (shouldEnqueueAttachmentRepairOnFailure(errorMessage)) {
          const queued = await enqueueAttachmentRepairForEmail(emailId);
          if (!opts?.silent) {
            if (queued.queued) {
              toast.message("已加入后台附件补拉队列", {
                description:
                  "检测到超大附件同步超时，系统将由后台任务持续重试；可稍后刷新本邮件查看附件状态。",
              });
            } else {
              toast.message("补拉任务超时", {
                description:
                  queued.errorMessage ||
                  "该邮件可能包含超大附件（如 30MB+ 视频），Edge Worker 已到时限。建议先在官方邮箱下载超大文件。",
              });
            }
          }
        } else if (!opts?.silent) {
          toast.error("补拉附件失败", { description: errorMessage });
        }
        return false;
      }
      if (row?.queued && !row?.repaired) {
        if (!opts?.silent) {
          toast.message("已加入后台附件补拉队列", {
            description: "该邮件附件较大，将由后台任务补拉；请稍后刷新查看。",
          });
        }
        return true;
      }
      await refreshSelectedEmail({ silent: true });
      if (!opts?.silent) {
        toast.message("已触发本邮件补拉", {
          description:
            row?.repaired && row.repaired > 0
              ? `已修复 ${row.repaired} 项附件/正文。${retries > 0 ? `（自动重试 ${retries} 次）` : ""}`
              : "邮件正文与附件已刷新，请查看附件区状态。",
        });
      }
      return true;
    } finally {
      if (attachmentRepairInFlightRef.current === emailId) {
        attachmentRepairInFlightRef.current = null;
      }
      if (selected?.id === emailId) setRepairingSelectedAttachments(false);
      if (selected?.id === emailId) setAutoRepairingAttachmentEmailId(null);
    }
  }, [selected?.id, refreshSelectedEmail]);

  useEffect(() => {
    if (!selected?.id || !Array.isArray(selected.attachments) || selected.attachments.length === 0) return;
    const hasPlaceholder = (selected.attachments as Record<string, unknown>[]).some((item) =>
      isPlaceholderAttachment(item),
    );
    if (!hasPlaceholder) return;
    void repairSelectedEmailAttachments({
      emailId: selected.id,
      silent: true,
      autoTriggered: true,
    });
  }, [selected?.id, selected?.attachments, repairSelectedEmailAttachments]);

  useEffect(() => {
    if (!selectedId) {
      setAttachmentRepairTaskHint(null);
      return;
    }
    let cancelled = false;
    const loadHint = async () => {
      const task = await fetchAttachmentRepairTaskStatus(selectedId);
      if (!cancelled) setAttachmentRepairTaskHint(formatAttachmentRepairTaskHint(task));
    };
    void loadHint();
    return () => {
      cancelled = true;
    };
  }, [selectedId, selected?.attachments, repairingSelectedAttachments]);

  const repairEmailBodyIfNeeded = useCallback(async (emailId: string, force = false) => {
    if (bodyRepairInFlightRef.current === emailId) return;
    const cooldownUntil = bodyRepairCooldownUntilRef.current.get(emailId) ?? 0;
    if (!force && Date.now() < cooldownUntil) return;

    bodyRepairInFlightRef.current = emailId;
    setBodyRepairingId(emailId);
    setBodyRepairUiStatus("quick");
    try {
      const r = await invokeRepairEmailBody(emailId);
      if (r.ok && r.repaired) {
        setBodyRepairUiStatus("done");
        bodyRepairCooldownUntilRef.current.set(emailId, Date.now() + BODY_REPAIR_COOLDOWN_MS);
        const base =
          selectedEmailDetail?.id === emailId
            ? selectedEmailDetail
            : emails.find((e) => e.id === emailId);
        if (base) {
          await loadDetail(base as Email, { skipBodyRepair: true });
        }
        return;
      }
      if (r.ok && "queued" in r && r.queued) {
        setBodyRepairUiStatus("queued");
        bodyRepairCooldownUntilRef.current.set(emailId, Date.now() + BODY_REPAIR_COOLDOWN_MS);
        const task = await fetchBodyRepairTaskStatus(emailId);
        setBodyRepairTaskHint(formatBodyRepairTaskHint(task));
        toast.message("正文补拉已加入后台队列", {
          description: formatBodyRepairTaskHint(task) ?? "后台约每 3 分钟处理；本页约每 10 秒自动局部刷新。",
        });
        return;
      }
      if (r.ok && r.skipped) {
        const { data: row } = await supabase
          .from("emails")
          .select("ai_analyzed_at, body_text, body_html")
          .eq("id", emailId)
          .maybeSingle();
        if (row && hasReadableEmailBodyForDisplay(row.body_text, row.body_html) && !row.ai_analyzed_at) {
          setBodyRepairUiStatus("done");
          const base =
            selectedEmailDetail?.id === emailId
              ? selectedEmailDetail
              : emails.find((e) => e.id === emailId);
          if (base) await loadDetail(base as Email, { skipBodyRepair: true });
        } else {
          setBodyRepairUiStatus("idle");
        }
        return;
      }
      if (!r.ok) {
        const task = await fetchBodyRepairTaskStatus(emailId);
        const ui = r.terminal ? "failed_terminal" : deriveBodyRepairUiStatusFromTask(task);
        setBodyRepairUiStatus(ui === "idle" ? "failed" : ui);
        setBodyRepairTaskHint(formatBodyRepairTaskHint(task) ?? r.errorMessage);
        bodyRepairCooldownUntilRef.current.set(emailId, Date.now() + BODY_REPAIR_COOLDOWN_MS);
        if (r.terminal) {
          toast.message("无法补拉正文", { description: r.errorMessage });
        } else {
          toast.message("正文补拉失败", { description: r.errorMessage });
        }
      }
    } finally {
      if (bodyRepairInFlightRef.current === emailId) {
        bodyRepairInFlightRef.current = null;
      }
      setBodyRepairingId((cur) => (cur === emailId ? null : cur));
    }
  }, [selectedEmailDetail, emails, loadDetail]);

  useEffect(() => {
    repairEmailBodyIfNeededRef.current = (id, force) => {
      void repairEmailBodyIfNeeded(id, force);
    };
  }, [repairEmailBodyIfNeeded]);

  useEffect(() => {
    if (bodyRepairUiStatus !== "queued" || !selectedId) return;
    let cancelled = false;

    const poll = async () => {
      const task = await fetchBodyRepairTaskStatus(selectedId);
      if (cancelled) return;
      setBodyRepairTaskHint(formatBodyRepairTaskHint(task));
      const ui = deriveBodyRepairUiStatusFromTask(task);
      if (task?.status === "failed") {
        setBodyRepairUiStatus("failed_terminal");
        toast.message("无法补拉正文", {
          description: task.last_error ?? "邮箱中可能已找不到该邮件",
        });
        return;
      }
      if (ui === "queued" || ui === "not_found_retrying") {
        setBodyRepairUiStatus(ui);
        return;
      }
      if (task?.status !== "resolved" && task?.status !== "skipped") return;

      await refreshSelectedEmail({ silent: true });
      const { data: row } = await supabase
        .from("emails")
        .select("ai_analyzed_at, body_text, body_html")
        .eq("id", selectedId)
        .maybeSingle();
      if (cancelled) return;

      const hasBody = row ? hasReadableEmailBodyForDisplay(row.body_text, row.body_html) : false;
      const analyzed = Boolean(row?.ai_analyzed_at);
      if (!hasBody) {
        setBodyRepairUiStatus("failed");
        return;
      }
      if (analyzed || task.post_processed_at) {
        setBodyRepairUiStatus("done");
        toast.message("本邮件已更新", {
          description: "正文与 AI/订单信息已自动刷新。",
        });
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bodyRepairUiStatus, selectedId, refreshSelectedEmail]);

  useEffect(() => {
    if (bodyRepairUiStatus !== "done" || !selectedId) return;
    const base = selectedEmailDetail?.id === selectedId ? selectedEmailDetail : null;
    if (!base || !hasReadableEmailBodyForDisplay(base.body_text, base.body_html) || base.ai_analyzed_at) return;

    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      await refreshSelectedEmail({ silent: true });
      const { data: row } = await supabase
        .from("emails")
        .select("ai_analyzed_at")
        .eq("id", selectedId)
        .maybeSingle();
      if (cancelled) return;
      if (row?.ai_analyzed_at) {
        toast.message("AI 分析已完成", { description: "摘要与订单信息已自动刷新。" });
      } else if (attempts >= 18) {
        toast.message("分析仍在进行", { description: "可点击「刷新本邮件」查看最新结果。" });
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bodyRepairUiStatus, selectedId, selectedEmailDetail?.ai_analyzed_at, refreshSelectedEmail]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const prevListFiltersKey = useRef(listFiltersKey);
  const prevListPage = useRef(listPage);
  useEffect(() => {
    const filtersChanged = prevListFiltersKey.current !== listFiltersKey;
    const pageChanged = prevListPage.current !== listPage;
    prevListFiltersKey.current = listFiltersKey;
    prevListPage.current = listPage;

    if (filtersChanged && listPage !== 0) {
      setListPage(0);
      return;
    }

    void loadEmails({
      keepSelection: !(filtersChanged || pageChanged),
      selectFirst: filtersChanged || pageChanged,
    });
  }, [listFiltersKey, listPage, loadEmails]);

  useEffect(() => {
    if (authGateLoading) return;
    void fetchAccessibleMailboxes().then(setMailboxes);
  }, [authGateLoading]);

  useEffect(() => {
    if (mailboxFilter === "all") return;
    if (mailboxes.length === 0) return;
    if (!mailboxes.some((m) => m.id === mailboxFilter)) {
      setMailboxFilter("all");
    }
  }, [mailboxes, mailboxFilter]);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("workbench-emails-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "emails" }, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void loadEmailsRef.current({ keepSelection: true });
        }, 1500);
      })
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!selected?.attachments || !Array.isArray(selected.attachments)) {
      setAttachmentPreviewUrls({});
      setAttachmentDownloadUrls({});
      return;
    }
    let cancelled = false;
    const arr = selected.attachments as Record<string, unknown>[];
    const { inlineImages } = partitionWorkbenchAttachments(arr, selected);
    const inlineIndexes = new Set(inlineImages.map((r) => r.index));
    (async () => {
      const nextPreview: Record<number, string> = {};
      const nextDownload: Record<number, string> = {};
      const signErrors: string[] = [];
      await Promise.all(
        arr.map(async (a, i) => {
          const rawUrl = typeof a?.url === "string" ? a.url : "";
          if (rawUrl) {
            nextPreview[i] = rawUrl;
            nextDownload[i] = rawUrl;
            return;
          }
          const path = a?.storage_path;
          if (typeof path !== "string" || !path) return;

          const previewResp = await supabase.storage
            .from("email-attachments")
            .createSignedUrl(path, 3600);
          if (previewResp.error) {
            console.error("[attachment preview signed url]", path, previewResp.error.message);
            signErrors.push(previewResp.error.message);
          } else if (previewResp.data?.signedUrl && !cancelled) {
            nextPreview[i] = previewResp.data.signedUrl;
          }

          if (!inlineIndexes.has(i)) {
            const downloadAs = displayAttachmentFilename(a);
            const downloadResp = await supabase.storage
              .from("email-attachments")
              .createSignedUrl(path, 3600, { download: downloadAs });
            if (downloadResp.error) {
              console.error("[attachment download signed url]", path, downloadResp.error.message);
              signErrors.push(downloadResp.error.message);
            } else if (downloadResp.data?.signedUrl && !cancelled) {
              nextDownload[i] = downloadResp.data.signedUrl;
            }
          } else if (nextPreview[i]) {
            // 内嵌图点击下载时也可回落使用预览地址
            nextDownload[i] = nextPreview[i];
          }
        }),
      );
      if (!cancelled) {
        setAttachmentPreviewUrls(nextPreview);
        setAttachmentDownloadUrls(nextDownload);
        if (signErrors.length > 0) {
          const first = signErrors[0];
          const suffix = signErrors.length > 1 ? `（共 ${signErrors.length} 项失败）` : "";
          toast.error(`附件下载链接生成失败：${first}${suffix}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.attachments, selected?.body_html, selected?.body_text]);

  // 列表中有行时按行拉详情
  useEffect(() => {
    if (!selectedId || !selectedListRow) return;
    void loadDetail(selectedListRow);
  }, [selectedId, selectedListRow?.id, loadDetail]);

  // 刷新后邮件不在当前筛选页时，按 id 直连库加载详情
  useEffect(() => {
    if (!selectedId || selectedListRow) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("emails")
        .select("*")
        .eq("id", selectedId)
        .maybeSingle();
      if (cancelled || error || !data) return;
      void loadDetail(data as Email);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedListRow, loadDetail]);

  useEffect(() => {
    if (!selectedId) return;
    void supabase.from("emails").update({ is_read: true }).eq("id", selectedId);
  }, [selectedId]);

  async function generateDraft() {
    if (!selectedId) return;
    setGenerating(true);
    // 人工二次生成草稿：默认走 Dify 工作流，由后端传入「指导思想」与邮件上下文生成草稿
    // Dify 调用失败时，后端按 GENERATE_DRAFT_FALLBACK_LOCAL 决定是否回落本地
    const { data, error } = await supabase.functions.invoke("generate-draft", {
      body: { email_id: selectedId, guidance: guidance.trim() },
    });
    setGenerating(false);
    if (error) {
      toast.error("生成失败：" + (await formatFunctionsInvokeError(error)));
      return;
    }
    if (data?.error) {
      toast.error(data.error);
      return;
    }
    const model = data?.draft?.model ?? "";
    if (model === "dify-workflow") {
      toast.success("草稿已生成（Dify 工作流）");
    } else if (model === "pipeline-local-fallback") {
      const hint = data?.dify_error ? `：${String(data.dify_error).slice(0, 240)}` : "";
      toast.warning(`Dify 调用失败，已回落本地兜底草稿${hint}`);
    } else {
      toast.success("草稿已生成（本地）");
    }
    if (selected) loadDetail(selected);
    void loadEmails({ keepSelection: true });
  }

  /** 仅重跑邮件智能分析（Dify 工作流 / 本地兜底），不触发关联订单、风控、自动回复 */
  async function reanalyzeEmail() {
    if (!selectedId) return;
    setReanalyzing(true);
    const { data, error } = await supabase.functions.invoke("process-email", {
      body: { email_ids: [selectedId], analyze_only: true },
    });
    setReanalyzing(false);
    if (error) {
      toast.error("再次分析失败：" + (await formatFunctionsInvokeError(error)));
      return;
    }
    const errMsg = typeof (data as { error?: string })?.error === "string"
      ? (data as { error: string }).error
      : null;
    if (errMsg) {
      toast.error(errMsg);
      return;
    }
    const row = (data as { results?: { routed?: string; analysis?: { summary?: string } }[] })?.results?.[0];
    if (!row) {
      toast.error("未返回分析结果");
      return;
    }
    const src = row.routed === "analyze_only" ? "已更新摘要与意图" : "分析已完成";
    toast.success(src);
    const list = await loadEmails({ keepSelection: true });
    const cur = list.find((e) => e.id === selectedId);
    if (cur) await loadDetail(cur);
  }

  async function updateEmailStatus(targetStatus: "processing" | "replied") {
    if (!selectedId) return;
    if (selected?.status === targetStatus) return;
    if (
      targetStatus === "replied" &&
      !confirm("确认将该工单标记为「已回复」？该操作不会发送回复邮件。")
    ) return;

    setUpdatingStatus(true);
    const before = selected?.status ?? null;
    const { error } = await supabase
      .from("emails")
      .update({ status: targetStatus } as any)
      .eq("id", selectedId);
    setUpdatingStatus(false);
    if (error) { toast.error("操作失败：" + error.message); return; }

    await supabase.from("email_processing_events").insert({
      email_id: selectedId,
      event_type: "status_updated_by_user",
      actor_type: "user",
      title: targetStatus === "replied" ? "人工标记为已回复" : "人工改回处理中",
      detail: before ? `原状态：${before}` : null,
      metadata: { before, after: targetStatus },
    } as any);

    toast.success(targetStatus === "replied" ? "已标记为已回复" : "已改回处理中");
    if (selected) loadDetail(selected);
    void loadEmails({ keepSelection: true });
  }

  async function updateBusinessIntent(value: BusinessIntent) {
    if (!selectedId || !selected) return;
    if (selected.business_intent === value) return;
    setSavingIntent(true);
    const before = selected.business_intent ?? null;
    const { error } = await supabase
      .from("emails")
      .update({ business_intent: value } as any)
      .eq("id", selectedId);
    if (error) {
      setSavingIntent(false);
      toast.error("意图保存失败：" + error.message);
      return;
    }
    await supabase.from("email_processing_events").insert({
      email_id: selectedId,
      event_type: "intent_updated_by_user",
      actor_type: "user",
      title: `意图改为「${businessIntentLabel(value)}」`,
      detail: before ? `原意图：${businessIntentLabel(before)}` : null,
      metadata: { before, after: value },
    } as any);
    setSavingIntent(false);
    toast.success("意图已更新");
    if (selected) loadDetail(selected);
    void loadEmails({ keepSelection: true });
  }

  async function openLinkDialog() {
    setAllOrders([]);
    setErpPullOrderNo("");
    setErpPullEmail(selected?.from_email ?? "");
    setLinkDialogOpen(true);
  }

  async function markEmailLinked(emailId: string): Promise<string | null> {
    const { error: stErr } = await supabase
      .from("emails")
      .update({
        association_status: "linked",
        processing_status: "associated",
      } as any)
      .eq("id", emailId);
    return stErr?.message ?? null;
  }

  /** 幂等写入邮件-订单关联；已存在时返回 exists（不报错） */
  async function ensureEmailOrderLink(
    emailId: string,
    orderId: string,
    payload: Record<string, unknown>,
  ): Promise<"created" | "exists" | "error"> {
    const { data: existing } = await supabase
      .from("email_order_links")
      .select("id")
      .eq("email_id", emailId)
      .eq("order_id", orderId)
      .maybeSingle();
    if (existing) return "exists";

    const { error } = await supabase.from("email_order_links").insert({
      email_id: emailId,
      order_id: orderId,
      ...payload,
    } as any);
    if (error) {
      if (error.code === "23505") return "exists";
      toast.error(error.message);
      return "error";
    }
    return "created";
  }

  async function pullOrderFromErp() {
    setErpPulling(true);
    try {
      const r = await invokeGetOrderByEmail(erpPullOrderNo, erpPullEmail, {
        refresh: false,
        emailId: selectedId ?? undefined,
      });
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
        toast.message("未查到可关联订单", {
          description: r.description,
        });
        return;
      }
      const linkedViaApi = Boolean(selectedId && r.orderId);
      toast.success(
        linkedViaApi
          ? r.source === "erp_oms"
            ? "已从 OMS 拉取并已关联到当前邮件"
            : "已在本地找到该订单并已关联到当前邮件"
          : r.source === "erp_oms"
            ? "已从 OMS 拉取并写入本地"
            : "已在本地找到该订单",
      );
      if (r.orderId) {
        const { data: orderRow } = await supabase.from("orders").select("*").eq("id", r.orderId).maybeSingle();
        if (orderRow) setAllOrders([orderRow as Order]);
      }
      if (linkedViaApi && selected) {
        const stMsg = await markEmailLinked(selected.id);
        if (stMsg) toast.error("订单已关联，但更新邮件状态失败：" + stMsg);
        await loadDetail(selected);
        void loadEmails({ keepSelection: true });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "拉取失败");
    } finally {
      setErpPulling(false);
    }
  }

  async function refreshOrderFromErp(o: Order) {
    const id = o.id;
    const orderNo = String(o.order_no ?? "").trim();
    if (!id) return;
    if (!orderNo) {
      toast.error("缺少订单号，无法更新订单信息");
      return;
    }
    setOrderRefreshId(id);
    try {
      const r = await invokeGetOrderByEmail(orderNo, String(o.customer_email ?? "").trim(), {
        refresh: true,
        emailId: selectedId ?? undefined,
      });
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
      if (selected) loadDetail(selected);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新失败");
    } finally {
      setOrderRefreshId(null);
    }
  }

  async function linkOrder(orderId: string) {
    if (!selectedId) return;
    const linkResult = await ensureEmailOrderLink(selectedId, orderId, { link_source: "manual" });
    if (linkResult === "error") return;
    const stMsg = await markEmailLinked(selectedId);
    if (stMsg) toast.error("关联已写入，但更新邮件状态失败：" + stMsg);
    else toast.success(linkResult === "exists" ? "该订单已关联到此邮件" : "已关联订单");
    setLinkDialogOpen(false);
    if (selected) loadDetail(selected);
    void loadEmails({ keepSelection: true });
  }

  async function acceptRecommendation(rec: any) {
    if (!selectedId) return;
    const order = rec.orders;
    const linkResult = await ensureEmailOrderLink(selectedId, order.id, {
      link_source: "recommended",
      confidence: rec.score,
      metadata: { recommendation_id: rec.id, reason: rec.reason },
    });
    if (linkResult === "error") return;
    await supabase.from("email_order_recommendations").update({ status: "accepted" }).eq("id", rec.id);
    await supabase.from("email_processing_events").insert({
      email_id: selectedId,
      event_type: "recommendation_accepted",
      actor_type: "user",
      title: `接受推荐订单 ${order.order_no}`,
      metadata: { recommendation_id: rec.id, order_id: order.id },
    } as any);
    const stMsg = await markEmailLinked(selectedId);
    if (stMsg) toast.error("关联已写入，但更新邮件状态失败：" + stMsg);
    else toast.success(linkResult === "exists" ? "该推荐订单已关联" : "已关联推荐订单");
    if (selected) loadDetail(selected);
    void loadEmails({ keepSelection: true });
  }

  function chooseDraft(draft: Draft) {
    setSelectedDraftId(draft.id);
    setReplyContent(draft.draft_content);
  }

  async function unlinkOrder(linkId: string) {
    if (!selectedId) return;
    const { error } = await supabase.from("email_order_links").delete().eq("id", linkId);
    if (error) {
      toast.error(error.message);
      return;
    }
    const { data: remaining } = await supabase
      .from("email_order_links")
      .select("id")
      .eq("email_id", selectedId)
      .limit(1);
    if (!remaining?.length) {
      await supabase
        .from("order_compensation_tasks")
        .delete()
        .eq("email_id", selectedId)
        .eq("status", "pending");
      const { error: stErr } = await supabase
        .from("emails")
        .update({
          association_status: "manual_unlink",
          processing_status: "pending",
        } as any)
        .eq("id", selectedId);
      if (stErr) toast.error("已解除关联，但更新邮件状态失败：" + stErr.message);
      else toast.success("已解除关联（人工解除，不再自动/补偿关联）");
    } else {
      toast.success("已解除该条关联");
    }
    if (selected) loadDetail(selected);
    void loadEmails({ keepSelection: true });
  }

  function openHoldDialog(order: Order) {
    setHoldPending(null);
    setHoldConfirmOpen(false);
    setHoldDialog({ open: true, order, emailProvidedOrderNo: undefined });
    setHoldReason("");
    setHoldCategory("cancel_order");
  }

  function openHoldEmailProvidedHoldDialog(orderNo: string) {
    setHoldPending(null);
    setHoldConfirmOpen(false);
    setHoldDialog({ open: true, order: undefined, emailProvidedOrderNo: orderNo.trim() });
    setHoldReason("");
    setHoldCategory("cancel_order");
  }

  function requestHoldConfirm() {
    const fromEmail = String(holdDialog.emailProvidedOrderNo ?? "").trim();
    if (fromEmail) {
      setHoldPending({
        mode: "email_provided",
        orderNo: fromEmail,
        reason: holdReason,
        category: holdCategory,
      });
      setHoldDialog({ open: false });
      setHoldConfirmOpen(true);
      return;
    }
    const order = holdDialog.order;
    if (!order?.id) return;
    setHoldPending({
      mode: "linked",
      orderId: order.id,
      orderNo: String(order.order_no ?? ""),
      reason: holdReason,
      category: holdCategory,
    });
    setHoldDialog({ open: false });
    setHoldConfirmOpen(true);
  }

  async function executeHoldSubmit() {
    const p = holdPending;
    if (!p) return;
    setHoldSubmitting(true);
    const body =
      p.mode === "linked"
        ? {
            order_id: p.orderId,
            action: "hold" as const,
            intercept_reason: p.reason,
            reason_category: p.category,
            email_id: selectedId,
            trigger_source: "manual",
          }
        : {
            email_id: selectedId,
            order_no: p.orderNo,
            action: "hold" as const,
            intercept_reason: p.reason,
            reason_category: p.category,
            trigger_source: "manual",
          };
    const { data, error } = await supabase.functions.invoke("risk-intercept", { body });
    setHoldSubmitting(false);
    if (error || data?.error) {
      const detail = error ? await formatFunctionsInvokeError(error) : formatInvokeBodyField(data?.error);
      toast.error("操作失败：" + detail);
      return;
    }
    const holdSync = (data as { result?: { linked_orders_hold_synced?: number } } | null | undefined)?.result
      ?.linked_orders_hold_synced;
    const linkedSynced =
      p.mode === "email_provided" && typeof holdSync === "number" ? holdSync : 0;
    toast.success(
      p.mode === "linked"
        ? "已暂停发货（本地订单已标记；ERP 拦截对接见文档）"
        : linkedSynced > 0
          ? `已按邮件单号完成拦截（ERP + 风控日志），已同步 ${linkedSynced} 个本邮件关联的同号订单为本地「暂停发货」展示；放行请在 ERP 后台操作`
          : "已按邮件单号完成拦截（ERP + 风控日志）；未匹配到本邮件已关联的同号订单，本地订单行未改",
    );
    setHoldConfirmOpen(false);
    setHoldPending(null);
    if (selected) loadDetail(selected);
  }

  async function syncMailboxes() {
    setSyncing(true);
    try {
      const rows = await fetchAccessibleMailboxes();
      if (rows.length === 0) {
        toast.message(hasMailboxAccess ? "没有启用的邮箱" : "未分配授权邮箱，请联系管理员");
        return;
      }

      let grandTotalInserted = 0;
      let grandHistoryRemaining = 0;
      let grandEmptyBodyRemaining = 0;
      let grandRepaired = 0;
      const failures: string[] = [];

      for (const mb of rows) {
        const label = mb.email_address ?? mb.id;
        const outcome = await runPhasedMailboxSync({
          mailboxId: mb.id,
          onProgress: (p) => {
            toast.message(
              `[${label}] ${getSyncPhaseLabel(p.phase)} 第 ${p.batch} 批 / 第 ${p.round} 轮：${formatSyncPhaseProgress(p.phase, p)}`,
            );
          },
        });
        if (outcome.failed) {
          failures.push(`${label}：${outcome.errorMessage ?? "同步失败"}`);
          continue;
        }
        grandTotalInserted += outcome.totalInserted;
        grandHistoryRemaining += outcome.historyRemaining;
        grandEmptyBodyRemaining += outcome.emptyBodyRemaining;
        grandRepaired += outcome.totalRepaired;
      }

      if (failures.length > 0) {
        toast.error(failures.slice(0, 3).join("；") + (failures.length > 3 ? `…等 ${failures.length} 条` : ""));
      }
      if (grandTotalInserted > 0 || grandRepaired > 0) {
        let message = `同步完成：新增 ${grandTotalInserted} 封`;
        if (grandRepaired > 0) message += `，补正文 ${grandRepaired} 封`;
        if (grandHistoryRemaining > 0 || grandEmptyBodyRemaining > 0) {
          const parts: string[] = [];
          if (grandHistoryRemaining > 0) parts.push(`历史约 ${grandHistoryRemaining} 封`);
          if (grandEmptyBodyRemaining > 0) parts.push(`空正文约 ${grandEmptyBodyRemaining} 封`);
          message = `${message}；仍剩 ${parts.join("、")}，可再次点击继续`;
        } else if (failures.length === 0) {
          message += "（历史与空正文已处理完本轮）";
        }
        toast.success(message);
      } else if ((grandHistoryRemaining > 0 || grandEmptyBodyRemaining > 0) && failures.length === 0) {
        toast.message(
          `本次未新增邮件；仍剩历史约 ${grandHistoryRemaining} 封、空正文约 ${grandEmptyBodyRemaining} 封，可再次点击继续`,
        );
      } else if (failures.length === 0) {
        toast.success("同步完成，共新增 0 封邮件");
      }
      await loadEmails({ keepSelection: true });
    } finally {
      setSyncing(false);
    }
  }

  async function sendReply() {
    if (!selectedId || !replyContent.trim()) return;
    if (replyAttachments.some((a) => a.uploading)) {
      toast.error("请等待附件上传完成");
      return;
    }
    if (replyAttachments.some((a) => a.error)) {
      toast.error("请移除上传失败的附件后再发送");
      return;
    }
    const readyAttachments = replyAttachments.filter((a) => a.storagePath);
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-reply", {
        body: {
          email_id: selectedId,
          content: replyContent,
          ...(replySubjectOverride ? { subject_override: replySubjectOverride } : {}),
          ...(lastQuickReplyTemplateId ? { quick_reply_template_id: lastQuickReplyTemplateId } : {}),
          ...(readyAttachments.length
            ? {
              attachments: readyAttachments.map((a) => ({
                storage_path: a.storagePath!,
                filename: sanitizeOutboundFilename(a.file.name),
                content_type: a.file.type || "application/octet-stream",
              })),
            }
            : {}),
        },
      });
      if (error) {
        toast.error("发送失败：" + (await formatFunctionsInvokeError(error)));
        return;
      }
      if (data?.error) {
        toast.error("发送失败：" + data.error);
        return;
      }
      if (!data?.success) {
        toast.error("发送失败：未收到服务器确认，请稍后重试");
        return;
      }
      if (data?.warning) toast.warning(data.warning);
      else toast.success(data?.deduped ? "邮件已发送（重复请求已忽略）" : "邮件已发送");
      setReplySubjectOverride(null);
      setLastQuickReplyTemplateId(null);
      setReplyAttachments([]);
      void loadEmails({ keepSelection: true });
      if (selected) loadDetail(selected);
    } catch (e) {
      toast.error("发送失败：" + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSending(false);
    }
  }

  async function handleSelectEmail(email: Email) {
    setSelectedId(email.id);
    if (email.status !== "pending") return;

    // 点击待处理邮件即视为开始处理，自动流转到 processing
    setEmails((prev) => prev.map((item) => (item.id === email.id ? { ...item, status: "processing" } : item)));

    const { error } = await supabase
      .from("emails")
      .update({ status: "processing" } as any)
      .eq("id", email.id);
    if (error) {
      toast.error("自动更新处理中失败：" + error.message);
      void loadEmails({ keepSelection: true });
      return;
    }

    await supabase.from("email_processing_events").insert({
      email_id: email.id,
      event_type: "status_updated_by_user",
      actor_type: "user",
      title: "人工改为处理中",
      detail: "通过打开邮件自动流转",
      metadata: { before: "pending", after: "processing", trigger: "open_email" },
    } as any);

    void loadEmails({ keepSelection: true });
  }

  /** 关联筛选含补偿任务语义时，在当前页做二次过滤 */
  const listEmails = useMemo(() => {
    if (associationFilter === "all") return emails;
    return emails.filter(
      (e) =>
        effectiveAssociationStatus(e, compensationHint(e.id)) === associationFilter,
    );
  }, [emails, associationFilter, compensationByEmailId]);

  const hasActiveListFilters = useMemo(
    () =>
      !isDefaultWorkbenchQueryState({
        dateFrom: listDateFrom,
        dateTo: listDateTo,
        status: filter,
        mailbox: mailboxFilter,
        intent: intentFilter,
        association: associationFilter,
        sla: timeFilter,
        search: searchInput.trim(),
        page: listPage,
      }),
    [
      listDateFrom,
      listDateTo,
      filter,
      mailboxFilter,
      intentFilter,
      associationFilter,
      timeFilter,
      searchInput,
      listPage,
    ],
  );

  const resetListFilters = useCallback(() => {
    const defaults = defaultWorkbenchViewState();
    setListDateRange(clampWorkbenchDateRange(defaults.dateFrom, defaults.dateTo));
    setFilter(defaults.status);
    setMailboxFilter(defaults.mailbox);
    setIntentFilter(defaults.intent);
    setAssociationFilter(defaults.association);
    setTimeFilter(defaults.sla);
    setSearchInput(defaults.search);
    setSearch(defaults.search);
    setListPage(defaults.page);
    pendingListScrollRestoreRef.current = null;
    pendingListScrollAnchorRef.current = null;
    shouldRestoreListScrollRef.current = false;
    listScrollPreserveAfterLoadRef.current = null;
    clearWorkbenchListScrollTop();
    const viewport = listScrollViewportRef.current;
    if (viewport) viewport.scrollTop = 0;
  }, []);

  const getCurrentListScrollAnchor = useCallback((): WorkbenchListScrollAnchor | null => {
    const viewport = listScrollViewportRef.current;
    if (!viewport) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const rows = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-workbench-email-id]"),
    );
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewportRect.top) continue;
      const emailId = row.dataset.workbenchEmailId;
      if (!emailId) return null;
      return {
        emailId,
        offsetTop: Math.max(0, rect.top - viewportRect.top),
      };
    }
    return null;
  }, []);

  const saveListScrollPosition = useCallback(() => {
    const viewport = listScrollViewportRef.current;
    if (!viewport) return;
    writeWorkbenchListScrollTop(viewport.scrollTop);
    writeWorkbenchListScrollAnchor(getCurrentListScrollAnchor());
  }, [getCurrentListScrollAnchor]);

  useEffect(() => {
    return () => {
      saveListScrollPosition();
    };
  }, [saveListScrollPosition]);

  useEffect(() => {
    const viewport = listScrollViewportRef.current;
    if (!viewport) return;

    const onScroll = saveListScrollPosition;
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [listEmails.length, saveListScrollPosition]);

  useEffect(() => {
    if (listLoading || listEmails.length === 0) return;
    const preserve = listScrollPreserveAfterLoadRef.current;
    if (preserve == null || shouldRestoreListScrollRef.current) return;
    listScrollPreserveAfterLoadRef.current = null;

    let frame = 0;
    let frameId = 0;
    const applyPreserve = () => {
      const viewport = listScrollViewportRef.current;
      if (!viewport) return;
      const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (maxTop > 0) {
        viewport.scrollTop = Math.min(preserve, maxTop);
        return;
      }
      if (frame >= 20) return;
      frame += 1;
      frameId = requestAnimationFrame(applyPreserve);
    };

    frameId = requestAnimationFrame(applyPreserve);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [listLoading, listEmails.length]);

  useEffect(() => {
    if (!shouldRestoreListScrollRef.current) return;
    if (listLoading || listEmails.length === 0) return;
    const top = pendingListScrollRestoreRef.current;
    const anchor = pendingListScrollAnchorRef.current;
    if (top == null && anchor == null) {
      shouldRestoreListScrollRef.current = false;
      return;
    }

    let frame = 0;
    let frameId = 0;
    const finishRestore = () => {
      pendingListScrollAnchorRef.current = null;
      pendingListScrollRestoreRef.current = null;
      shouldRestoreListScrollRef.current = false;
    };
    const restore = () => {
      const viewport = listScrollViewportRef.current;
      if (!viewport) return;
      if (anchor) {
        const row = viewport.querySelector<HTMLElement>(
          `[data-workbench-email-id="${CSS.escape(anchor.emailId)}"]`,
        );
        if (row) {
          const viewportRect = viewport.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          viewport.scrollTop += rowRect.top - viewportRect.top - anchor.offsetTop;
          finishRestore();
          return;
        }
      }
      const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (maxTop > 0) {
        if (top != null) viewport.scrollTop = Math.min(top, maxTop);
        finishRestore();
        return;
      }
      if (frame >= 40) {
        finishRestore();
        return;
      }
      frame += 1;
      frameId = requestAnimationFrame(restore);
    };

    frameId = requestAnimationFrame(restore);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [listLoading, listEmails.length, listPage]);

  const activeMoreFilterSummary = useMemo(() => {
    const parts: string[] = [];
    const defaultFrom = defaultWorkbenchListDateFrom();
    const defaultTo = defaultWorkbenchListDateTo();
    if (listDateFrom !== defaultFrom || listDateTo !== defaultTo) {
      parts.push(workbenchListDateRangeLabel(listDateFrom, listDateTo));
    }
    if (intentFilter !== "all") {
      const o = BUSINESS_INTENT_OPTIONS.find((x) => x.value === intentFilter);
      parts.push(o?.label ?? intentFilter);
    }
    if (associationFilter !== "all") {
      const o = ASSOCIATION_FILTER_OPTIONS.find((x) => x.value === associationFilter);
      parts.push(o?.label ?? associationFilter);
    }
    if (timeFilter !== "all") parts.push(SLA_BUCKET_LABEL[timeFilter] ?? timeFilter);
    return parts;
  }, [listDateFrom, listDateTo, intentFilter, associationFilter, timeFilter]);

  const listPageCount = Math.max(1, Math.ceil(listTotal / WORKBENCH_LIST_PAGE_SIZE));
  const listPageSafe = Math.min(listPage, listPageCount - 1);

  useEffect(() => {
    if (listPage > 0 && listPage >= listPageCount) {
      setListPage(Math.max(0, listPageCount - 1));
    }
  }, [listPage, listPageCount]);

  return (
    <div className="h-screen flex">
      {/* 邮件列表 */}
      <div className="w-80 border-r flex flex-col bg-card">
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center justify-between gap-1">
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-sm">邮件队列</h2>
              <p className="text-[10px] text-muted-foreground leading-snug">
                {listLoading
                  ? "加载中…"
                  : `${workbenchListDateRangeLabel(listDateFrom, listDateTo)} · 共 ${listTotal} 封 · 第 ${listPageSafe + 1}/${listPageCount} 页`}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-1.5 text-xs shrink-0"
              onClick={syncMailboxes}
              disabled={syncing || !hasMailboxAccess || grantsLoading}
            >
              {syncing ? "同步中" : "同步"}
            </Button>
          </div>
          <Select value={mailboxSelectValue} onValueChange={setMailboxFilter}>
            <SelectTrigger className="h-8 text-xs">
              <MailIcon className="w-3.5 h-3.5 mr-1 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部邮箱（{mailboxes.length}）</SelectItem>
              {mailboxes.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.display_name || m.email_address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1 flex-wrap">
            {(["all", "pending", "auto_replied", "replied"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                className="h-7 px-2 text-xs flex-1 min-w-[52px]"
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "全部"
                  : f === "pending" ? "待处理"
                  : f === "auto_replied" ? "自动回复"
                  : "已回复"}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索发件人、主题、摘要、Message-ID…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-7 h-8 text-sm"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs shrink-0"
              onClick={resetListFilters}
              disabled={!hasActiveListFilters}
            >
              重置
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs shrink-0 gap-0.5"
              onClick={() => setListFiltersCollapsed(!listFiltersCollapsed)}
            >
              {listFiltersCollapsed ? "更多查询" : "收起"}
              {listFiltersCollapsed ? (
                <ChevronDown className="w-3 h-3 opacity-70" />
              ) : (
                <ChevronDown className="w-3 h-3 opacity-70 rotate-180" />
              )}
            </Button>
          </div>
          {listFiltersCollapsed && activeMoreFilterSummary.length > 0 && (
            <p className="text-[10px] text-muted-foreground leading-snug truncate" title={activeMoreFilterSummary.join(" · ")}>
              已选：{activeMoreFilterSummary.join(" · ")}
            </p>
          )}
          {!listFiltersCollapsed && (
            <>
              <WorkbenchDateRangePicker
                dateFrom={listDateFrom}
                dateTo={listDateTo}
                onChange={(from, to) => {
                  setListDateRange(clampWorkbenchDateRange(from, to));
                  setListPage(0);
                }}
              />
              <div className="grid grid-cols-2 gap-1">
                <Select value={intentSelectValue} onValueChange={setIntentFilter}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="意图" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部意图</SelectItem>
                    {BUSINESS_INTENT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={associationSelectValue} onValueChange={setAssociationFilter}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ASSOCIATION_FILTER_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Select value={timeFilter} onValueChange={(v) => setTimeFilter(v as "all" | SlaBucket)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="时效" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部时间</SelectItem>
                  <SelectItem value="within_24h">&lt;24h</SelectItem>
                  <SelectItem value="within_48h">24-48h</SelectItem>
                  <SelectItem value="within_72h">48-72h</SelectItem>
                  <SelectItem value="over_72h">72h+</SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
        </div>

        {!hasMailboxAccess && !grantsLoading && (
          <div className="mx-3 mb-2 p-3 rounded-md border border-warning/40 bg-warning/10 text-xs text-muted-foreground">
            当前账号未分配授权邮箱，无法查看或处理邮件。请联系管理员在用户管理中配置。
          </div>
        )}

        <ScrollArea viewportRef={listScrollViewportRef} className="flex-1 min-h-0">
          {listEmails.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              {grantsLoading || authGateLoading
                ? "加载权限…"
                : !hasMailboxAccess
                  ? "暂无授权邮箱"
                  : listLoading
                    ? "加载中…"
                    : "当前条件下暂无邮件"}
            </div>
          ) : (
            listEmails.map((email) => {
              const statusBar =
                email.status === "pending" || email.status === "processing" ? "bg-warning"
                : email.status === "replied" && email.processing_status === "auto_replied" ? "bg-info"
                : email.status === "replied" ? "bg-success"
                : "bg-muted";
              const missing = (email.missing_elements ?? []) as string[];
              return (
                <button
                  key={email.id}
                  data-workbench-email-id={email.id}
                  onClick={() => handleSelectEmail(email)}
                  className={`w-full text-left p-3 pl-4 border-b hover:bg-accent transition-colors relative ${
                    selectedId === email.id ? "bg-accent" : ""
                  } ${!email.is_read ? "font-medium" : ""}`}
                >
                  <span className={`absolute left-0 top-0 bottom-0 w-1 ${statusBar}`} />
                  <div className="flex items-start justify-between gap-2 mb-1 min-w-0">
                    <div className="text-sm truncate flex-1 min-w-0">{decodeRfc2047(email.from_name) ?? email.from_email}</div>
                    <div className="shrink-0">
                      <StatusBadge status={email.status} processingStatus={email.processing_status} />
                    </div>
                  </div>
                  <div className="text-xs truncate text-foreground/80">{decodeRfc2047(email.subject) || "(无主题)"}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 max-h-5 overflow-hidden leading-5 line-clamp-1">
                    {email.ai_summary?.trim() || "(无摘要)"}
                  </div>
                  <div className="flex items-start mt-1.5 gap-1 min-w-0">
                    <span className="text-[10px] text-muted-foreground shrink-0 pt-[1px]">
                      {formatListDateTimeCST(email.received_at)}
                    </span>
                    <div className="flex gap-1 flex-wrap min-w-0">
                      {email.business_intent && (
                        <Badge variant="outline" className="text-[10px] py-0.5 h-auto border-primary/40 text-primary whitespace-normal break-words">
                          {businessIntentLabel(email.business_intent)}
                        </Badge>
                      )}
                      {missing.length > 0 && (
                        <Badge variant="outline" className="text-[10px] py-0.5 h-auto border-warning text-warning whitespace-normal break-words">
                          <AlertCircle className="w-2.5 h-2.5 mr-0.5" />
                          <span>
                            {missing.map((m) =>
                              m === "order_no"
                                ? "无单号"
                                : m === "image"
                                  ? "无图"
                                  : m === "attachment"
                                    ? "无附件"
                                    : m === "product"
                                      ? "无产品"
                                      : m,
                            ).join("·")}
                          </span>
                        </Badge>
                      )}
                      <Badge
                        variant={
                          effectiveAssociationStatus(email, compensationHint(email.id)) === "unlinked"
                            ? "outline"
                            : "secondary"
                        }
                        className={`text-[10px] py-0.5 h-auto whitespace-normal break-words ${
                          effectiveAssociationStatus(email, compensationHint(email.id)) === "unlinked"
                            ? "text-muted-foreground border-muted-foreground/30"
                            : ""
                        }`}
                      >
                        {associationStatusLabel(
                          effectiveAssociationStatus(email, compensationHint(email.id)),
                        )}
                      </Badge>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </ScrollArea>
        <TableListPagination
          page={listPage}
          total={listTotal}
          pageSize={WORKBENCH_LIST_PAGE_SIZE}
          loading={listLoading}
          onPageChange={setListPage}
          showTotal={false}
          className="px-2"
        />
      </div>

      {/* 邮件详情 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MailIcon className="w-12 h-12 mx-auto mb-2 opacity-30" />
              <div>请选择一封邮件</div>
            </div>
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="p-6 max-w-4xl mx-auto space-y-4">
              {/* 邮件头 */}
              <div>
                <h1 className="text-xl font-semibold mb-2">{decodeRfc2047(selected.subject) || "(无主题)"}</h1>
                <div className="flex items-center gap-3 text-sm flex-wrap">
                  <div>
                    <span className="text-muted-foreground">发件人：</span>
                    <span className="font-medium">{decodeRfc2047(selected.from_name) ?? selected.from_email}</span>
                    <span className="text-muted-foreground"> &lt;{selected.from_email}&gt;</span>
                  </div>
                  <Separator orientation="vertical" className="h-4" />
                  <div>
                    <span className="text-muted-foreground">收件人：</span>
                    <span className="font-medium">{selected.to_email || "—"}</span>
                  </div>
                  <Separator orientation="vertical" className="h-4" />
                  <span className="text-muted-foreground">
                    {new Date(selected.received_at).toLocaleString("zh-CN")}
                  </span>
                  <StatusBadge status={selected.status} processingStatus={selected.processing_status} />
                </div>
                <div className="mt-2 text-xs">
                  <span className="text-muted-foreground">Message-ID：</span>
                  <span
                    className="font-mono break-all"
                    title={selected.message_id ?? undefined}
                  >
                    {selected.message_id?.trim() ? selected.message_id : "—"}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
                  <Card className="p-2">
                    <div className="text-muted-foreground">AI 摘要</div>
                    <div className="mt-1 line-clamp-3">{selected.ai_summary || "未分析"}</div>
                  </Card>
                  <Card className="p-2">
                    <div className="text-muted-foreground">业务意图（可改）</div>
                    <div className="mt-1">
                      <Select
                        value={
                          isKnownBusinessIntent(selected.business_intent)
                            ? selected.business_intent
                            : undefined
                        }
                        onValueChange={(v) => updateBusinessIntent(v as BusinessIntent)}
                        disabled={savingIntent}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue placeholder={businessIntentLabel(selected.business_intent)} />
                        </SelectTrigger>
                        <SelectContent>
                          {BUSINESS_INTENT_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selected.intent_legacy && (
                        <div className="text-[10px] text-muted-foreground mt-1">legacy: {selected.intent_legacy}</div>
                      )}
                    </div>
                  </Card>
                  <Card className="p-2">
                    <div className="text-muted-foreground">关联状态</div>
                    <div className="mt-1">
                      {associationStatusLabel(
                        orders.length > 0
                          ? "linked"
                          : effectiveAssociationStatus(
                              selected,
                              compensationHint(selected?.id),
                            ),
                      )}
                    </div>
                  </Card>
                  <Card className="p-2">
                    <div className="text-muted-foreground">SLA</div>
                    <div className="mt-1">
                      {(selected.status === "pending" || selected.status === "processing") ? (() => {
                        const bucket = computeSlaBucket(selected.received_at);
                        return bucket ? SLA_BUCKET_LABEL[bucket] : "—";
                      })() : <span className="text-muted-foreground">—（仅待处理/处理中）</span>}
                    </div>
                  </Card>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-8 text-xs"
                      disabled={!selectedId || reanalyzing}
                      title="仅重跑 Dify/本地分析并更新摘要与意图；不会自动关联订单、风控或发信"
                      onClick={reanalyzeEmail}
                    >
                      <RefreshCw className={reanalyzing ? "w-3.5 h-3.5 mr-1.5 animate-spin" : "w-3.5 h-3.5 mr-1.5"} />
                      {reanalyzing ? "分析中…" : "再次分析"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      disabled={!selectedId || refreshingEmailDetail}
                      title="仅刷新当前邮件的正文、AI 摘要、订单关联与时间线，不刷新整页与邮件列表"
                      onClick={() => void refreshSelectedEmail({ showToast: true })}
                    >
                      <RefreshCw className={refreshingEmailDetail ? "w-3.5 h-3.5 mr-1.5 animate-spin" : "w-3.5 h-3.5 mr-1.5"} />
                      {refreshingEmailDetail ? "刷新中…" : "刷新本邮件"}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {(selected.status === "pending" || selected.status === "processing") && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updatingStatus}
                        onClick={() => updateEmailStatus("replied")}
                      >
                        {updatingStatus ? "处理中..." : "标记为已回复"}
                      </Button>
                    )}
                    {selected.status === "replied" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updatingStatus}
                        onClick={() => updateEmailStatus("processing")}
                      >
                        {updatingStatus ? "处理中..." : "改回处理中"}
                      </Button>
                    )}
                  </div>
                </div>
                {(selected.missing_elements ?? []).length > 0 && (
                  <div className="mt-2 p-2 bg-warning/10 border border-warning/30 rounded text-xs text-warning flex items-center gap-2">
                    <AlertCircle className="w-3.5 h-3.5" />
                    检测到要素缺失：
                    {(selected.missing_elements as string[]).map((m) => (
                      <Badge key={m} variant="outline" className="text-[10px] border-warning text-warning">
                        {m === "order_no"
                          ? "无订单号"
                          : m === "image"
                            ? "无图片"
                            : m === "attachment"
                              ? "无附件"
                              : m === "product"
                                ? "无产品名"
                                : m}
                      </Badge>
                    ))}
                    {isAdmin ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="link"
                        className="text-warning h-auto p-0 ml-auto shrink-0"
                        onClick={() => navigate("/auto-reply-templates")}
                      >
                        自动回邮配置
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="link"
                      className="text-warning h-auto p-0 shrink-0"
                      onClick={() => navigate("/quick-reply-templates")}
                    >
                      管理快捷回复
                    </Button>
                  </div>
                )}
              </div>

              {/* 正文 */}
              <div>
                <h3 className="font-medium text-sm mb-2 flex items-center gap-2 flex-wrap">
                  <span>邮件正文</span>
                  {bodyRepairingId === selected.id && (
                    <span className="text-[10px] font-normal text-muted-foreground inline-flex items-center gap-1">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      正在快速补拉正文…
                    </span>
                  )}
                  {(bodyRepairUiStatus === "queued" || bodyRepairUiStatus === "not_found_retrying") &&
                    bodyRepairingId !== selected.id && (
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {bodyRepairTaskHint ??
                        (bodyRepairUiStatus === "not_found_retrying"
                          ? "后台正在重新定位原邮件，请稍候"
                          : "已加入后台队列，约每 3 分钟处理")}
                    </span>
                  )}
                  {bodyRepairUiStatus === "failed_terminal" && isEmailBodyEmpty(selected) && (
                    <span className="text-[10px] font-normal text-destructive max-w-md">
                      {bodyRepairTaskHint ?? "邮箱中找不到该邮件，无法补拉正文"}
                    </span>
                  )}
                  {(refreshingEmailDetail || bodyRepairUiStatus === "done") && bodyRepairingId !== selected.id && (
                    <Button
                      type="button"
                      size="sm"
                      variant="link"
                      className="text-[10px] h-auto p-0"
                      disabled={refreshingEmailDetail}
                      onClick={() => void refreshSelectedEmail({ showToast: true })}
                    >
                      刷新本邮件
                    </Button>
                  )}
                  {bodyRepairUiStatus === "failed" && isEmailBodyEmpty(selected) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="link"
                      className="text-[10px] h-auto p-0"
                      onClick={() => void repairEmailBodyIfNeeded(selected.id, true)}
                    >
                      重新补拉正文
                    </Button>
                  )}
                </h3>
                <Card className="p-4 bg-muted/30 overflow-hidden">
                  {isEmailBodyEmpty(selected) && bodyRepairingId !== selected.id &&
                    bodyRepairUiStatus !== "queued" && bodyRepairUiStatus !== "not_found_retrying" &&
                    bodyRepairUiStatus !== "failed_terminal" ? (
                    <p className="text-xs text-muted-foreground">
                      暂无正文。打开邮件时会自动尝试快速补拉；也可在邮箱设置中执行「同步邮箱」批量补拉。
                    </p>
                  ) : isEmailBodyEmpty(selected) &&
                    (bodyRepairUiStatus === "queued" || bodyRepairUiStatus === "not_found_retrying") ? (
                    <p className="text-xs text-muted-foreground">
                      正文较大或邮箱响应较慢，后台正在补拉；完成后将自动更新本邮件，无需刷新整页。
                    </p>
                  ) : (
                    <>
                      <EmailBody
                        bodyText={selected.body_text}
                        bodyHtml={selected.body_html}
                        attachments={selected.attachments as Record<string, unknown>[] | undefined}
                        attachmentPreviewUrls={attachmentPreviewUrls}
                      />
                      {(() => {
                        const { inlineImages } = partitionWorkbenchAttachments(
                          selected.attachments as Record<string, unknown>[] | undefined,
                          selected,
                        );
                        if (inlineImages.length === 0) return null;
                        return (
                          <div className="mt-3 space-y-2 border-t pt-3">
                            {inlineImages.map(({ item, index }) => {
                              const filename = displayAttachmentFilename(item);
                              const previewUrl = attachmentPreviewUrls[index] || "";
                              if (!previewUrl) {
                                return (
                                  <p key={index} className="text-xs text-muted-foreground">
                                    {filename}（图片加载中…）
                                  </p>
                                );
                              }
                              return (
                                <img
                                  key={index}
                                  src={previewUrl}
                                  alt={filename}
                                  className="max-w-full h-auto rounded border bg-background"
                                />
                              );
                            })}
                          </div>
                        );
                      })()}
                    </>
                  )}
                </Card>
              </div>

              {/* 附件 */}
              {(() => {
                const { fileAttachments } = partitionWorkbenchAttachments(
                  selected.attachments as Record<string, unknown>[] | undefined,
                  selected,
                );
                if (fileAttachments.length === 0) return null;
                const hasPlaceholderAttachments = fileAttachments.some(({ item }) =>
                  isPlaceholderAttachment(item),
                );
                const pendingAttCount = placeholderAttachmentCount(
                  selected.attachments as Record<string, unknown>[] | undefined,
                );
                const attachmentTitle = hasPlaceholderAttachments && pendingAttCount > 0
                  ? `附件（约 ${pendingAttCount} 个，待补拉）`
                  : `附件 (${fileAttachments.length})`;
                return (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="font-medium text-sm">{attachmentTitle}</h3>
                    {hasPlaceholderAttachments && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void repairSelectedEmailAttachments({ force: true })}
                        disabled={repairingSelectedAttachments}
                      >
                        {repairingSelectedAttachments ? "补拉中…" : "补拉本邮件附件"}
                      </Button>
                    )}
                  </div>
                  {hasPlaceholderAttachments && autoRepairingAttachmentEmailId === selected?.id && (
                    <p className="mb-2 text-xs text-muted-foreground">
                      检测到历史占位附件，正在自动补拉本邮件附件…
                    </p>
                  )}
                  {hasPlaceholderAttachments && attachmentRepairTaskHint && (
                    <p className="mb-2 text-xs text-muted-foreground">{attachmentRepairTaskHint}</p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    {fileAttachments.map(({ item: a, index: i }) => {
                      const placeholder = isPlaceholderAttachment(a);
                      const contentType = String(a.contentType ?? "");
                      const filename = displayAttachmentFilename(a);
                      const isImg =
                        contentType.startsWith("image/") ||
                        /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(filename);
                      const previewOrUrl =
                        attachmentPreviewUrls[i] ||
                        (typeof a.url === "string" ? a.url : "") ||
                        "";
                      const downloadOrUrl =
                        attachmentDownloadUrls[i] ||
                        (typeof a.url === "string" ? a.url : "") ||
                        "";
                      const hasLink = !placeholder && Boolean(downloadOrUrl || previewOrUrl);
                      const imgSrc = isImg && previewOrUrl ? previewOrUrl : null;
                      const statusLine = placeholder
                        ? (pendingAttCount > 0
                          ? `邮箱中约有 ${pendingAttCount} 个附件（含图片），需补拉后才能预览/下载。${String(a.note ?? "")}`
                          : String(a.note ?? "附件尚未从邮箱拉取，请点击「补拉本邮件附件」。"))
                        : hasLink
                          ? "点击下载或预览"
                          : a.storage_path
                            ? "（签名链接生成中…）"
                            : a.warning
                              ? String(a.warning)
                              : "（未上传）";
                      const inner = (
                        <>
                          {isImg && imgSrc ? (
                            <img src={imgSrc} alt={filename} className="w-12 h-12 object-cover rounded" />
                          ) : (
                            <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-muted-foreground">📎</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="truncate font-medium">{filename}</div>
                            <div className="text-muted-foreground line-clamp-3 leading-snug">
                              {a.size ? `${(Number(a.size) / 1024).toFixed(1)} KB · ` : ""}
                              {statusLine}
                            </div>
                          </div>
                        </>
                      );
                      const openInNewTab = isImg && hasLink;
                      return hasLink ? (
                        <a
                          key={i}
                          href={openInNewTab ? previewOrUrl : (downloadOrUrl || previewOrUrl)}
                          target={openInNewTab ? "_blank" : undefined}
                          rel={openInNewTab ? "noreferrer" : undefined}
                          download={openInNewTab ? undefined : filename}
                          className="flex items-center gap-2 p-2 border rounded hover:bg-muted/50 text-xs"
                        >
                          {inner}
                        </a>
                      ) : (
                        <div
                          key={i}
                          className={`flex items-center gap-2 p-2 border rounded text-xs ${
                            placeholder
                              ? "border-warning/40 bg-warning/5"
                              : "opacity-80"
                          }`}
                        >
                          {inner}
                        </div>
                      );
                    })}
                  </div>
                </div>
                );
              })()}

              {/* 同往来历史 */}
              <div>
                <button
                  type="button"
                  onClick={() => setConversationCollapsed(!conversationCollapsed)}
                  className="font-medium text-sm mb-2 flex items-center gap-1.5 w-full text-left"
                >
                  {conversationCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  )}
                  <MailIcon className="w-4 h-4" /> 同发件人与收件人历史邮件（最近 10 封）
                  {conversationEmails.length > 0 && (
                    <span className="text-xs text-muted-foreground font-normal">
                      （{conversationEmails.length} 封）
                    </span>
                  )}
                </button>
                {!conversationCollapsed && (
                  <Card className="p-3">
                    {conversationLoading ? (
                      <div className="text-xs text-muted-foreground">历史邮件加载中...</div>
                    ) : conversationEmails.length === 0 ? (
                      <div className="text-xs text-muted-foreground">暂无同一发件人与收件人的历史邮件</div>
                    ) : (
                      <div className="space-y-2">
                        {conversationEmails.map((email) => (
                          <button
                            key={email.id}
                            type="button"
                            onClick={() => handleSelectEmail(email)}
                            className="w-full text-left rounded border p-3 hover:bg-accent transition-colors"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium truncate">
                                  {decodeRfc2047(email.subject) || "(无主题)"}
                                </div>
                                <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                  <EmailBody content={email.body_text} className="text-xs line-clamp-2" />
                                </div>
                              </div>
                              <div className="shrink-0 text-right space-y-1">
                                <StatusBadge status={email.status} processingStatus={email.processing_status} />
                                <div className="text-[10px] text-muted-foreground">
                                  {new Date(email.received_at).toLocaleString("zh-CN")}
                                </div>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </Card>
                )}
              </div>

              {/* 关联订单 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-sm flex items-center gap-1.5">
                    <Package className="w-4 h-4" /> 关联订单 ({orders.length})
                  </h3>
                  <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openLinkDialog}>
                        <Link2 className="w-3 h-3 mr-1" /> 手工关联
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>关联订单</DialogTitle>
                      </DialogHeader>
                      <div className="rounded-md border p-3 space-y-2 bg-muted/30 text-xs">
                        <div className="font-medium text-foreground">从 ERP（OMS）拉取到本地</div>
                        <p className="text-muted-foreground">
                          请填写<strong>订单号或买家邮箱至少一项</strong>后从 OMS 拉取；拉取成功后可在此关联到当前邮件（不会展示全库订单列表）。
                        </p>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                          <Input
                            placeholder="订单号（与邮箱二选一或同填）"
                            value={erpPullOrderNo}
                            onChange={(e) => setErpPullOrderNo(e.target.value)}
                            className="h-8 text-xs min-w-0"
                          />
                          <Input
                            placeholder="买家邮箱（与单号二选一或同填）"
                            value={erpPullEmail}
                            onChange={(e) => setErpPullEmail(e.target.value)}
                            className="h-8 text-xs min-w-0"
                          />
                          <Button type="button" size="sm" className="h-8 shrink-0 w-full sm:w-auto" disabled={erpPulling} onClick={pullOrderFromErp}>
                            {erpPulling ? "拉取中…" : "从 OMS 拉取"}
                          </Button>
                        </div>
                      </div>
                      <Input
                        placeholder="在下列订单中搜索订单号、客户邮箱..."
                        value={orderSearch}
                        onChange={(e) => setOrderSearch(e.target.value)}
                      />
                      <ScrollArea className="h-80">
                        {allOrders.length === 0 ? (
                          <div className="text-center text-muted-foreground py-8 text-sm px-2">
                            本地尚无订单记录。请使用上方「从 OMS 拉取」，或确认 `orders` 表是否已有同步数据。
                          </div>
                        ) : (
                          (() => {
                            const filtered = allOrders.filter((o) => {
                              if (!orderSearch) return true;
                              const s = orderSearch.toLowerCase();
                              return (
                                o.order_no?.toLowerCase().includes(s) ||
                                o.customer_email?.toLowerCase().includes(s) ||
                                o.customer_name?.toLowerCase().includes(s)
                              );
                            });
                            if (filtered.length === 0) {
                              return (
                                <div className="text-center text-muted-foreground py-8 text-sm">
                                  没有匹配「{orderSearch}」的订单，请调整搜索词或先拉取 OMS。
                                </div>
                              );
                            }
                            return filtered.map((o) => {
                              const alreadyLinked = linkedOrderIds.has(o.id);
                              return (
                                <div key={o.id} className="flex items-center justify-between p-2 hover:bg-accent rounded">
                                  <div className="text-sm">
                                    <div className="font-medium">{o.order_no}</div>
                                    <div className="text-xs text-muted-foreground">
                                      {o.customer_name} · {o.product_summary}
                                    </div>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant={alreadyLinked ? "secondary" : "default"}
                                    disabled={alreadyLinked}
                                    onClick={() => linkOrder(o.id)}
                                  >
                                    {alreadyLinked ? "已关联" : "关联"}
                                  </Button>
                                </div>
                              );
                            });
                          })()
                        )}
                      </ScrollArea>
                    </DialogContent>
                  </Dialog>
                </div>
                {emailProvidedOrderNo && !hideEmailOnlyHoldButton && selectedId && (
                  <Card className="p-3 mb-3 border-border bg-muted/20 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-muted-foreground mb-0.5">
                          邮件中的订单号（可与下方已关联订单区分；若本邮件已关联同号本地订单，拦截成功后会同步本地「暂停发货」状态便于展示）
                        </div>
                        <div className="font-mono font-medium text-sm truncate" title={emailProvidedOrderNo}>
                          {emailProvidedOrderNo}
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 shrink-0"
                        onClick={() => openHoldEmailProvidedHoldDialog(emailProvidedOrderNo)}
                      >
                        <PauseCircle className="w-3.5 h-3.5 mr-1" />
                        按邮件单号暂停发货
                      </Button>
                    </div>
                  </Card>
                )}
                {orders.length === 0 &&
                  effectiveAssociationStatus(selected, compensationHint(selected?.id)) ===
                    "not_provided" && (
                  <Card className="p-2 mb-3 bg-warning/10 border-warning/30 text-xs text-warning">
                    客户未提供订单号且未关联任何订单：本系统不再展示推荐订单；请客户补充单号或人工关联订单后，可由系统或您手动发起拦截。
                  </Card>
                )}
                {recommendations.length > 0 &&
                  (orders.length > 0 ||
                    effectiveAssociationStatus(selected, compensationHint(selected?.id)) !==
                      "not_provided") && (
                  <div className="mb-3 space-y-2">
                    <div className="text-xs text-muted-foreground">系统推荐订单</div>
                    {recommendations.map((rec) => {
                      const o = rec.orders;
                      return (
                        <Card key={rec.id} className="p-2 flex items-center justify-between gap-2 bg-primary/5">
                          <div className="text-xs min-w-0">
                            <div className="font-medium">{o?.order_no} · 匹配度 {(Number(rec.score) * 100).toFixed(0)}%</div>
                            <div className="text-muted-foreground truncate">{rec.reason} · {o?.customer_email} · {o?.product_summary}</div>
                          </div>
                          <Button size="sm" className="h-7 text-xs" onClick={() => acceptRecommendation(rec)}>接受</Button>
                        </Card>
                      );
                    })}
                  </div>
                )}
                {orders.length === 0 ? (
                  <Card className="p-3 text-center text-xs text-muted-foreground">暂无关联订单</Card>
                ) : (
                  <div className="space-y-2">
                    {orders.map((o) => (
                      <Card
                        key={o._link_id}
                        className={`p-3 ${o.shipping_hold ? "border-warning/30 bg-warning/5" : "border-border"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-2 text-sm flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold">{o.order_no}</span>
                              <Badge variant={o._link_source === "manual" ? "default" : "secondary"} className="text-[10px] py-0 h-4">
                                {o._link_source === "manual" ? "手工" : "自动"}
                              </Badge>
                            </div>
                            <div className="rounded-md border bg-muted/30 px-2.5 py-2 space-y-1.5">
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                                <div>
                                  <span className="text-xs text-muted-foreground">客户姓名</span>
                                  <div className="font-medium">{o.customer_name?.trim() ? o.customer_name : "—"}</div>
                                </div>
                                <div>
                                  <span className="text-xs text-muted-foreground">订单状态</span>
                                  <div className="font-medium">{o.order_status?.trim() ? o.order_status : "—"}</div>
                                </div>
                              </div>
                              <div className="text-[11px] text-muted-foreground space-y-0.5 pt-0.5 border-t border-border/60">
                                <div>邮箱：{o.customer_email ?? "—"}</div>
                                <div>商品：{o.product_summary ?? "—"}</div>
                                <div>物流：{o.shipping_status ?? "—"} · {o.tracking_no ?? "—"}</div>
                                <div>金额：{o.amount ?? "—"} {o.currency ?? ""}</div>
                              </div>
                            </div>
                            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                              {o.shipping_hold ? (
                                <>
                                  <PauseCircle className="w-3 h-3 shrink-0 text-warning/80" />
                                  <span>发货拦截：已拦截</span>
                                  <span className="text-muted-foreground/90">（解除请在 ERP 后台）</span>
                                  {o.hold_reason ? (
                                    <span className="truncate max-w-[220px]" title={o.hold_reason}>
                                      （{o.hold_reason}）
                                    </span>
                                  ) : null}
                                </>
                              ) : (
                                <>
                                  <span className="opacity-80">发货拦截：未拦截</span>
                                </>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 text-[11px] text-muted-foreground"
                                disabled={orderRefreshId === o.id}
                                onClick={() => void refreshOrderFromErp(o)}
                              >
                                <RefreshCw
                                  className={`w-3 h-3 mr-1 ${orderRefreshId === o.id ? "animate-spin" : ""}`}
                                />
                                {orderRefreshId === o.id ? "更新中…" : "更新订单信息"}
                              </Button>
                              {!o.shipping_hold ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[11px] text-muted-foreground hover:text-foreground"
                                  onClick={() => openHoldDialog(o)}
                                >
                                  暂停发货…
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => unlinkOrder(o._link_id)}>
                            <Unlink className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </div>

              {/* AI 草稿 */}
              <div>
                <h3 className="font-medium text-sm mb-2 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-primary" /> AI 草稿生成
                </h3>
                <Card className="p-3 space-y-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">指导思想（可选 - 留空则按标准流程）</label>
                    <Textarea
                      value={guidance}
                      onChange={(e) => setGuidance(e.target.value)}
                      placeholder="例如：语气更委婉，强调我们已加急发货；或：拒绝退款但提供 10% 优惠券"
                      rows={2}
                      className="text-sm"
                    />
                  </div>
                  <Button onClick={generateDraft} disabled={!canOperate || generating} className="w-full">
                    <Sparkles className="w-4 h-4 mr-2" />
                    {generating
                      ? "AI 生成中..."
                      : drafts.length === 0
                      ? "生成 AI 草稿"
                      : `重新生成（基于指导思想）`}
                  </Button>
                  {drafts.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground">已有 {drafts.length} 版草稿，当前可切换版本后再发送</div>
                      <div className="flex gap-1 flex-wrap">
                        {drafts.map((draft) => (
                          <Button
                            key={draft.id}
                            type="button"
                            size="sm"
                            variant={selectedDraftId === draft.id ? "default" : "outline"}
                            className="h-7 text-xs"
                            onClick={() => chooseDraft(draft)}
                          >
                            v{draft.version}{draft.is_used ? " · 已发送" : ""}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              </div>

              {/* 处理时间线 */}
              <div>
                <button
                  type="button"
                  onClick={() => setTimelineCollapsed(!timelineCollapsed)}
                  className="font-medium text-sm mb-2 flex items-center gap-1.5 w-full text-left"
                >
                  {timelineCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  )}
                  <Clock3 className="w-4 h-4" /> 处理时间线
                  <span className="text-xs text-muted-foreground font-normal">
                    （{timeline.length} 条）
                  </span>
                </button>
                {!timelineCollapsed && (
                  <Card className="p-3 space-y-3">
                    {timeline.length === 0 ? (
                      <div className="text-xs text-muted-foreground">暂无处理事件</div>
                    ) : timeline.map((event) => (
                      <div key={event.id} className="border-l pl-3 text-xs">
                        <div className="font-medium">{event.title}</div>
                        {event.detail && <div className="text-muted-foreground mt-0.5">{event.detail}</div>}
                        <div className="text-[10px] text-muted-foreground mt-1">
                          {new Date(event.created_at).toLocaleString("zh-CN")} · {event.event_type}
                        </div>
                      </div>
                    ))}
                  </Card>
                )}
              </div>

              {/* 回复编辑 */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="font-medium text-sm">回复内容</h3>
                  {replySubjectOverride ? (
                    <span className="text-xs text-muted-foreground">已设置自定义主题</span>
                  ) : null}
                </div>
                <div className="relative">
                  <Textarea
                    value={replyContent}
                    onChange={(e) => setReplyContent(e.target.value)}
                    placeholder="AI 草稿生成后会自动填充到这里，可手工编辑后发送"
                    rows={10}
                    className="text-sm font-mono min-h-[240px] pb-12 pr-28 resize-y"
                  />
                  <Button
                    type="button"
                    onClick={sendReply}
                    disabled={!canOperate || !replyContent.trim() || sending}
                    size="sm"
                    className="absolute bottom-3 right-3 shadow-sm"
                  >
                    <Send className="w-4 h-4 mr-1.5" />
                    {sending ? "发送中…" : "发送回复"}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <QuickReplyPicker
                    disabled={!canOperate || !selected}
                    context={buildQuickReplyContextFromEmail(
                      selected ?? {},
                      String(orders[0]?.order_no ?? "").trim() || emailProvidedOrderNo,
                      selected?.from_email ?? "",
                    )}
                    businessIntent={selected?.business_intent}
                    onInsert={({ body, subject, templateId, mode }) => {
                      setReplyContent((prev) =>
                        mode === "replace" ? body : prev ? `${prev}\n\n${body}` : body,
                      );
                      if (subject) setReplySubjectOverride(subject);
                      setLastQuickReplyTemplateId(templateId);
                    }}
                  />
                  {user?.id ? (
                    <ReplyAttachmentBar
                      layout="toolbar"
                      disabled={!canOperate || !selected || sending}
                      userId={user.id}
                      sessionId={replyAttachmentSessionId}
                      items={replyAttachments}
                      onChange={setReplyAttachments}
                    />
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    单文件 ≤35MB，总计 ≤100MB，最多 5 个
                  </span>
                </div>
                {user?.id && replyAttachments.length > 0 ? (
                  <div className="mt-2">
                    <ReplyAttachmentBar
                      layout="list"
                      disabled={!canOperate || !selected || sending}
                      userId={user.id}
                      sessionId={replyAttachmentSessionId}
                      items={replyAttachments}
                      onChange={setReplyAttachments}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </ScrollArea>
        )}
      </div>

      {/* 暂停发货弹窗 */}
      <Dialog
        open={holdDialog.open}
        onOpenChange={(v) =>
          setHoldDialog((prev) => ({
            open: v,
            order: v ? prev.order : undefined,
            emailProvidedOrderNo: v ? prev.emailProvidedOrderNo : undefined,
          }))
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {holdDialog.emailProvidedOrderNo
                ? `按邮件单号暂停发货 - ${holdDialog.emailProvidedOrderNo}`
                : `暂停发货 - ${holdDialog.order?.order_no}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">原因分类</label>
              <Select value={holdCategory} onValueChange={setHoldCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cancel_order">客户要求取消订单</SelectItem>
                  <SelectItem value="change_address">客户要求修改收货地址</SelectItem>
                  <SelectItem value="delay_shipping">客户要求延迟发货</SelectItem>
                  <SelectItem value="sku_change">发货前更换 SKU</SelectItem>
                  <SelectItem value="payment_issue">付款/风控异常</SelectItem>
                  <SelectItem value="other">其他（待核实）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">详细说明（可选）</label>
              <Textarea
                rows={3}
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                placeholder="例如：客户邮件请求改地址为 xxx，等核实后再发货"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {holdDialog.emailProvidedOrderNo ? (
                <>
                  将向 ERP 尝试拦截（若已配置），并写入风控日志与邮件时间线；<strong>不会</strong>更新本地{" "}
                  <code className="px-1 rounded bg-muted">orders</code> 行（因未关联订单）。详见{" "}
                  <code className="px-1 rounded bg-muted">docs/erp-api-requirements.md</code>。
                </>
              ) : (
                <>
                  将在本地订单上标记暂停发货并写入风控日志；与 ERP 的拦截同步以{" "}
                  <code className="px-1 rounded bg-muted">docs/erp-api-requirements.md</code> 为准。
                </>
              )}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldDialog({ open: false })}>取消</Button>
            <Button
              onClick={requestHoldConfirm}
              disabled={
                holdSubmitting ||
                (!holdDialog.order?.id && !String(holdDialog.emailProvidedOrderNo ?? "").trim())
              }
              className="bg-warning hover:bg-warning/90 text-warning-foreground"
            >
              <PauseCircle className="w-4 h-4 mr-1" />
              下一步：确认拦截
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={holdConfirmOpen}
        onOpenChange={(open) => {
          setHoldConfirmOpen(open);
          if (!open) setHoldPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认暂停发货？</AlertDialogTitle>
            <AlertDialogDescription>
              {holdPending?.mode === "email_provided" ? (
                <>
                  将按邮件单号{" "}
                  <span className="font-medium text-foreground">{holdPending.orderNo}</span>{" "}
                  向 ERP 尝试拦截（若已配置），并写入风控日志；不会更新本地订单的暂停标记。请再次确认无误后再执行。
                </>
              ) : (
                <>
                  订单号 <span className="font-medium text-foreground">{holdPending?.orderNo ?? "—"}</span>
                  ：将向 ERP 尝试拦截（若已配置），并在本地标记暂停发货与风控日志。请再次确认无误后再执行。
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={holdSubmitting}>取消</AlertDialogCancel>
            <Button
              type="button"
              className="bg-warning hover:bg-warning/90 text-warning-foreground"
              disabled={holdSubmitting}
              onClick={() => void executeHoldSubmit()}
            >
              {holdSubmitting ? "处理中…" : "确定拦截"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
