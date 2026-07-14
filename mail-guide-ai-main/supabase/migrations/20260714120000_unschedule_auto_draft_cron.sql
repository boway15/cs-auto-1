-- 取消「未生成草稿邮件自动生成草稿」定时任务；人工 generate-draft 不受影响。
-- jobname 历史名为 auto-draft-every-30min（实际曾为每 4 分钟错峰调度）。

SELECT cron.unschedule('auto-draft-every-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-draft-every-30min');
