import { useEffect, useState, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type AppRole = "admin" | "leader" | "agent" | "guest";
const FALLBACK_ADMIN_EMAILS = new Set(["369404600@qq.com", "admin@test.com"]);

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [allowedMailboxIds, setAllowedMailboxIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [grantsLoading, setGrantsLoading] = useState(false);

  const fetchGrants = useCallback(async (uid: string, isAdminUser: boolean) => {
    if (isAdminUser) {
      setAllowedMailboxIds([]);
      setGrantsLoading(false);
      return;
    }
    setGrantsLoading(true);
    try {
      const { data, error } = await supabase
        .from("user_mailbox_grants")
        .select("mailbox_id")
        .eq("user_id", uid);
      if (error) {
        console.error("Failed to fetch mailbox grants:", error.message);
        setAllowedMailboxIds([]);
        return;
      }
      setAllowedMailboxIds((data ?? []).map((r: { mailbox_id: string }) => r.mailbox_id));
    } finally {
      setGrantsLoading(false);
    }
  }, []);

  const fetchRoles = useCallback(
    async (uid: string, email?: string | null) => {
      setRolesLoading(true);
      try {
        const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", uid);
        if (error) {
          console.error("Failed to fetch user roles:", error.message);
          setRoles([]);
          setAllowedMailboxIds([]);
          return;
        }
        const nextRoles = (data ?? []).map((r: { role: string }) => r.role as AppRole);
        setRoles(nextRoles);
        const isAdminUser =
          nextRoles.includes("admin") ||
          (!!email && FALLBACK_ADMIN_EMAILS.has(email.toLowerCase()));
        await fetchGrants(uid, isAdminUser);
      } finally {
        setRolesLoading(false);
      }
    },
    [fetchGrants],
  );

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        setTimeout(() => void fetchRoles(s.user.id, s.user.email), 0);
      } else {
        setRoles([]);
        setAllowedMailboxIds([]);
        setRolesLoading(false);
        setGrantsLoading(false);
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      if (data.session?.user) {
        void fetchRoles(data.session.user.id, data.session.user.email).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [fetchRoles]);

  const isFallbackAdmin = !!user?.email && FALLBACK_ADMIN_EMAILS.has(user.email.toLowerCase());
  const isAdmin = roles.includes("admin") || isFallbackAdmin;
  const isLeader = roles.includes("leader");
  const isAgent = roles.includes("agent");
  const isGuest = roles.includes("guest");
  /** 可访问工作台等业务功能（不含游客） */
  const hasAppAccess = isAdmin || isLeader || isAgent;
  /** admin 不依赖授权表，可访问全部邮箱 */
  const hasAllMailboxAccess = isAdmin;
  /** leader/agent 无授权邮箱时无法查看业务邮件 */
  const hasMailboxAccess =
    hasAllMailboxAccess || (hasAppAccess && allowedMailboxIds.length > 0);

  return {
    session,
    user,
    roles,
    isAdmin,
    isLeader,
    isAgent,
    isGuest,
    hasAppAccess,
    hasAllMailboxAccess,
    hasMailboxAccess,
    allowedMailboxIds,
    loading,
    rolesLoading,
    grantsLoading,
    authGateLoading: loading || (!!session?.user && (rolesLoading || grantsLoading)),
  };
}
