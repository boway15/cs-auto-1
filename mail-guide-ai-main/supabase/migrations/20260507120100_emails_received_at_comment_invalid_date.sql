-- 补充说明：Invalid Date 回退为入库时间（与 sync-mailbox receivedAtFromDateHeader 一致）

COMMENT ON COLUMN public.emails.received_at IS
  '邮件 RFC 5322 Date 头解析后的时间（timestamptz）；IMAP 同步写入；Date 头缺失或解析无效（Invalid Date）时回退为本次入库时间。用于 SLA、自动草稿 0–24h 窗口等。';
