/** 同步/补拉可降级错误：不应向前端返回硬 500 */

export function isDegradableSyncError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const name = err instanceof Error ? err.name : "";
  if (/WorkerRequestCancelled|request has been cancelled/i.test(msg)) return true;
  if (/CPU time (soft|hard) limit/i.test(msg)) return true;
  if (/IMAP (read|connect) timeout/i.test(msg)) return true;
  if (/user worker failed to respond/i.test(msg)) return true;
  if (/unexpected end of file|UnexpectedEof/i.test(`${name} ${msg}`)) return true;
  return false;
}

export function degradableSyncMessage(err: unknown): string {
  if (isDegradableSyncError(err)) {
    return "邮箱响应较慢或邮件较大，已转入后台队列处理，请稍后刷新";
  }
  return err instanceof Error ? err.message : String(err ?? "未知错误");
}
