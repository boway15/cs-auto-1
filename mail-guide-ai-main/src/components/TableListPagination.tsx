import { Button } from "@/components/ui/button";
import { ADMIN_LIST_PAGE_SIZE, clampListPage, listPageCount } from "@/lib/list-pagination";

type TableListPaginationProps = {
  page: number;
  total: number;
  pageSize?: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  className?: string;
};

/** 表格列表底部分页（样式与工作台邮件队列一致） */
export function TableListPagination({
  page,
  total,
  pageSize = ADMIN_LIST_PAGE_SIZE,
  loading = false,
  onPageChange,
  className = "",
}: TableListPaginationProps) {
  if (total <= pageSize) return null;

  const pageCount = listPageCount(total, pageSize);
  const pageSafe = clampListPage(page, pageCount);

  return (
    <div
      className={`shrink-0 flex items-center justify-between gap-2 border-t bg-background px-3 py-2 ${className}`.trim()}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 text-xs flex-1 max-w-[120px]"
        disabled={pageSafe <= 0 || loading}
        onClick={() => onPageChange(pageSafe - 1)}
      >
        上一页
      </Button>
      <span className="text-[10px] text-muted-foreground shrink-0">
        共 {total} 条 · 第 {pageSafe + 1} / {pageCount} 页
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 text-xs flex-1 max-w-[120px]"
        disabled={pageSafe >= pageCount - 1 || loading}
        onClick={() => onPageChange(pageSafe + 1)}
      >
        下一页
      </Button>
    </div>
  );
}
