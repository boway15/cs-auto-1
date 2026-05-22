import { supabase } from "@/lib/supabase";

export type AccessibleMailbox = {
  id: string;
  email_address: string;
  display_name: string | null;
  is_active: boolean;
};

/** 通过 RPC 获取当前用户可访问邮箱（不含 SMTP/IMAP 密码） */
export async function fetchAccessibleMailboxes(): Promise<AccessibleMailbox[]> {
  const { data, error } = await supabase.rpc("list_accessible_mailboxes");
  if (error) {
    console.error("list_accessible_mailboxes", error);
    return [];
  }
  return (data ?? []) as AccessibleMailbox[];
}
