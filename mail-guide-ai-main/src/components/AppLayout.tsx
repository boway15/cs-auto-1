import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Inbox,
  Mail,
  Settings,
  Users,
  LogOut,
  Headphones,
  Send,
  ShieldAlert,
  BellRing,
  PanelLeftClose,
  PanelLeft,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

const navItems = [
  { to: "/", label: "工作台", icon: Inbox, end: true },
  { to: "/linked-orders", label: "邮件订单", icon: Link2 },
  { to: "/send-logs", label: "发送日志", icon: Send },
  { to: "/risk-logs", label: "风控记录", icon: ShieldAlert },
  { to: "/alerts", label: "运营告警", icon: BellRing },
  { to: "/mailboxes", label: "邮箱配置", icon: Mail, adminOnly: true },
  // Shopify 入口暂时关闭，订单主链路走 ERP。
  // { to: "/shops", label: "Shopify 店铺", icon: Store, adminOnly: true },
  { to: "/templates", label: "回复模板", icon: Settings, adminOnly: true },
  { to: "/users", label: "用户管理", icon: Users, adminOnly: true },
];

export default function AppLayout() {
  const { user, isAdmin, roles } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate("/auth", { replace: true });
  }

  const filteredItems = navItems.filter((it) => !it.adminOnly || isAdmin);

  return (
    <div className="flex h-screen bg-background">
      <aside
        className={cn(
          "relative z-20 bg-sidebar text-sidebar-foreground flex flex-col shrink-0 transition-[width] duration-200 border-r border-sidebar-border",
          collapsed ? "w-16" : "w-48",
        )}
      >
        {/* Logo + Toggle：收起时按钮留在侧栏宽度内，避免 absolute 伸出后被右侧 main 挡住无法点击 */}
        {collapsed ? (
          <div className="flex flex-col items-center gap-2 py-4 border-b border-sidebar-border">
            <div className="w-8 h-8 rounded bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center shrink-0">
              <Headphones className="w-4 h-4" />
            </div>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="展开侧栏"
                  onClick={() => setCollapsed(false)}
                  className="h-8 w-8 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                >
                  <PanelLeft className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className="ml-1">
                展开侧栏
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <div className="flex items-center px-2.5 py-3 border-b border-sidebar-border gap-1.5 min-h-[60px]">
            <div className="w-7 h-7 rounded bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center shrink-0">
              <Headphones className="w-3.5 h-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm leading-tight">智能客服</div>
              <div className="text-[10px] opacity-60 tracking-wide">CS</div>
            </div>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="收起侧栏"
                  onClick={() => setCollapsed(true)}
                  className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                >
                  <PanelLeftClose className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="mt-1">
                收起侧栏
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 p-1.5 space-y-0.5 overflow-y-auto">
          {filteredItems.map((item) => {
            const link = (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end as any}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 px-2.5 py-2 rounded text-sm transition-colors",
                    collapsed ? "justify-center px-2" : "",
                    isActive
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "hover:bg-sidebar-accent text-sidebar-foreground/80",
                  )
                }
              >
                <item.icon className="w-4 h-4 shrink-0" />
                {!collapsed && item.label}
              </NavLink>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.to} delayDuration={300}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right" className="ml-1">
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            }
            return link;
          })}
        </nav>

        {/* User section */}
        <div
          className={cn(
            "p-2 border-t border-sidebar-border",
            collapsed ? "flex flex-col items-center gap-2" : "space-y-2",
          )}
        >
          {collapsed ? (
            <>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <div className="w-8 h-8 rounded-full bg-sidebar-accent flex items-center justify-center text-xs font-medium cursor-default">
                    {user?.email?.charAt(0).toUpperCase() || "U"}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right" className="ml-1">
                  <div className="text-xs">{user?.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {roles
                      .map(
                        (r) =>
                          (
                            {
                              admin: "管理员",
                              leader: "组长",
                              agent: "客服",
                              guest: "游客",
                            } as Record<string, string>
                          )[r] || r,
                      )
                      .join("、")}
                  </div>
                </TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleLogout}
                    className="w-8 h-8 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" className="ml-1">
                  退出登录
                </TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              <div className="text-xs">
                <div className="truncate">{user?.email}</div>
                <div className="flex gap-1 mt-1 flex-wrap">
                  {roles.map((r) => (
                    <Badge
                      key={r}
                      variant="secondary"
                      className="text-[10px] py-0 h-4"
                    >
                      {r === "admin"
                        ? "管理员"
                        : r === "leader"
                          ? "组长"
                          : r === "guest"
                            ? "游客"
                            : "客服"}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent"
              >
                <LogOut className="w-4 h-4 mr-2" /> 退出登录
              </Button>
            </>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
