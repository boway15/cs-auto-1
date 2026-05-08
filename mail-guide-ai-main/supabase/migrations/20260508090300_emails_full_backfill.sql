-- Phase A-4: 历史数据 full backfill
--   1) intent_legacy 复制旧 intent
--   2) business_intent 由 intent / category / risk_level 启发式映射到 7 类（破损/缺陷/描述不符仅当 category/intent 命中关键词时尝试）
--   3) 修正 association_status：旧 recommended 但实际无单号且无关联 → not_provided，并清掉这些邮件的 recommendation 行
--   4) 一次性计算 sla_bucket（仅对 pending/processing）

DO $$
BEGIN
  -- 1) intent_legacy
  UPDATE public.emails
  SET intent_legacy = intent
  WHERE intent_legacy IS NULL AND intent IS NOT NULL;

  -- 2) business_intent 映射（仅在为空时填充，避免覆盖人工已改）
  UPDATE public.emails
  SET business_intent = CASE
    WHEN intent IN ('cancel_order','order_cancel') THEN 'order_cancel'
    WHEN intent IN ('change_address','address_change') THEN 'address_change'
    WHEN intent IN ('shipping_query','logistics') THEN 'logistics'
    WHEN intent IN ('refund','after_sale') THEN 'other'
    WHEN intent = 'general' THEN 'other'
    ELSE 'other'
  END
  WHERE business_intent IS NULL AND intent IS NOT NULL;

  -- 3) 修正历史 recommended → not_provided（无单号且无关联）
  WITH no_link AS (
    SELECT e.id
    FROM public.emails e
    LEFT JOIN public.email_order_links l ON l.email_id = e.id
    WHERE e.association_status = 'recommended'
      AND COALESCE(NULLIF(e.ai_entities->>'order_no',''), NULL) IS NULL
      AND l.id IS NULL
  )
  UPDATE public.emails e
  SET association_status = 'not_provided'
  FROM no_link
  WHERE e.id = no_link.id;

  -- 同步删除这些邮件的推荐行（不推荐口径）
  DELETE FROM public.email_order_recommendations r
  USING public.emails e
  WHERE r.email_id = e.id AND e.association_status = 'not_provided';

  -- 4) 一次性计算 sla_bucket（按 received_at 与 now() 的差值；超过 72h 归 over_72h）
  UPDATE public.emails
  SET sla_bucket = CASE
    WHEN now() - received_at < interval '24 hours' THEN 'within_24h'
    WHEN now() - received_at < interval '48 hours' THEN 'within_48h'
    WHEN now() - received_at < interval '72 hours' THEN 'within_72h'
    ELSE 'over_72h'
  END
  WHERE status IN ('pending','processing');

  -- 非 pending/processing 的清掉 sla_bucket，避免误读
  UPDATE public.emails
  SET sla_bucket = NULL
  WHERE status NOT IN ('pending','processing') AND sla_bucket IS NOT NULL;
END $$;
