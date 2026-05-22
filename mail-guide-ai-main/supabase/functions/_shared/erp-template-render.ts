/** ERP 通知模板：仅支持 {{order_no}} */
export function renderErpNotifyTemplate(
  template: string,
  values: { order_no: string },
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    if (key === "order_no") return values.order_no ?? "";
    return "";
  });
}
