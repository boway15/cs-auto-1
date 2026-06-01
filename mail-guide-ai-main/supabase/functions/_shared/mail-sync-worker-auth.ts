export function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name)?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isAuthorizedMailSyncWorkerToken(
  token: string,
  serviceKey: string,
  cronKey?: string | null,
): boolean {
  if (!token) return false;
  if (token === serviceKey) return true;
  if (cronKey && token === cronKey) return true;
  return false;
}
