import { useEffect, useState, useCallback } from "react";

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
import { StatusBadge } from "@/components/StatusBadge";
import { EmailBody } from "@/components/EmailBody";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ASSOCIATION_FILTER_OPTIONS,
  BUSINESS_INTENT_OPTIONS,
  associationStatusLabel,
  businessIntentLabel,
  computeSlaBucket,
  SLA_BUCKET_LABEL,
  type BusinessIntent,
  type SlaBucket,
} from "@/lib/customerService";
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
  PlayCircle,
  Clock3,
  ChevronDown,
  ChevronRight,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Email = any;
type Order = any;
type Draft = any;

export default function Workbench() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "processing" | "replied">("all");
  const [intentFilter, setIntentFilter] = useState<string>("all");
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [savingIntent, setSavingIntent] = useState(false);
  const [mailboxFilter, setMailboxFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [associationFilter, setAssociationFilter] = useState<string>("all");
  const [timeFilter, setTimeFilter] = useState<"all" | SlaBucket>("all");
  const [mailboxes, setMailboxes] = useState<{ id: string; email_address: string; display_name: string | null }[]>([]);

  const [orders, setOrders] = useState<Order[]>([]);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [conversationEmails, setConversationEmails] = useState<Email[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationCollapsed, setConversationCollapsed] = useState(true);
  const [timelineCollapsed, setTimelineCollapsed] = useState(true);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [generating, setGenerating] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [replyContent, setReplyContent] = useState("");
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  /** 手工关联弹窗：从 OMS 拉单 */
  const [erpPullOrderNo, setErpPullOrderNo] = useState("");
  const [erpPullEmail, setErpPullEmail] = useState("");
  const [erpPulling, setErpPulling] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [holdDialog, setHoldDialog] = useState<{ open: boolean; order?: Order }>({ open: false });
  const [holdReason, setHoldReason] = useState("");
  const [holdCategory, setHoldCategory] = useState("cancel_order");
  const [holdSubmitting, setHoldSubmitting] = useState(false);
  const [holdConfirmOpen, setHoldConfirmOpen] = useState(false);
  const [holdPending, setHoldPending] = useState<{
    orderId: string;
    orderNo: string;
    reason: string;
    category: string;
  } | null>(null);

  const [orderEditDialog, setOrderEditDialog] = useState<{ open: boolean; order?: Order }>({ open: false });
  const [orderEditCustomerName, setOrderEditCustomerName] = useState("");
  const [orderEditOrderStatus, setOrderEditOrderStatus] = useState("");
  const [orderEditSaving, setOrderEditSaving] = useState(false);

  /** 私有桶 email-attachments：按 storage_path 生成的短期签名 URL（索引 → url） */
  const [attachmentSignedUrls, setAttachmentSignedUrls] = useState<Record<number, string>>({});

  const selected = emails.find((e) => e.id === selectedId);

  const loadEmails = useCallback(async (): Promise<Email[]> => {
    const { data } = await supabase
      .from("emails")
      .select("*")
      .order("received_at", { ascending: false });
    const list = (data ?? []) as Email[];
    setEmails(list);
    if (list.length > 0 && !selectedId) {
      setSelectedId(list[0].id);
    }
    return list;
  }, [selectedId]);

  const loadDetail = useCallback(async (email: Email) => {
    const emailId = email.id;

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
    setOrders(
      (links ?? []).map((l: any) => ({ ...l.orders, _link_id: l.id, _link_source: l.link_source }))
    );

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
    setGuidance("");
  }, []);

  useEffect(() => {
    loadEmails();
    supabase.from("mailboxes").select("id, email_address, display_name").eq("is_active", true).then(({ data }) => {
      setMailboxes(data ?? []);
    });

    // Realtime：监听 emails 表变更，自动刷新列表
    const channel = supabase
      .channel("workbench-emails-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "emails" },
        () => { loadEmails(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  useEffect(() => {
    if (!selected?.attachments || !Array.isArray(selected.attachments)) {
      setAttachmentSignedUrls({});
      return;
    }
    let cancelled = false;
    const arr = selected.attachments as Record<string, unknown>[];
    (async () => {
      const next: Record<number, string> = {};
      const signErrors: string[] = [];
      await Promise.all(
        arr.map(async (a, i) => {
          if (typeof a?.url === "string" && a.url) {
            next[i] = a.url;
            return;
          }
          const path = a?.storage_path;
          if (typeof path !== "string" || !path) return;
          const { data, error } = await supabase.storage
            .from("email-attachments")
            .createSignedUrl(path, 3600);
          if (error) {
            console.error("[attachment signed url]", path, error.message);
            signErrors.push(error.message);
            return;
          }
          if (data?.signedUrl && !cancelled) next[i] = data.signedUrl;
        }),
      );
      if (!cancelled) {
        setAttachmentSignedUrls(next);
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
  }, [selected?.id, selected?.attachments]);

  useEffect(() => {
    if (selected) {
      loadDetail(selected);
      // 标记已读
      supabase.from("emails").update({ is_read: true }).eq("id", selected.id).then();
    }
  }, [selected, loadDetail]);

  async function generateDraft() {
    if (!selectedId) return;
    setGenerating(true);
    // 人工二次生成草稿：默认走 Dify 工作流，由后端读取上一版草稿 + 指导意见进行二次优化
    // Dify 调用失败时，后端按 GENERATE_DRAFT_FALLBACK_LOCAL 决定是否回落本地
    const { data, error } = await supabase.functions.invoke("generate-draft", {
      body: { email_id: selectedId, guidance: guidance || undefined },
    });
    setGenerating(false);
    if (error) {
      toast.error("生成失败：" + error.message);
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
      toast.warning("Dify 调用失败，已回落本地兜底草稿");
    } else {
      toast.success("草稿已生成（本地）");
    }
    if (selected) loadDetail(selected);
    loadEmails();
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
      toast.error("再次分析失败：" + error.message);
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
    const list = await loadEmails();
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
    loadEmails();
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
    loadEmails();
  }

  async function openLinkDialog() {
    const { data } = await supabase
      .from("orders")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(200);
    setAllOrders(data ?? []);
    setErpPullOrderNo("");
    setErpPullEmail(selected?.from_email ?? "");
    setLinkDialogOpen(true);
  }

  async function pullOrderFromErp() {
    const orderNo = erpPullOrderNo.trim();
    const buyerEmail = erpPullEmail.trim();
    if (!orderNo && !buyerEmail) {
      toast.error("请填写订单号或买家邮箱至少一项");
      return;
    }
    setErpPulling(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        toast.error("请先登录");
        return;
      }
      const base = import.meta.env.VITE_SUPABASE_URL as string;
      const anon = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
      const u = new URL(`${base.replace(/\/+$/, "")}/functions/v1/get-order-by-email`);
      if (orderNo) u.searchParams.set("order_no", orderNo);
      if (buyerEmail) u.searchParams.set("email", buyerEmail);
      const res = await fetch(u.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: anon,
        },
      });
      const json = (await res.json()) as {
        error?: string;
        found?: boolean;
        source?: string;
        erp_message?: string;
        erp_error?: string;
      };
      if (!res.ok && json.error) {
        toast.error(json.error);
        return;
      }
      if (json.error) {
        toast.error(json.error);
        return;
      }
      if (!json.found) {
        toast.message("未查到可关联订单", {
          description: json.erp_message || json.erp_error || "本地与 OMS 均无有效记录，或 ERP 未配置",
        });
        return;
      }
      toast.success(json.source === "erp_oms" ? "已从 OMS 拉取并写入本地" : "已在本地找到该订单");
      const { data: refreshed } = await supabase
        .from("orders")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(200);
      setAllOrders(refreshed ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "拉取失败");
    } finally {
      setErpPulling(false);
    }
  }

  async function linkOrder(orderId: string) {
    if (!selectedId) return;
    const { error } = await supabase.from("email_order_links").insert({
      email_id: selectedId,
      order_id: orderId,
      link_source: "manual",
    });
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("已关联订单");
      setLinkDialogOpen(false);
      if (selected) loadDetail(selected);
    }
  }

  async function acceptRecommendation(rec: any) {
    if (!selectedId) return;
    const order = rec.orders;
    const { error } = await supabase.from("email_order_links").insert({
      email_id: selectedId,
      order_id: order.id,
      link_source: "recommended",
      confidence: rec.score,
      metadata: { recommendation_id: rec.id, reason: rec.reason },
    } as any);
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("email_order_recommendations").update({ status: "accepted" }).eq("id", rec.id);
    await supabase.from("email_processing_events").insert({
      email_id: selectedId,
      event_type: "recommendation_accepted",
      actor_type: "user",
      title: `接受推荐订单 ${order.order_no}`,
      metadata: { recommendation_id: rec.id, order_id: order.id },
    } as any);
    toast.success("已关联推荐订单");
    if (selected) loadDetail(selected);
    loadEmails();
  }

  function chooseDraft(draft: Draft) {
    setSelectedDraftId(draft.id);
    setReplyContent(draft.draft_content);
  }

  async function unlinkOrder(linkId: string) {
    const { error } = await supabase.from("email_order_links").delete().eq("id", linkId);
    if (error) toast.error(error.message);
    else {
      toast.success("已解除关联");
      if (selected) loadDetail(selected);
    }
  }

  function openHoldDialog(order: Order) {
    setHoldPending(null);
    setHoldConfirmOpen(false);
    setHoldDialog({ open: true, order });
    setHoldReason("");
    setHoldCategory("cancel_order");
  }

  function requestHoldConfirm() {
    const order = holdDialog.order;
    if (!order?.id) return;
    setHoldPending({
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
    if (!p?.orderId) return;
    setHoldSubmitting(true);
    const { data, error } = await supabase.functions.invoke("risk-intercept", {
      body: {
        order_id: p.orderId,
        action: "hold",
        intercept_reason: p.reason,
        reason_category: p.category,
        email_id: selectedId,
        trigger_source: "manual",
      },
    });
    setHoldSubmitting(false);
    if (error || data?.error) {
      toast.error("操作失败：" + (error?.message ?? data?.error));
      return;
    }
    toast.success("已暂停发货（本地订单已标记；ERP 拦截对接见文档）");
    setHoldConfirmOpen(false);
    setHoldPending(null);
    if (selected) loadDetail(selected);
  }

  function openOrderEditDialog(order: Order) {
    setOrderEditDialog({ open: true, order });
    setOrderEditCustomerName(String(order.customer_name ?? ""));
    setOrderEditOrderStatus(String(order.order_status ?? ""));
  }

  async function saveOrderEdit() {
    const o = orderEditDialog.order;
    if (!o?.id) return;
    setOrderEditSaving(true);
    const { error } = await supabase
      .from("orders")
      .update({
        customer_name: orderEditCustomerName.trim() || null,
        order_status: orderEditOrderStatus.trim() || null,
      })
      .eq("id", o.id);
    setOrderEditSaving(false);
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
    setOrderEditDialog({ open: false });
    if (selected) loadDetail(selected);
  }

  async function releaseHold(order: Order) {
    if (!confirm(`确定恢复订单 ${order.order_no} 的发货？`)) return;
    const { data, error } = await supabase.functions.invoke("risk-intercept", {
      body: { order_id: order.id, action: "release", email_id: selectedId, trigger_source: "manual" },
    });
    if (error || data?.error) {
      toast.error("操作失败：" + (error?.message ?? data?.error));
      return;
    }
    toast.success("已恢复发货（本地订单已更新）");
    if (selected) loadDetail(selected);
  }

  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function syncMailboxes() {
    setSyncing(true);
    const MAX_ROUNDS = 20;
    try {
      const { data: activeMbs, error: listErr } = await supabase
        .from("mailboxes")
        .select("id, email_address")
        .eq("is_active", true);
      if (listErr) {
        toast.error("读取邮箱列表失败：" + listErr.message);
        return;
      }
      const rows = activeMbs ?? [];
      if (rows.length === 0) {
        toast.message("没有启用的邮箱");
        return;
      }

      let grandTotalInserted = 0;
      const failures: string[] = [];

      for (const mb of rows) {
        const label = mb.email_address ?? mb.id;
        let rounds = 0;
        while (rounds < MAX_ROUNDS) {
          rounds++;
          const { data, error } = await supabase.functions.invoke("sync-mailbox", {
            body: { mailbox_id: mb.id, force_bulk: true },
          });
          if (error) {
            failures.push(`${label}：${error.message}`);
            break;
          }
          if (data?.error) {
            failures.push(`${label}：${data.error}`);
            break;
          }
          const r = data?.results?.[0];
          if (r?.error) {
            failures.push(`${label}：${r.error}`);
            break;
          }
          if (!r) {
            failures.push(`${label}：未获取到同步结果`);
            break;
          }
          const ins = r.inserted ?? 0;
          grandTotalInserted += ins;
          toast.message(`[${label}] 第 ${rounds} 轮：新增 ${ins} 封，剩余 ${r.remaining ?? 0} 封`);
          if (!r.remaining || r.remaining === 0) break;
        }
      }

      if (failures.length > 0) {
        toast.error(failures.slice(0, 3).join("；") + (failures.length > 3 ? `…等 ${failures.length} 条` : ""));
      }
      if (grandTotalInserted > 0) {
        toast.success(
          failures.length === 0
            ? `同步完成，共新增 ${grandTotalInserted} 封邮件`
            : `同步结束，共新增 ${grandTotalInserted} 封邮件（部分邮箱失败见上方提示）`,
        );
      } else if (failures.length === 0) {
        toast.success("同步完成，共新增 0 封邮件");
      }
      await loadEmails();
    } finally {
      setSyncing(false);
    }
  }

  async function sendReply() {
    if (!selectedId || !replyContent.trim()) return;
    setSending(true);
    const { data, error } = await supabase.functions.invoke("send-reply", {
      body: { email_id: selectedId, content: replyContent },
    });
    setSending(false);
    if (error) {
      toast.error("发送失败：" + error.message);
      return;
    }
    if (data?.error) {
      toast.error("发送失败：" + data.error);
      return;
    }
    if (data?.warning) toast.warning(data.warning);
    else toast.success("邮件已发送");
    loadEmails();
    if (selected) loadDetail(selected);
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
      loadEmails();
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

    loadEmails();
  }

  const filteredEmails = emails.filter((e) => {
    if (filter !== "all") {
      if (filter === "replied") {
        if (e.status !== "replied") return false;
      } else if (e.status !== filter) {
        return false;
      }
    }
    if (mailboxFilter !== "all" && e.mailbox_id !== mailboxFilter) return false;
    if (categoryFilter !== "all" && e.category !== categoryFilter) return false;
    if (associationFilter !== "all" && e.association_status !== associationFilter) return false;
    if (intentFilter !== "all" && e.business_intent !== intentFilter) return false;
    if (timeFilter !== "all") {
      if (computeSlaBucket(e.received_at) !== timeFilter) return false;
    }
    if (search) {
      const s = search.toLowerCase();
      const mid = (e.message_id ?? "").trim().toLowerCase();
      return (
        e.from_email?.toLowerCase().includes(s) ||
        e.subject?.toLowerCase().includes(s) ||
        e.body_text?.toLowerCase().includes(s) ||
        mid.includes(s) ||
        JSON.stringify(e.ai_entities ?? {}).toLowerCase().includes(s)
      );
    }
    return true;
  });

  const categories = Array.from(new Set(emails.map((e) => e.category).filter(Boolean)));

  return (
    <div className="h-screen flex">
      {/* 邮件列表 */}
      <div className="w-80 border-r flex flex-col bg-card">
        <div className="p-3 border-b space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-sm">邮件队列</h2>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={syncMailboxes} disabled={syncing}>
                <RefreshCw className={`w-3 h-3 mr-1 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "同步中" : "同步邮箱"}
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={loadEmails}>
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索发件人、主题、正文、Message-ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7 h-8 text-sm"
            />
          </div>
          <Select value={mailboxFilter} onValueChange={setMailboxFilter}>
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
          <div className="grid grid-cols-2 gap-1">
            <Select value={intentFilter} onValueChange={setIntentFilter}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="意图" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部意图</SelectItem>
                {BUSINESS_INTENT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={associationFilter} onValueChange={setAssociationFilter}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ASSOCIATION_FILTER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="分类" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部分类</SelectItem>
                {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={timeFilter} onValueChange={(v) => setTimeFilter(v as "all" | SlaBucket)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部时间</SelectItem>
                <SelectItem value="within_24h">&lt;24h</SelectItem>
                <SelectItem value="within_48h">24-48h</SelectItem>
                <SelectItem value="within_72h">48-72h</SelectItem>
                <SelectItem value="over_72h">72h+</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-1 flex-wrap">
            {(["all", "pending", "processing", "replied"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                className="h-7 px-2 text-xs flex-1 min-w-[52px]"
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "全部"
                  : f === "pending" ? "待处理"
                  : f === "processing" ? "处理中"
                  : "已回复"}
              </Button>
            ))}
          </div>
        </div>

        <ScrollArea className="flex-1">
          {filteredEmails.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">暂无邮件</div>
          ) : (
            filteredEmails.map((email) => {
              const statusBar =
                email.status === "pending" ? "bg-warning"
                : email.status === "processing" ? "bg-primary"
                : email.status === "replied" ? "bg-success"
                : "bg-muted";
              const missing = (email.missing_elements ?? []) as string[];
              return (
                <button
                  key={email.id}
                  onClick={() => handleSelectEmail(email)}
                  className={`w-full text-left p-3 pl-4 border-b hover:bg-accent transition-colors relative ${
                    selectedId === email.id ? "bg-accent" : ""
                  } ${!email.is_read ? "font-medium" : ""}`}
                >
                  <span className={`absolute left-0 top-0 bottom-0 w-1 ${statusBar}`} />
                  <div className="flex items-start justify-between gap-2 mb-1 min-w-0">
                    <div className="text-sm truncate flex-1 min-w-0">{decodeRfc2047(email.from_name) ?? email.from_email}</div>
                    <div className="shrink-0">
                      <StatusBadge status={email.status} />
                    </div>
                  </div>
                  <div className="text-xs truncate text-foreground/80">{decodeRfc2047(email.subject) || "(无主题)"}</div>
                  <div className="text-xs text-muted-foreground mt-0.5 max-h-5 overflow-hidden leading-5">
                    <EmailBody content={email.body_text} className="text-xs truncate" />
                  </div>
                  <div className="flex items-start mt-1.5 gap-1 min-w-0">
                    <span className="text-[10px] text-muted-foreground shrink-0 pt-[1px]">
                      {formatDistanceToNow(new Date(email.received_at), { addSuffix: true, locale: zhCN })}
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
                            {missing.map((m) => m === "order_no" ? "无单号" : m === "image" ? "无图" : m === "product" ? "无产品" : m).join("·")}
                          </span>
                        </Badge>
                      )}
                      {email.association_status && email.association_status !== "unlinked" && (
                        <Badge variant="secondary" className="text-[10px] py-0.5 h-auto whitespace-normal break-words">
                          {associationStatusLabel(email.association_status)}
                        </Badge>
                      )}
                      {(() => {
                        const bucket = computeSlaBucket(email.received_at);
                        if (!bucket) return null;
                        return (
                          <Badge variant="secondary" className="text-[10px] py-0.5 h-auto whitespace-normal break-words">
                            {SLA_BUCKET_LABEL[bucket]}
                          </Badge>
                        );
                      })()}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </ScrollArea>
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
                  <StatusBadge status={selected.status} />
                  {selected.priority && selected.priority !== "normal" && (
                    <Badge variant="outline" className="border-destructive text-destructive">
                      {selected.priority === "urgent" ? "紧急优先" : "高优先"}
                    </Badge>
                  )}
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
                        value={selected.business_intent ?? ""}
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
                    <div className="mt-1">{associationStatusLabel(selected.association_status)}</div>
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
                        {m === "order_no" ? "无订单号" : m === "image" ? "无图片" : m === "product" ? "无产品名" : m}
                      </Badge>
                    ))}
                    <Button size="sm" variant="link" className="text-warning h-auto p-0 ml-auto">
                      使用模板自动回复
                    </Button>
                  </div>
                )}
              </div>

              {/* 正文 */}
              <div>
                <h3 className="font-medium text-sm mb-2">邮件正文</h3>
                <Card className="p-4 bg-muted/30 overflow-hidden">
                  <EmailBody
                    content={
                      selected.body_html?.trim()
                        ? selected.body_html
                        : selected.body_text
                    }
                  />
                </Card>
              </div>

              {/* 附件 */}
              {Array.isArray(selected.attachments) && selected.attachments.length > 0 && (
                <div>
                  <h3 className="font-medium text-sm mb-2">附件 ({selected.attachments.length})</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {(selected.attachments as any[]).map((a, i) => {
                      const contentType = String(a.contentType ?? "");
                      const isImg = contentType.startsWith("image/");
                      const signedOrUrl =
                        attachmentSignedUrls[i] ||
                        (typeof a.url === "string" ? a.url : "") ||
                        "";
                      const hasLink = Boolean(signedOrUrl);
                      const imgSrc = isImg && signedOrUrl ? signedOrUrl : null;
                      const inner = (
                        <>
                          {isImg && imgSrc ? (
                            <img src={imgSrc} alt={a.filename} className="w-12 h-12 object-cover rounded" />
                          ) : (
                            <div className="w-12 h-12 bg-muted rounded flex items-center justify-center text-muted-foreground">📎</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="truncate font-medium">{a.filename ?? "附件"}</div>
                            <div className="text-muted-foreground">
                              {a.size ? `${(Number(a.size) / 1024).toFixed(1)} KB` : ""}{" "}
                              {hasLink
                                ? ""
                                : a.storage_path
                                  ? "（签名链接生成中…）"
                                  : a.note
                                    ? String(a.note)
                                    : "（未上传）"}
                            </div>
                          </div>
                        </>
                      );
                      return hasLink ? (
                        <a
                          key={i}
                          href={signedOrUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-2 p-2 border rounded hover:bg-muted/50 text-xs"
                        >
                          {inner}
                        </a>
                      ) : (
                        <div
                          key={i}
                          className="flex items-center gap-2 p-2 border rounded text-xs opacity-80"
                        >
                          {inner}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

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
                  {!conversationLoading && conversationEmails.length > 0 && (
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
                                <StatusBadge status={email.status} />
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
                          下方列表只展示本地已存在的订单。若为空，请填写<strong>订单号或买家邮箱至少一项</strong>（可同时填）后从 OMS 拉取。
                        </p>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Input
                            placeholder="订单号（与邮箱二选一或同填）"
                            value={erpPullOrderNo}
                            onChange={(e) => setErpPullOrderNo(e.target.value)}
                            className="h-8 text-xs"
                          />
                          <Input
                            placeholder="买家邮箱（与单号二选一或同填）"
                            value={erpPullEmail}
                            onChange={(e) => setErpPullEmail(e.target.value)}
                            className="h-8 text-xs flex-1"
                          />
                          <Button type="button" size="sm" className="h-8 shrink-0" disabled={erpPulling} onClick={pullOrderFromErp}>
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
                            return filtered.map((o) => (
                              <div key={o.id} className="flex items-center justify-between p-2 hover:bg-accent rounded">
                                <div className="text-sm">
                                  <div className="font-medium">{o.order_no}</div>
                                  <div className="text-xs text-muted-foreground">
                                    {o.customer_name} · {o.product_summary}
                                  </div>
                                </div>
                                <Button size="sm" onClick={() => linkOrder(o.id)}>关联</Button>
                              </div>
                            ));
                          })()
                        )}
                      </ScrollArea>
                    </DialogContent>
                  </Dialog>
                </div>
                {selected?.association_status === "not_provided" && (
                  <Card className="p-2 mb-3 bg-warning/10 border-warning/30 text-xs text-warning">
                    客户未提供订单号且未关联任何订单：本系统不再展示推荐订单；请客户补充单号或人工关联订单后，可由系统或您手动发起拦截。
                  </Card>
                )}
                {recommendations.length > 0 && selected?.association_status !== "not_provided" && (
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
                                onClick={() => openOrderEditDialog(o)}
                              >
                                <Pencil className="w-3 h-3 mr-1" />
                                编辑订单信息
                              </Button>
                              {o.shipping_hold ? (
                                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => releaseHold(o)}>
                                  <PlayCircle className="w-3 h-3 mr-1" /> 恢复发货
                                </Button>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-[11px] text-muted-foreground hover:text-foreground"
                                  onClick={() => openHoldDialog(o)}
                                >
                                  暂停发货…
                                </Button>
                              )}
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
                  <Button onClick={generateDraft} disabled={generating} className="w-full">
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
                <h3 className="font-medium text-sm mb-2">回复内容</h3>
                <Textarea
                  value={replyContent}
                  onChange={(e) => setReplyContent(e.target.value)}
                  placeholder="AI 草稿生成后会自动填充到这里，可手工编辑后发送"
                  rows={10}
                  className="text-sm font-mono"
                />
                <div className="flex justify-end mt-2">
                  <Button onClick={sendReply} disabled={!replyContent.trim() || sending}>
                    <Send className="w-4 h-4 mr-2" /> {sending ? "发送中..." : "发送回复"}
                  </Button>
                </div>
              </div>
            </div>
          </ScrollArea>
        )}
      </div>

      {/* 暂停发货弹窗 */}
      <Dialog open={holdDialog.open} onOpenChange={(v) => setHoldDialog({ open: v, order: v ? holdDialog.order : undefined })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>暂停发货 - {holdDialog.order?.order_no}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">原因分类</label>
              <Select value={holdCategory} onValueChange={setHoldCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cancel_order">客户要求取消订单</SelectItem>
                  <SelectItem value="change_address">客户要求修改收货地址</SelectItem>
                  <SelectItem value="change_product">客户要求更换商品</SelectItem>
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
              将在本地订单上标记暂停发货并写入风控日志；与 ERP 的拦截同步以 <code className="px-1 rounded bg-muted">docs/erp-api-requirements.md</code> 为准。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHoldDialog({ open: false })}>取消</Button>
            <Button onClick={requestHoldConfirm} disabled={holdSubmitting} className="bg-warning hover:bg-warning/90 text-warning-foreground">
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
              订单号 <span className="font-medium text-foreground">{holdPending?.orderNo ?? "—"}</span>
              ：将向 ERP 尝试拦截（若已配置），并在本地标记暂停发货与风控日志。请再次确认无误后再执行。
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

      <Dialog open={orderEditDialog.open} onOpenChange={(v) => setOrderEditDialog({ open: v, order: v ? orderEditDialog.order : undefined })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑订单信息 · {orderEditDialog.order?.order_no}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">客户姓名</label>
              <Input
                value={orderEditCustomerName}
                onChange={(e) => setOrderEditCustomerName(e.target.value)}
                placeholder="与 OMS / 客户称呼一致"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">订单状态</label>
              <Input
                value={orderEditOrderStatus}
                onChange={(e) => setOrderEditOrderStatus(e.target.value)}
                placeholder="与 ERP / OMS 状态文案一致"
              />
            </div>
            <p className="text-xs text-muted-foreground">仅更新本地 `orders` 表；与 ERP 状态不一致时请按需从 OMS 重新拉取或人工对齐。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOrderEditDialog({ open: false })}>取消</Button>
            <Button onClick={() => void saveOrderEdit()} disabled={orderEditSaving}>
              {orderEditSaving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
