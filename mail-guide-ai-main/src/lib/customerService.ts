// 客服域：业务意图（10 类）、关联状态、SLA 桶 的展示与计算工具
// 与后端 emails.business_intent / association_status / received_at 的口径保持一致

export type BusinessIntent =
  | "order_cancel"
  | "address_change"
  | "damaged"
  | "defect"
  | "description_mismatch"
  | "logistics"
  | "other"
  | "amazon_marketplace"
  | "product_inquiry"
  | "conversation_idle"
  | "solution_accepted";

/** 工作台/模板下拉顺序；「其他问题」置末，不展示分组标题 */
export const BUSINESS_INTENT_OPTIONS: ReadonlyArray<{ value: BusinessIntent; label: string }> = [
  { value: "order_cancel", label: "订单取消" },
  { value: "address_change", label: "订单改地址" },
  { value: "damaged", label: "破损" },
  { value: "defect", label: "产品缺陷" },
  { value: "description_mismatch", label: "商品描述不符" },
  { value: "logistics", label: "物流问题" },
  { value: "amazon_marketplace", label: "亚马逊渠道" },
  { value: "product_inquiry", label: "售前/安装咨询" },
  { value: "conversation_idle", label: "会话收尾" },
  { value: "solution_accepted", label: "接受方案" },
  { value: "other", label: "其他问题" },
];

const BUSINESS_INTENT_LABEL_MAP: Record<string, string> = Object.fromEntries(
  BUSINESS_INTENT_OPTIONS.map((o) => [o.value, o.label]),
);

export function businessIntentLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return BUSINESS_INTENT_LABEL_MAP[value] ?? value;
}

export type AssociationStatus =
  | "unlinked"
  | "not_provided"
  | "not_found"
  | "compensating"
  | "recommended"
  | "linked"
  | "manual_unlink";

export const ASSOCIATION_FILTER_OPTIONS: ReadonlyArray<{ value: AssociationStatus | "all"; label: string }> = [
  { value: "all", label: "全部关联" },
  { value: "linked", label: "已关联" },
  { value: "not_found", label: "未找到" },
  { value: "not_provided", label: "未提供" },
  { value: "compensating", label: "补偿中" },
  { value: "manual_unlink", label: "人工解除" },
];

const ASSOCIATION_LABEL_MAP: Record<string, string> = {
  linked: "已关联",
  not_provided: "未提供",
  not_found: "未找到",
  compensating: "补偿中",
  recommended: "推荐",
  unlinked: "未关联",
  manual_unlink: "人工解除",
};

export function associationStatusLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return ASSOCIATION_LABEL_MAP[value] ?? value;
}

export type CompensationTaskHint = { status: string } | null | undefined;

/** 存在 email_order_links 时一律视为已关联；补偿任务已失败时展示未找到（非补偿中） */
export function effectiveAssociationStatus(
  email: {
    association_status?: string | null;
    email_order_links?: { id?: string }[] | null;
    ai_entities?: Record<string, unknown> | null;
  } | null | undefined,
  compensationTask?: CompensationTaskHint,
): string {
  if (!email) return "unlinked";
  const links = email.email_order_links;
  const n = Array.isArray(links) ? links.length : 0;
  if (n > 0) return "linked";

  const taskStatus = compensationTask?.status;
  if (taskStatus === "failed") return "not_found";
  if (taskStatus === "pending") return "compensating";

  const s = String(email.association_status ?? "unlinked").trim();
  return s || "unlinked";
}

export type SlaBucket = "within_24h" | "within_48h" | "within_72h" | "over_72h";

export const SLA_BUCKET_LABEL: Record<SlaBucket, string> = {
  within_24h: "24小时内",
  within_48h: "48小时内",
  within_72h: "72小时内",
  over_72h: "72小时+",
};

/** 客户端按 received_at 与当前时间动态计算 SLA 桶。仅对 pending/processing 有意义。 */
export function computeSlaBucket(receivedAt: string | null | undefined): SlaBucket | null {
  if (!receivedAt) return null;
  const ms = Date.now() - new Date(receivedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  const hour = ms / 3_600_000;
  if (hour < 24) return "within_24h";
  if (hour < 48) return "within_48h";
  if (hour < 72) return "within_72h";
  return "over_72h";
}

export function slaBucketBadgeClass(bucket: SlaBucket): string {
  switch (bucket) {
    case "within_24h":
      return "bg-success/15 text-success border-success/30";
    case "within_48h":
      return "bg-primary/15 text-primary border-primary/30";
    case "within_72h":
      return "bg-warning/15 text-warning border-warning/30";
    case "over_72h":
      return "bg-destructive/15 text-destructive border-destructive/30";
  }
}
