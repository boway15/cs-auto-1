import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

type Row = { user_id: string; display_name: string | null; email?: string; roles: string[] };

const ROLE_LABEL: Record<string, string> = { admin: "管理员", leader: "组长", agent: "客服" };

export default function UsersPage() {
  const [rows, setRows] = useState<Row[]>([]);

  async function load() {
    const { data: profiles } = await supabase.from("profiles").select("user_id, display_name");
    const { data: rolesData } = await supabase.from("user_roles").select("user_id, role");
    const map = new Map<string, Row>();
    (profiles ?? []).forEach((p: any) => map.set(p.user_id, { user_id: p.user_id, display_name: p.display_name, roles: [] }));
    (rolesData ?? []).forEach((r: any) => {
      const row = map.get(r.user_id) ?? { user_id: r.user_id, display_name: null, roles: [] };
      row.roles.push(r.role);
      map.set(r.user_id, row);
    });
    setRows(Array.from(map.values()));
  }
  useEffect(() => { load(); }, []);

  async function setRole(userId: string, newRole: string) {
    // 简化：删除该用户所有角色，新增 newRole
    const before = rows.find((r) => r.user_id === userId)?.roles ?? [];
    await supabase.from("user_roles").delete().eq("user_id", userId);
    const { error } = await supabase.from("user_roles").insert({ user_id: userId, role: newRole });
    if (error) toast.error(error.message);
    else {
      await supabase.from("audit_logs").insert({
        target_table: "user_roles",
        target_id: userId,
        action: "set_role",
        before_data: { roles: before },
        after_data: { roles: [newRole] },
      } as any);
      toast.success("角色已更新");
      load();
    }
  }

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">用户管理</h1>
        <p className="text-sm text-muted-foreground">为客服坐席分配角色权限</p>
      </div>

      <div className="grid gap-2">
        {rows.map((r) => (
          <Card key={r.user_id} className="p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-medium">
              {(r.display_name ?? "U").charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <div className="font-medium">{r.display_name ?? "未命名"}</div>
              <div className="text-xs text-muted-foreground font-mono">{r.user_id.slice(0, 8)}...</div>
              <div className="text-xs text-muted-foreground mt-1">
                可见范围：{r.roles.includes("admin") ? "全局配置与审计" : r.roles.includes("leader") ? "团队队列与客服审计" : "本人处理队列"}
              </div>
            </div>
            <div className="flex gap-1">
              {r.roles.map((rl) => <Badge key={rl}>{ROLE_LABEL[rl] ?? rl}</Badge>)}
            </div>
            <Select value={r.roles[0] ?? "agent"} onValueChange={(v) => setRole(r.user_id, v)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">管理员</SelectItem>
                <SelectItem value="leader">组长</SelectItem>
                <SelectItem value="agent">客服</SelectItem>
              </SelectContent>
            </Select>
          </Card>
        ))}
      </div>

      <Card className="p-4 mt-6 bg-info/10 border-info/30 text-sm text-muted-foreground">
        提示：新用户通过登录页"注册"加入。首位注册者自动为管理员，后续注册者默认是客服角色，可在此调整。
      </Card>
    </div>
  );
}
