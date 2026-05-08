-- 业务口径：SLA、自动草稿时间窗等均以「邮件 Date 头」为准。
-- 字段仍使用 received_at：由 sync-mailbox 写入 RFC 5322 Date 解析结果；无 Date 或解析失败时回退为入库时刻。

COMMENT ON COLUMN public.emails.received_at IS
  '邮件 RFC 5322 Date 头解析后的时间（timestamptz）；IMAP 同步写入；Date 头缺失或解析无效（Invalid Date）时回退为本次入库时间。用于 SLA、自动草稿 0–24h 窗口等。';
