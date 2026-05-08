import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Eye, EyeOff, Headphones } from "lucide-react";

function mapAuthErrorMessage(raw: string): string {
  const msg = raw.toLowerCase();
  if (msg.includes("invalid login credentials")) {
    return "邮箱或密码错误，请检查后重试。";
  }
  if (msg.includes("email not confirmed")) {
    return "邮箱尚未验证，请先完成邮箱验证后再登录。";
  }
  if (msg.includes("too many requests")) {
    return "尝试次数过多，请稍后再试。";
  }
  if (msg.includes("signup is disabled")) {
    return "当前项目已关闭注册，请联系管理员。";
  }
  if (msg.includes("user already registered")) {
    return "该邮箱已注册，请直接登录。";
  }
  if (msg.includes("password should be at least")) {
    return "密码长度不足，请至少输入 6 位。";
  }
  return raw;
}

export default function AuthPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPasswordIn, setShowPasswordIn] = useState(false);
  const [showPasswordUp, setShowPasswordUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (loading) return null;
  if (session) return <Navigate to="/" replace />;

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (error) {
      toast.error(mapAuthErrorMessage(error.message));
    } else {
      toast.success("登录成功");
      navigate("/", { replace: true });
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
        data: { display_name: displayName || email.split("@")[0] },
      },
    });
    setSubmitting(false);
    if (error) {
      toast.error(mapAuthErrorMessage(error.message));
    } else {
      toast.success("注册成功，正在登录...");
      navigate("/", { replace: true });
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-accent via-background to-accent p-4">
      <Card className="w-full max-w-md shadow-[var(--shadow-elevated)]">
        <CardHeader className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
            <Headphones className="w-6 h-6" />
          </div>
          <CardTitle className="text-2xl">智能客服工作台</CardTitle>
          <CardDescription>跨境独立站邮件客服 · AI 辅助回复</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="signin">
            <TabsList className="grid grid-cols-2 w-full mb-4">
              <TabsTrigger value="signin">登录</TabsTrigger>
              <TabsTrigger value="signup">注册</TabsTrigger>
            </TabsList>

            <TabsContent value="signin">
              <form onSubmit={handleSignIn} className="space-y-3">
                <div>
                  <Label htmlFor="email-in">邮箱</Label>
                  <Input id="email-in" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="pw-in">密码</Label>
                  <div className="relative">
                    <Input
                      id="pw-in"
                      type={showPasswordIn ? "text" : "password"}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      aria-label={showPasswordIn ? "隐藏密码" : "显示密码"}
                      onClick={() => setShowPasswordIn((v) => !v)}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                    >
                      {showPasswordIn ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "登录中..." : "登录"}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignUp} className="space-y-3">
                <div>
                  <Label htmlFor="name-up">显示名</Label>
                  <Input id="name-up" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="客服小王" />
                </div>
                <div>
                  <Label htmlFor="email-up">邮箱</Label>
                  <Input id="email-up" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="pw-up">密码（至少 6 位）</Label>
                  <div className="relative">
                    <Input
                      id="pw-up"
                      type={showPasswordUp ? "text" : "password"}
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      aria-label={showPasswordUp ? "隐藏密码" : "显示密码"}
                      onClick={() => setShowPasswordUp((v) => !v)}
                      className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                    >
                      {showPasswordUp ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "注册中..." : "注册"}
                </Button>
                <p className="text-xs text-muted-foreground text-center">首位注册账号将自动获得管理员权限</p>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
