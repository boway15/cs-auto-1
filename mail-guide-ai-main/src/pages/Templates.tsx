import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

/** 旧路径 /templates#* 兼容重定向 */
export default function TemplatesRedirect() {
  const location = useLocation();
  const { isAdmin } = useAuth();

  if (location.hash === "#auto-reply-settings" && isAdmin) {
    return <Navigate to="/auto-reply-templates" replace />;
  }
  if (location.hash === "#quick-replies") {
    return <Navigate to="/quick-reply-templates" replace />;
  }
  return <Navigate to={isAdmin ? "/auto-reply-templates" : "/quick-reply-templates"} replace />;
}
