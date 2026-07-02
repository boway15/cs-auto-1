import QuickReplyTemplatesTab from "@/components/QuickReplyTemplatesTab";
import { useAuth } from "@/hooks/useAuth";

export default function QuickReplyTemplatesPage() {
  const { isAdmin, user } = useAuth();

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">快捷回复</h1>
        <p className="text-sm text-muted-foreground mt-1">
          管理工作台一键插入的快捷回复模板（团队共享 + 个人模板）。
        </p>
      </div>
      {user ? (
        <QuickReplyTemplatesTab isAdmin={isAdmin} userId={user.id} />
      ) : (
        <p className="text-sm text-muted-foreground">加载用户信息…</p>
      )}
    </div>
  );
}
