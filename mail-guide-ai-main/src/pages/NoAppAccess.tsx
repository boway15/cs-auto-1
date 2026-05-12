import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

export default function NoAppAccess() {
  const { isGuest } = useAuth();

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <p className="text-lg font-medium text-foreground">
        {isGuest ? "无业务权限（游客账号）" : "无对应权限，请联系管理员分配权限"}
      </p>
      <p className="text-sm text-muted-foreground max-w-md">
        {isGuest
          ? "当前为游客账号，无法查看邮件、订单与任务数据。请联络管理员在「用户管理」中将您调整为管理员、组长或客服后再使用工作台。"
          : "您的账号已成功登录，但尚未被分配客服系统角色（管理员 / 组长 / 客服）。请联络管理员在「用户管理」中为您开通后再试。"}
      </p>
      <Button type="button" variant="secondary" onClick={() => void handleSignOut()}>
        退出登录
      </Button>
    </div>
  );
}
