import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const map: Record<string, { label: string; cls: string }> = {
  pending: { label: "待处理", cls: "bg-warning/15 text-warning border-warning/30" },
  processing: { label: "待处理", cls: "bg-warning/15 text-warning border-warning/30" },
  replied: { label: "已回复", cls: "bg-success/15 text-success border-success/30" },
  auto_replied: { label: "自动回复", cls: "bg-info/15 text-info border-info/30" },
  // 兼容历史状态：closed 在前台统一按“已回复”展示
  closed: { label: "已回复", cls: "bg-success/15 text-success border-success/30" },
};

export function StatusBadge({
  status,
  processingStatus,
}: {
  status: string;
  processingStatus?: string | null;
}) {
  if (status === "replied" && processingStatus === "auto_replied") {
    const m = map.auto_replied;
    return <Badge variant="outline" className={cn("font-normal", m.cls)}>{m.label}</Badge>;
  }
  const m = map[status] ?? { label: status, cls: "" };
  return <Badge variant="outline" className={cn("font-normal", m.cls)}>{m.label}</Badge>;
}
