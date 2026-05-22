import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { needsMailboxGrants, visibleScopeLabel } from "@/lib/mailbox-scope";

type Row = { user_id: string; display_name: string | null; email?: string; roles: string[] };
type MailboxOption = { id: string; email_address: string; display_name: string | null };

const ROLE_LABEL: Record<string, string> = { admin: "管理员", leader: "组长", agent: "客服", guest: "游客" };

export default function UsersPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
  const [grantsByUser, setGrantsByUser] = useState<Record<string, string[]>>({});
  const [draftGrants, setDraftGrants] = useState<Record<string, string[]>>({});
  const [savingGrantsFor, setSavingGrantsFor] = useState<string | null>(null);

  async function load() {
    const { data: profiles } = await supabase.from("profiles").select("user_id, display_name");
    const { data: rolesData } = await supabase.from("user_roles").select("user_id, role");
    const { data: mbData } = await supabase
      .from("mailboxes")
      .select("id, email_address, display_name")
      .eq("is_active", true)
      .order("email_address");
    const { data: grantsData } = await supabase.from("user_mailbox_grants").select("user_id, mailbox_id");

    const map = new Map<string, Row>();
    (profiles ?? []).forEach((p: { user_id: string; display_name: string | null }) =>
      map.set(p.user_id, { user_id: p.user_id, display_name: p.display_name, roles: [] }),
    );
    (rolesData ?? []).forEach((r: { user_id: string; role: string }) => {
      const row = map.get(r.user_id) ?? { user_id: r.user_id, display_name: null, roles: [] };
      row.roles.push(r.role);
      map.set(r.user_id, row);
    });

    const grantMap: Record<string, string[]> = {};
    (grantsData ?? []).forEach((g: { user_id: string; mailbox_id: string }) => {
      if (!grantMap[g.user_id]) grantMap[g.user_id] = [];
      grantMap[g.user_id].push(g.mailbox_id);
    });

    setMailboxes((mbData ?? []) as MailboxOption[]);
    setGrantsByUser(grantMap);
    setDraftGrants(grantMap);
    setRows(Array.from(map.values()));
  }

  useEffect(() => {
    load();
  }, []);

  async function setRole(userId: string, newRole: string) {
    const before = rows.find((r) => r.user_id === userId)?.roles ?? [];
    await supabase.from("user_roles").delete().eq("user_id", userId);
    const { error } = await supabase.from("user_roles").insert({ user_id: userId, role: newRole });
    if (error) toast.error(error.message);
    else {
      if (!needsMailboxGrants(newRole)) {
        await supabase.from("user_mailbox_grants").delete().eq("user_id", userId);
      }
      await supabase.from("audit_logs").insert({
        target_table: "user_roles",
        target_id: userId,
        action: "set_role",
        before_data: { roles: before },
        after_data: { roles: [newRole] },
      } as Record<string, unknown>);
      toast.success("角色已更新");
      load();
    }
  }

  function toggleDraftGrant(userId: string, mailboxId: string, checked: boolean) {
    setDraftGrants((prev) => {
      const cur = new Set(prev[userId] ?? grantsByUser[userId] ?? []);
      if (checked) cur.add(mailboxId);
      else cur.delete(mailboxId);
      return { ...prev, [userId]: Array.from(cur) };
    });
  }

  async function saveMailboxGrants(userId: string, role: string) {
    if (!needsMailboxGrants(role)) return;
    setSavingGrantsFor(userId);
    const before = grantsByUser[userId] ?? [];
    const next = draftGrants[userId] ?? before;
    try {
      await supabase.from("user_mailbox_grants").delete().eq("user_id", userId);
      if (next.length > 0) {
        const { data: session } = await supabase.auth.getSession();
        const grantedBy = session.session?.user?.id ?? null;
        const { error } = await supabase.from("user_mailbox_grants").insert(
          next.map((mailbox_id) => ({
            user_id: userId,
            mailbox_id,
            granted_by: grantedBy,
          })),
        );
        if (error) throw error;
      }
      await supabase.from("audit_logs").insert({
        target_table: "user_mailbox_grants",
        target_id: userId,
        action: "set_mailbox_grants",
        before_data: { mailbox_ids: before },
        after_data: { mailbox_ids: next },
      } as Record<string, unknown>);
      toast.success("邮箱授权已保存");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingGrantsFor(null);
    }
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">用户管理</h1>
        <p className="text-sm text-muted-foreground">为客服坐席分配角色与可访问邮箱</p>
      </div>

      <div className="grid gap-2">
        {rows.map((r) => {
          const primaryRole = r.roles[0];
          const grantIds = grantsByUser[r.user_id] ?? [];
          const draft = draftGrants[r.user_id] ?? grantIds;
          const showGrants = needsMailboxGrants(primaryRole);
          const grantsDirty =
            showGrants &&
            (draft.length !== grantIds.length || draft.some((id) => !grantIds.includes(id)));

          return (
            <Card key={r.user_id} className="p-4 flex flex-col gap-3">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-medium shrink-0">
                  {(r.display_name ?? "U").charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-[12rem]">
                  <div className="font-medium">{r.display_name ?? "未命名"}</div>
                  <div className="text-xs text-muted-foreground font-mono">{r.user_id.slice(0, 8)}...</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    可见范围：{visibleScopeLabel(r.roles, grantIds.length)}
                    {showGrants && grantIds.length === 0 && (
                      <span className="ml-2 text-destructive font-medium">无法处理邮件（未授权邮箱）</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {r.roles.map((rl) => (
                    <Badge key={rl}>{ROLE_LABEL[rl] ?? rl}</Badge>
                  ))}
                </div>
                <Select value={primaryRole ?? undefined} onValueChange={(v) => setRole(r.user_id, v)}>
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="选择角色" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">管理员</SelectItem>
                    <SelectItem value="leader">组长</SelectItem>
                    <SelectItem value="agent">客服</SelectItem>
                    <SelectItem value="guest">游客</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {showGrants && (
                <div className="border rounded-md p-3 bg-muted/30 space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">授权邮箱（必选至少一个方可处理邮件）</div>
                  {mailboxes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">暂无启用邮箱，请先在邮箱配置中添加</p>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {mailboxes.map((mb) => (
                        <label
                          key={mb.id}
                          className="flex items-center gap-2 text-sm cursor-pointer"
                        >
                          <Checkbox
                            checked={draft.includes(mb.id)}
                            onCheckedChange={(c) => toggleDraftGrant(r.user_id, mb.id, c === true)}
                          />
                          <span className="truncate" title={mb.email_address}>
                            {mb.display_name ? `${mb.display_name} · ` : ""}
                            {mb.email_address}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  {grantsDirty && (
                    <Button
                      size="sm"
                      disabled={savingGrantsFor === r.user_id}
                      onClick={() => void saveMailboxGrants(r.user_id, primaryRole!)}
                    >
                      {savingGrantsFor === r.user_id ? "保存中…" : "保存邮箱授权"}
                    </Button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="p-4 mt-6 bg-info/10 border-info/30 text-sm text-muted-foreground">
        提示：管理员可访问全部邮箱；组长与客服仅可查看和处理已授权邮箱下的邮件。新用户默认游客，请在此分配角色与邮箱。
      </Card>
    </div>
  );
}
