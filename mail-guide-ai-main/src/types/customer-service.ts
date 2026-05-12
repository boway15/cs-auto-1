import type { Json } from "@/integrations/supabase/types";

export type EmailPriority = "low" | "normal" | "high" | "urgent";
export type AssociationStatus =
  | "unlinked"
  | "linked"
  | "recommended"
  | "compensating"
  | "not_found"
  | "not_provided"
  | "manual_unlink";
export type ProcessingStatus = "pending" | "analyzing" | "associated" | "drafted" | "auto_replied" | "risk_intercepted" | "failed";
export type RiskStatus = "pending" | "success" | "failed" | "retrying";

export interface EmailOrderRecommendation {
  id: string;
  email_id: string;
  order_id: string;
  reason: string;
  score: number;
  status: "pending" | "accepted" | "dismissed";
  created_at: string;
}

export interface OrderCompensationTask {
  id: string;
  email_id: string;
  order_no: string;
  status: "pending" | "resolved" | "failed";
  retry_count: number;
  max_retries: number;
  next_run_at: string;
  last_error: string | null;
  resolved_order_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RiskInterceptLog {
  id: string;
  intercept_no: string;
  email_id: string | null;
  order_id: string | null;
  action: "hold" | "release";
  intercept_reason: string | null;
  reason_category: string | null;
  trigger_source: "manual" | "auto" | "retry";
  status: RiskStatus;
  retry_count: number;
  erp_response: Json | null;
  shopify_response: Json | null;
  error_message: string | null;
  operated_by: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailProcessingEvent {
  id: string;
  email_id: string | null;
  event_type: string;
  actor_type: "system" | "user";
  actor_id: string | null;
  title: string;
  detail: string | null;
  metadata: Json;
  created_at: string;
}
