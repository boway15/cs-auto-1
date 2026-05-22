const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export function getErpNotifyCorsHeaders() {
  return corsHeaders;
}

export function verifyErpNotifyApiKey(req: Request): boolean {
  const expected = (Deno.env.get("ERP_NOTIFY_API_KEY") ?? "").trim();
  if (!expected) return false;
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim() === expected;
}

export function erpNotifyJson(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
