/** 用户可见范围文案（与 Users 页一致，便于单测） */
export function visibleScopeLabel(roles: string[], grantCount: number): string {
  if (roles.includes("admin")) return "全部邮箱（全局）";
  if (roles.includes("leader") || roles.includes("agent")) {
    return grantCount > 0 ? `已授权 ${grantCount} 个邮箱` : "未分配邮箱（无法查看邮件）";
  }
  if (roles.includes("guest")) return "仅登录（游客，无业务数据）";
  return "未分配角色";
}

export function needsMailboxGrants(role: string | undefined): boolean {
  return role === "leader" || role === "agent";
}
