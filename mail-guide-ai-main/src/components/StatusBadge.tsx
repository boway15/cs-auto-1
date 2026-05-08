import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const map: Record<string, { label: string; cls: string }> = {
  pending: { label: "待处理", cls: "bg-warning/15 text-warning border-warning/30" },
  processing: { label: "处理中", cls: "bg-primary/15 text-primary border-primary/30" },
  replied: { label: "已回复", cls: "bg-success/15 text-success border-success/30" },
  // 兼容历史状态：closed 在前台统一按“已回复”展示
  closed: { label: "已回复", cls: "bg-success/15 text-success border-success/30" },
};

export function StatusBadge({ status }: { status: string }) {
  const m = map[status] ?? { label: status, cls: "" };
  return <Badge variant="outline" className={cn("font-normal", m.cls)}>{m.label}</Badge>;
}
