import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppLayout from "@/components/AppLayout";
import ProtectedRoute from "@/components/ProtectedRoute";
import AuthPage from "./pages/Auth";
import Workbench from "./pages/Workbench";
import Mailboxes from "./pages/Mailboxes";
// Shopify 订单链路暂时降级，当前项目订单以 ERP 对接为主。
// import Shops from "./pages/Shops";
import Erp from "./pages/Erp";
import Templates from "./pages/Templates";
import Users from "./pages/Users";
import SendLogs from "./pages/SendLogs";
import RiskLogs from "./pages/RiskLogs";
import Alerts from "./pages/Alerts";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
            <Route path="/" element={<Workbench />} />
            <Route path="/mailboxes" element={<ProtectedRoute adminOnly><Mailboxes /></ProtectedRoute>} />
            {/* Shopify 入口暂时关闭，订单主链路走 ERP。 */}
            {/* <Route path="/shops" element={<ProtectedRoute adminOnly><Shops /></ProtectedRoute>} /> */}
            <Route path="/erp" element={<ProtectedRoute adminOnly><Erp /></ProtectedRoute>} />
            <Route path="/templates" element={<ProtectedRoute adminOnly><Templates /></ProtectedRoute>} />
            <Route path="/users" element={<ProtectedRoute adminOnly><Users /></ProtectedRoute>} />
            <Route path="/send-logs" element={<SendLogs />} />
            <Route path="/risk-logs" element={<RiskLogs />} />
            <Route path="/alerts" element={<Alerts />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
