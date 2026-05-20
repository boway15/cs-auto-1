// 已废弃：原 compensating 2h 定时内部预警，已由「首次 + 末次」运营告警（ops_alerts + 邮件）替代。
// 见 _shared/automation-association-alerts.ts、process-email、run-compensation-tasks。
// pg_cron 不应再注册本函数；历史 job 由 Apply-VaultAndCron 脚本 unschedule。

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  return new Response(JSON.stringify({ ok: true, deprecated: true, message: "Use first/final ops alerts instead" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
