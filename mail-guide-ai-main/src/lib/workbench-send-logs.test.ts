import { describe, expect, it } from "vitest";
import {
  buildPairConversationTimeline,
  isSendLogSuccess,
  sendTypeLabel,
  type WorkbenchSendLog,
} from "./workbench-send-logs";

describe("workbench-send-logs", () => {
  it("maps known send_type labels", () => {
    expect(sendTypeLabel("manual")).toBe("手工回复");
    expect(sendTypeLabel("auto_template")).toBe("自动模板");
    expect(sendTypeLabel("custom_x")).toBe("custom_x");
  });

  it("treats only sent as success", () => {
    expect(isSendLogSuccess("sent")).toBe(true);
    expect(isSendLogSuccess("SENT")).toBe(true);
    expect(isSendLogSuccess("failed")).toBe(false);
    expect(isSendLogSuccess("pending")).toBe(false);
  });

  it("builds pair timeline with 收/发 sorted newest-first", () => {
    const log: WorkbenchSendLog = {
      id: "log-1",
      email_id: "cur",
      status: "sent",
      send_type: "manual",
      subject: "Re: hi",
      content: "ok",
      from_email: "a@b.com",
      to_email: "c@d.com",
      message_id: null,
      error_message: null,
      created_at: "2026-07-14T12:00:00.000Z",
      sent_by: null,
      send_no: null,
      smtp_response: null,
    };
    const items = buildPairConversationTimeline({
      currentEmail: {
        id: "cur",
        subject: "hi",
        body_text: "hello",
        received_at: "2026-07-14T10:00:00.000Z",
        status: "replied",
      },
      historyEmails: [
        {
          id: "old",
          subject: "earlier",
          body_text: "prev",
          received_at: "2026-07-13T10:00:00.000Z",
          status: "replied",
        },
      ],
      sendLogs: [log],
    });
    expect(items.map((i) => i.kind)).toEqual(["outbound", "inbound", "inbound"]);
    expect(items[0].kind === "outbound" && items[0].log.id).toBe("log-1");
    expect(items[1].kind === "inbound" && items[1].isCurrent).toBe(true);
    expect(items[2].kind === "inbound" && items[2].email.id).toBe("old");
  });
});
