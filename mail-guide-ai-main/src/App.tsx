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
import Templates from "./pages/Templates";
import ErpNotifyTemplates from "./pages/ErpNotifyTemplates";
import Users from "./pages/Users";
import SendLogs from "./pages/SendLogs";
import LinkedOrders from "./pages/LinkedOrders";
import RiskLogs from "./pages/RiskLogs";
import Alerts from "./pages/Alerts";
import HelpCenter from "./pages/HelpCenter";
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
            <Route path="/linked-orders" element={<LinkedOrders />} />
            <Route path="/mailboxes" element={<ProtectedRoute adminOnly><Mailboxes /></ProtectedRoute>} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/erp-notify-templates" element={<ProtectedRoute adminOnly><ErpNotifyTemplates /></ProtectedRoute>} />
            <Route path="/users" element={<ProtectedRoute adminOnly><Users /></ProtectedRoute>} />
            <Route path="/send-logs" element={<SendLogs />} />
            <Route path="/risk-logs" element={<RiskLogs />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/help" element={<HelpCenter />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
