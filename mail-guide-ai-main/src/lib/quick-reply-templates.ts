import { supabase } from "@/lib/supabase";

export type QuickReplyScope = "team" | "personal";

export type QuickReplyTemplateRow = {
  id: string;
  title: string;
  body_template: string;
  subject_template: string | null;
  category: string | null;
  business_intents: string[];
  scope: QuickReplyScope;
  owner_id: string | null;
  sort_order: number;
  is_active: boolean;
};

export type QuickReplyTemplateContext = {
  from_name: string;
  from_email: string;
  subject: string;
  reply_to_email: string;
  order_no: string;
  missing_elements: string;
};

export function renderQuickReplyTemplate(
  template: string,
  ctx: QuickReplyTemplateContext,
): string {
  const fromName = ctx.from_name.trim() || ctx.from_email;
  const values: Record<string, string> = {
    from_name: fromName,
    from_email: ctx.from_email,
    subject: ctx.subject,
    reply_to_email: ctx.reply_to_email,
    order_no: ctx.order_no,
    missing_elements: ctx.missing_elements,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => values[key] ?? "");
}

export function buildQuickReplyContextFromEmail(
  email: {
    from_name?: string | null;
    from_email?: string | null;
    reply_to_email?: string | null;
    subject?: string | null;
    missing_elements?: string[] | null;
  },
  orderNo = "",
  replyToEmailOverride = "",
): QuickReplyTemplateContext {
  const fromEmail = email.from_email ?? "";
  const replyToEmail = replyToEmailOverride.trim()
    || (email.reply_to_email ?? "").trim()
    || fromEmail;
  return {
    from_name: (email.from_name ?? "").trim(),
    from_email: fromEmail,
    subject: email.subject?.trim() || replyToEmail,
    reply_to_email: replyToEmail,
    order_no: orderNo,
    missing_elements: (email.missing_elements ?? []).join(", "),
  };
}

export async function fetchActiveQuickReplyTemplates(): Promise<QuickReplyTemplateRow[]> {
  const { data, error } = await supabase
    .from("quick_reply_templates")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return (data ?? []) as QuickReplyTemplateRow[];
}

export type QuickReplyGroup = {
  key: string;
  label: string;
  templates: QuickReplyTemplateRow[];
};

export function groupQuickReplyTemplates(
  rows: QuickReplyTemplateRow[],
  businessIntent?: string | null,
): QuickReplyGroup[] {
  const team = rows.filter((r) => r.scope === "team");
  const personal = rows.filter((r) => r.scope === "personal");

  const byCategory = new Map<string, QuickReplyTemplateRow[]>();
  for (const t of team) {
    const cat = t.category?.trim() || "团队模板";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(t);
  }

  const sortMatchedFirst = (list: QuickReplyTemplateRow[]) => {
    if (!businessIntent) return list;
    return [...list].sort((a, b) => {
      const aMatch = a.business_intents.includes(businessIntent) ? 0 : 1;
      const bMatch = b.business_intents.includes(businessIntent) ? 0 : 1;
      return aMatch - bMatch || a.sort_order - b.sort_order;
    });
  };

  const groups: QuickReplyGroup[] = [];
  for (const [label, templates] of byCategory) {
    groups.push({ key: `team-${label}`, label, templates: sortMatchedFirst(templates) });
  }
  if (personal.length > 0) {
    groups.push({
      key: "personal",
      label: "我的模板",
      templates: sortMatchedFirst(personal),
    });
  }
  return groups;
}
