const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Service role / cron 的 userId 为 ""，uuid 列须写 null 而非空串 */
export function actorUserIdOrNull(actor: { userId: string; isService?: boolean }): string | null {
  if (actor.isService) return null;
  const id = String(actor.userId ?? "").trim();
  return id && UUID_RE.test(id) ? id : null;
}
