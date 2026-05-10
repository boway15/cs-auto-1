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
  Database,
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
  { to: "/erp", label: "ERP 配置", icon: Database, adminOnly: true },
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
          "bg-sidebar text-sidebar-foreground flex flex-col shrink-0 transition-all duration-200",
          collapsed ? "w-16" : "w-60",
        )}
      >
        {/* Logo + Toggle */}
        <div className="flex items-center px-4 py-5 border-b border-sidebar-border gap-2 min-h-[65px]">
          {collapsed ? (
            <div className="w-8 h-8 rounded bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center shrink-0 mx-auto">
              <Headphones className="w-4 h-4" />
            </div>
          ) : (
            <>
              <div className="w-8 h-8 rounded bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center shrink-0">
                <Headphones className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">智能客服</div>
                <div className="text-xs opacity-60">Customer Service</div>
              </div>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              "shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent",
              collapsed && "absolute -right-3 z-10 w-6 h-6 rounded-full bg-sidebar border border-sidebar-border shadow-sm",
            )}
          >
            {collapsed ? (
              <PanelLeft className="w-4 h-4" />
            ) : (
              <PanelLeftClose className="w-4 h-4" />
            )}
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {filteredItems.map((item) => {
            const link = (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end as any}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors",
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
            "p-3 border-t border-sidebar-border",
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
