import { describe, expect, it } from "vitest";
import {
  groupQuickReplyTemplates,
  renderQuickReplyTemplate,
  type QuickReplyTemplateContext,
  type QuickReplyTemplateRow,
} from "./quick-reply-templates";

const ctx: QuickReplyTemplateContext = {
  from_name: "Alice",
  from_email: "alice@example.com",
  subject: "Where is my order?",
  reply_to_email: "alice@example.com",
  order_no: "SO-001",
  missing_elements: "order_no",
};

describe("renderQuickReplyTemplate", () => {
  it("替换已知占位符", () => {
    const out = renderQuickReplyTemplate("Hi {{from_name}}, order {{order_no}}", ctx);
    expect(out).toBe("Hi Alice, order SO-001");
  });

  it("未知键替换为空串", () => {
    const out = renderQuickReplyTemplate("{{unknown_key}}", ctx);
    expect(out).toBe("");
  });

  it("from_name 为空时回退 from_email", () => {
    const out = renderQuickReplyTemplate("{{from_name}}", { ...ctx, from_name: "" });
    expect(out).toBe("alice@example.com");
  });
});

describe("groupQuickReplyTemplates", () => {
  it("匹配 business_intent 的模板排在组内首位", () => {
    const rows: QuickReplyTemplateRow[] = [
      {
        id: "1",
        title: "通用",
        body_template: "a",
        subject_template: null,
        category: "缺信息",
        business_intents: ["other"],
        scope: "team",
        owner_id: null,
        sort_order: 10,
        is_active: true,
      },
      {
        id: "2",
        title: "物流专用",
        body_template: "b",
        subject_template: null,
        category: "缺信息",
        business_intents: ["logistics"],
        scope: "team",
        owner_id: null,
        sort_order: 20,
        is_active: true,
      },
    ];
    const groups = groupQuickReplyTemplates(rows, "logistics");
    expect(groups).toHaveLength(1);
    expect(groups[0].templates[0].id).toBe("2");
  });
});
