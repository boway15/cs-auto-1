import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type AppRole = "admin" | "leader" | "agent";
const FALLBACK_ADMIN_EMAILS = new Set(["369404600@qq.com", "admin@test.com"]);

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) {
        // 延迟到下一个 tick 避免死锁
        setTimeout(() => fetchRoles(s.user.id), 0);
      } else {
        setRoles([]);
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setUser(data.session?.user ?? null);
      if (data.session?.user) {
        fetchRoles(data.session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function fetchRoles(uid: string) {
    const { data, error } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", uid);
    if (error) {
      console.error("Failed to fetch user roles:", error.message);
      setRoles([]);
      return;
    }
    setRoles((data ?? []).map((r: any) => r.role as AppRole));
  }

  const isFallbackAdmin = !!user?.email && FALLBACK_ADMIN_EMAILS.has(user.email.toLowerCase());
  const isAdmin = roles.includes("admin") || isFallbackAdmin;
  const isLeader = roles.includes("leader");
  const isAgent = roles.includes("agent");

  return { session, user, roles, isAdmin, isLeader, isAgent, loading };
}
