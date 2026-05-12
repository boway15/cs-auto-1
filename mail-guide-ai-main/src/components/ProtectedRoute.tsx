import { Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import NoAppAccess from "@/pages/NoAppAccess";

export default function ProtectedRoute({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { session, isAdmin, loading, hasAppAccess, rolesLoading } = useAuth();
  const gateLoading = loading || (!!session?.user && rolesLoading);
  if (gateLoading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">加载中...</div>;
  if (!session) return <Navigate to="/auth" replace />;
  if (!hasAppAccess) return <NoAppAccess />;
  if (adminOnly && !isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
