/** ERP 通知模板：支持 {{order_no}}、{{item_count}}、{{site_code}}、{{site_name}} */
export type ErpNotifyTemplateValues = {
  order_no: string;
  item_count: number;
  site_code: string;
  site_name: string;
};

export function renderErpNotifyTemplate(
  template: string,
  values: ErpNotifyTemplateValues,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    if (key === "order_no") return values.order_no ?? "";
    if (key === "item_count") return String(values.item_count);
    if (key === "site_code") return values.site_code ?? "";
    if (key === "site_name") return values.site_name ?? "";
    return "";
  });
}

/** 解析 ERP 传入的 item_count（正整数） */
export function parseErpNotifyItemCount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}
