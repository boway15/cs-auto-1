export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_drafts: {
        Row: {
          created_at: string
          draft_content: string
          email_id: string
          generated_by: string | null
          guidance: string | null
          id: string
          is_used: boolean
          model: string | null
          version: number
        }
        Insert: {
          created_at?: string
          draft_content: string
          email_id: string
          generated_by?: string | null
          guidance?: string | null
          id?: string
          is_used?: boolean
          model?: string | null
          version?: number
        }
        Update: {
          created_at?: string
          draft_content?: string
          email_id?: string
          generated_by?: string | null
          guidance?: string | null
          id?: string
          is_used?: boolean
          model?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_drafts_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      email_order_links: {
        Row: {
          confidence: number | null
          created_at: string
          created_by: string | null
          email_id: string
          id: string
          link_source: string
          metadata: Json
          order_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          email_id: string
          id?: string
          link_source?: string
          metadata?: Json
          order_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          email_id?: string
          id?: string
          link_source?: string
          metadata?: Json
          order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_order_links_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_order_links_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_logs: {
        Row: {
          content: string | null
          created_at: string
          email_id: string | null
          error_message: string | null
          from_email: string | null
          id: string
          idempotency_key: string | null
          mailbox_id: string | null
          metadata: Json
          message_id: string | null
          order_id: string | null
          provider: string
          retry_count: number
          send_no: string | null
          send_type: string
          sent_by: string | null
          smtp_response: string | null
          status: string
          subject: string | null
          template_id: string | null
          to_email: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          email_id?: string | null
          error_message?: string | null
          from_email?: string | null
          id?: string
          idempotency_key?: string | null
          mailbox_id?: string | null
          metadata?: Json
          message_id?: string | null
          order_id?: string | null
          provider?: string
          retry_count?: number
          send_no?: string | null
          send_type?: string
          sent_by?: string | null
          smtp_response?: string | null
          status?: string
          subject?: string | null
          template_id?: string | null
          to_email: string
        }
        Update: {
          content?: string | null
          created_at?: string
          email_id?: string | null
          error_message?: string | null
          from_email?: string | null
          id?: string
          idempotency_key?: string | null
          mailbox_id?: string | null
          metadata?: Json
          message_id?: string | null
          order_id?: string | null
          provider?: string
          retry_count?: number
          send_no?: string | null
          send_type?: string
          sent_by?: string | null
          smtp_response?: string | null
          status?: string
          subject?: string | null
          template_id?: string | null
          to_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_send_logs_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_send_logs_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      emails: {
        Row: {
          assigned_to: string | null
          attachments: Json | null
          ai_analyzed_at: string | null
          ai_entities: Json
          ai_summary: string | null
          association_status: string
          body_html: string | null
          body_text: string | null
          category: string | null
          created_at: string
          first_response_due_at: string | null
          from_email: string
          from_name: string | null
          has_attachment: boolean
          id: string
          idempotency_key: string | null
          intent: string | null
          is_info_complete: boolean
          is_read: boolean
          last_activity_at: string
          mailbox_id: string | null
          message_id: string | null
          missing_elements: Json | null
          priority: string
          processing_status: string
          received_at: string
          risk_level: string
          status: string
          subject: string | null
          thread_id: string | null
          to_email: string | null
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          attachments?: Json | null
          ai_analyzed_at?: string | null
          ai_entities?: Json
          ai_summary?: string | null
          association_status?: string
          body_html?: string | null
          body_text?: string | null
          category?: string | null
          created_at?: string
          first_response_due_at?: string | null
          from_email: string
          from_name?: string | null
          has_attachment?: boolean
          id?: string
          idempotency_key?: string | null
          intent?: string | null
          is_info_complete?: boolean
          is_read?: boolean
          last_activity_at?: string
          mailbox_id?: string | null
          message_id?: string | null
          missing_elements?: Json | null
          priority?: string
          processing_status?: string
          received_at?: string
          risk_level?: string
          status?: string
          subject?: string | null
          thread_id?: string | null
          to_email?: string | null
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          attachments?: Json | null
          ai_analyzed_at?: string | null
          ai_entities?: Json
          ai_summary?: string | null
          association_status?: string
          body_html?: string | null
          body_text?: string | null
          category?: string | null
          created_at?: string
          first_response_due_at?: string | null
          from_email?: string
          from_name?: string | null
          has_attachment?: boolean
          id?: string
          idempotency_key?: string | null
          intent?: string | null
          is_info_complete?: boolean
          is_read?: boolean
          last_activity_at?: string
          mailbox_id?: string | null
          message_id?: string | null
          missing_elements?: Json | null
          priority?: string
          processing_status?: string
          received_at?: string
          risk_level?: string
          status?: string
          subject?: string | null
          thread_id?: string | null
          to_email?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "emails_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      erp_configs: {
        Row: {
          auth_token: string | null
          auth_token_encrypted: string | null
          auth_type: string
          base_url: string
          config_audit: Json
          created_at: string
          field_mapping: Json
          id: string
          is_active: boolean
          last_test_result: Json | null
          last_tested_at: string | null
          name: string
          order_endpoint: string
          updated_at: string
        }
        Insert: {
          auth_token?: string | null
          auth_token_encrypted?: string | null
          auth_type?: string
          base_url: string
          config_audit?: Json
          created_at?: string
          field_mapping?: Json
          id?: string
          is_active?: boolean
          last_test_result?: Json | null
          last_tested_at?: string | null
          name: string
          order_endpoint?: string
          updated_at?: string
        }
        Update: {
          auth_token?: string | null
          auth_token_encrypted?: string | null
          auth_type?: string
          base_url?: string
          config_audit?: Json
          created_at?: string
          field_mapping?: Json
          id?: string
          is_active?: boolean
          last_test_result?: Json | null
          last_tested_at?: string | null
          name?: string
          order_endpoint?: string
          updated_at?: string
        }
        Relationships: []
      }
      erp_notify_templates: {
        Row: {
          body_template: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          sender_email: string | null
          subject_template: string
          template_code: string
          updated_at: string
          updated_by: string | null
          variables: Json
        }
        Insert: {
          body_template?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          sender_email?: string | null
          subject_template?: string
          template_code: string
          updated_at?: string
          updated_by?: string | null
          variables?: Json
        }
        Update: {
          body_template?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          sender_email?: string | null
          subject_template?: string
          template_code?: string
          updated_at?: string
          updated_by?: string | null
          variables?: Json
        }
        Relationships: []
      }
      erp_site_mailboxes: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          sender_email: string
          site_code: string
          site_name: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          sender_email: string
          site_code: string
          site_name?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          sender_email?: string
          site_code?: string
          site_name?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      mailboxes: {
        Row: {
          auth_password: string
          auth_password_encrypted: string | null
          auth_user: string
          config_audit: Json
          created_at: string
          disabled_reason: string | null
          display_name: string | null
          email_address: string
          failure_count: number
          id: string
          incoming_host: string
          incoming_port: number
          is_active: boolean
          last_error: string | null
          last_imap_test_at: string | null
          last_smtp_test_at: string | null
          last_synced_at: string | null
          last_test_result: Json | null
          last_uid: number
          protocol: string
          signature_enabled: boolean
          signature_text: string | null
          smtp_host: string | null
          smtp_port: number | null
          updated_at: string
          use_ssl: boolean
        }
        Insert: {
          auth_password: string
          auth_password_encrypted?: string | null
          auth_user: string
          config_audit?: Json
          created_at?: string
          disabled_reason?: string | null
          display_name?: string | null
          email_address: string
          failure_count?: number
          id?: string
          incoming_host: string
          incoming_port?: number
          is_active?: boolean
          last_error?: string | null
          last_imap_test_at?: string | null
          last_smtp_test_at?: string | null
          last_synced_at?: string | null
          last_test_result?: Json | null
          last_uid?: number
          protocol?: string
          signature_enabled?: boolean
          signature_text?: string | null
          smtp_host?: string | null
          smtp_port?: number | null
          updated_at?: string
          use_ssl?: boolean
        }
        Update: {
          auth_password?: string
          auth_password_encrypted?: string | null
          auth_user?: string
          config_audit?: Json
          created_at?: string
          disabled_reason?: string | null
          display_name?: string | null
          email_address?: string
          failure_count?: number
          id?: string
          incoming_host?: string
          incoming_port?: number
          is_active?: boolean
          last_error?: string | null
          last_imap_test_at?: string | null
          last_smtp_test_at?: string | null
          last_synced_at?: string | null
          last_test_result?: Json | null
          last_uid?: number
          protocol?: string
          signature_enabled?: boolean
          signature_text?: string | null
          smtp_host?: string | null
          smtp_port?: number | null
          updated_at?: string
          use_ssl?: boolean
        }
        Relationships: []
      }
      order_hold_logs: {
        Row: {
          action: string
          created_at: string
          email_id: string | null
          id: string
          order_id: string
          performed_by: string | null
          reason: string | null
          reason_category: string | null
          shopify_sync_error: string | null
          shopify_synced: boolean
        }
        Insert: {
          action: string
          created_at?: string
          email_id?: string | null
          id?: string
          order_id: string
          performed_by?: string | null
          reason?: string | null
          reason_category?: string | null
          shopify_sync_error?: string | null
          shopify_synced?: boolean
        }
        Update: {
          action?: string
          created_at?: string
          email_id?: string | null
          id?: string
          order_id?: string
          performed_by?: string | null
          reason?: string | null
          reason_category?: string | null
          shopify_sync_error?: string | null
          shopify_synced?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "order_hold_logs_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_hold_logs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          amount: number | null
          created_at: string
          currency: string | null
          customer_email: string | null
          customer_name: string | null
          erp_config_id: string | null
          financial_status: string | null
          fulfillment_status: string | null
          hold_at: string | null
          hold_by: string | null
          hold_reason: string | null
          id: string
          order_no: string
          order_status: string | null
          ordered_at: string | null
          product_summary: string | null
          raw_data: Json | null
          shipping_address: Json | null
          shipping_hold: boolean
          shipping_status: string | null
          shop_id: string | null
          shopify_order_gid: string | null
          shopify_order_id: string | null
          shopify_tags: string | null
          tracking_no: string | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          created_at?: string
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          erp_config_id?: string | null
          financial_status?: string | null
          fulfillment_status?: string | null
          hold_at?: string | null
          hold_by?: string | null
          hold_reason?: string | null
          id?: string
          order_no: string
          order_status?: string | null
          ordered_at?: string | null
          product_summary?: string | null
          raw_data?: Json | null
          shipping_address?: Json | null
          shipping_hold?: boolean
          shipping_status?: string | null
          shop_id?: string | null
          shopify_order_gid?: string | null
          shopify_order_id?: string | null
          shopify_tags?: string | null
          tracking_no?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          created_at?: string
          currency?: string | null
          customer_email?: string | null
          customer_name?: string | null
          erp_config_id?: string | null
          financial_status?: string | null
          fulfillment_status?: string | null
          hold_at?: string | null
          hold_by?: string | null
          hold_reason?: string | null
          id?: string
          order_no?: string
          order_status?: string | null
          ordered_at?: string | null
          product_summary?: string | null
          raw_data?: Json | null
          shipping_address?: Json | null
          shipping_hold?: boolean
          shipping_status?: string | null
          shop_id?: string | null
          shopify_order_gid?: string | null
          shopify_order_id?: string | null
          shopify_tags?: string | null
          tracking_no?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_erp_config_id_fkey"
            columns: ["erp_config_id"]
            isOneToOne: false
            referencedRelation: "erp_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_shop_id_fkey"
            columns: ["shop_id"]
            isOneToOne: false
            referencedRelation: "shopify_shops"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_intercept_logs: {
        Row: {
          action: string
          auto_compensation_eligible: boolean
          compensation_attempts_done: number
          created_at: string
          email_id: string | null
          erp_response: Json | null
          error_message: string | null
          id: string
          idempotency_key: string | null
          intercept_no: string
          intercept_reason: string | null
          next_compensation_at: string | null
          operated_by: string | null
          order_id: string | null
          reason_category: string | null
          referenced_order_no: string | null
          retry_count: number
          retrying_started_at: string | null
          shopify_response: Json | null
          status: string
          trigger_source: string
          updated_at: string
        }
        Insert: {
          action?: string
          auto_compensation_eligible?: boolean
          compensation_attempts_done?: number
          created_at?: string
          email_id?: string | null
          erp_response?: Json | null
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          intercept_no?: string
          intercept_reason?: string | null
          next_compensation_at?: string | null
          operated_by?: string | null
          order_id?: string | null
          reason_category?: string | null
          referenced_order_no?: string | null
          retry_count?: number
          retrying_started_at?: string | null
          shopify_response?: Json | null
          status?: string
          trigger_source?: string
          updated_at?: string
        }
        Update: {
          action?: string
          auto_compensation_eligible?: boolean
          compensation_attempts_done?: number
          created_at?: string
          email_id?: string | null
          erp_response?: Json | null
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          intercept_no?: string
          intercept_reason?: string | null
          next_compensation_at?: string | null
          operated_by?: string | null
          order_id?: string | null
          reason_category?: string | null
          referenced_order_no?: string | null
          retry_count?: number
          retrying_started_at?: string | null
          shopify_response?: Json | null
          status?: string
          trigger_source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "risk_intercept_logs_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "risk_intercept_logs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      automation_settings: {
        Row: {
          auto_reply_first_contact_days: number
          ops_alert_recipient_emails: string | null
          ops_alert_sender_email: string | null
          risk_auto_intercept_enabled: boolean
          singleton: string
          updated_at: string
        }
        Insert: {
          auto_reply_first_contact_days?: number
          ops_alert_recipient_emails?: string | null
          ops_alert_sender_email?: string | null
          risk_auto_intercept_enabled?: boolean
          singleton?: string
          updated_at?: string
        }
        Update: {
          auto_reply_first_contact_days?: number
          ops_alert_recipient_emails?: string | null
          ops_alert_sender_email?: string | null
          risk_auto_intercept_enabled?: boolean
          singleton?: string
          updated_at?: string
        }
        Relationships: []
      }
      reply_templates: {
        Row: {
          auto_reply_first_contact_days: number
          auto_send: boolean
          body_template: string
          cooldown_minutes?: number | null
          created_at: string
          enabled_business_intents: string[]
          id: string
          intent?: string | null
          is_active: boolean
          last_test_result?: Json | null
          last_tested_at?: string | null
          name: string
          subject_template: string | null
          trigger_type: string
          updated_at: string
          updated_by?: string | null
          variables?: Json
        }
        Insert: {
          auto_reply_first_contact_days?: number
          auto_send?: boolean
          body_template: string
          cooldown_minutes?: number | null
          created_at?: string
          enabled_business_intents?: string[]
          id?: string
          intent?: string | null
          is_active?: boolean
          last_test_result?: Json | null
          last_tested_at?: string | null
          name: string
          subject_template?: string | null
          trigger_type: string
          updated_at?: string
          updated_by?: string | null
          variables?: Json
        }
        Update: {
          auto_reply_first_contact_days?: number
          auto_send?: boolean
          body_template?: string
          cooldown_minutes?: number | null
          created_at?: string
          enabled_business_intents?: string[]
          id?: string
          intent?: string | null
          is_active?: boolean
          last_test_result?: Json | null
          last_tested_at?: string | null
          name?: string
          subject_template?: string | null
          trigger_type?: string
          updated_at?: string
          updated_by?: string | null
          variables?: Json
        }
        Relationships: []
      }
      shopify_shops: {
        Row: {
          access_token: string
          api_version: string
          created_at: string
          display_name: string | null
          id: string
          is_active: boolean
          last_error: string | null
          last_sync_cursor: string | null
          last_synced_at: string | null
          shop_domain: string
          updated_at: string
        }
        Insert: {
          access_token: string
          api_version?: string
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_sync_cursor?: string | null
          last_synced_at?: string | null
          shop_domain: string
          updated_at?: string
        }
        Update: {
          access_token?: string
          api_version?: string
          created_at?: string
          display_name?: string | null
          id?: string
          is_active?: boolean
          last_error?: string | null
          last_sync_cursor?: string | null
          last_synced_at?: string | null
          shop_domain?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_mailbox_grants: {
        Row: {
          created_at: string
          granted_by: string | null
          id: string
          mailbox_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          id?: string
          mailbox_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          id?: string
          mailbox_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_mailbox_grants_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_access_email: {
        Args: { _email_id: string; _user_id: string }
        Returns: boolean
      }
      can_access_mailbox: {
        Args: { _mailbox_id: string; _user_id: string }
        Returns: boolean
      }
      can_access_order: {
        Args: { _order_id: string; _user_id: string }
        Returns: boolean
      }
      list_accessible_mailboxes: {
        Args: Record<PropertyKey, never>
        Returns: {
          id: string
          email_address: string
          display_name: string | null
          is_active: boolean
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_staff: { Args: { _user_id: string }; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "leader" | "agent" | "guest"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "leader", "agent", "guest"],
    },
  },
} as const
