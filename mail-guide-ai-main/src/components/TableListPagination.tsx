import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ADMIN_LIST_PAGE_SIZE,
  clampListPage,
  listPageCount,
  parseListPageJumpInput,
} from "@/lib/list-pagination";

type TableListPaginationProps = {
  page: number;
  total: number;
  pageSize?: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  className?: string;
  /** 为 false 时中间仅显示页码，不显示「共 N 条」 */
  showTotal?: boolean;
};

/** 表格列表底部分页（样式与工作台邮件队列一致） */
export function TableListPagination({
  page,
  total,
  pageSize = ADMIN_LIST_PAGE_SIZE,
  loading = false,
  onPageChange,
  className = "",
  showTotal = true,
}: TableListPaginationProps) {
  const pageCount = listPageCount(total, pageSize);
  const pageSafe = clampListPage(page, pageCount);
  const [jumpDraft, setJumpDraft] = useState(String(pageSafe + 1));

  useEffect(() => {
    setJumpDraft(String(pageSafe + 1));
  }, [pageSafe]);

  if (total <= pageSize) return null;

  const commitJump = () => {
    const target = parseListPageJumpInput(jumpDraft, pageCount);
    if (target == null) {
      setJumpDraft(String(pageSafe + 1));
      return;
    }
    if (target !== pageSafe) onPageChange(target);
    else setJumpDraft(String(pageSafe + 1));
  };

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
      <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
        {showTotal ? <>共 {total} 条 · </> : null}
        第
        <Input
          type="number"
          min={1}
          max={pageCount}
          inputMode="numeric"
          aria-label="跳转到页码"
          className="h-6 w-11 px-1 text-center text-[10px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          value={jumpDraft}
          disabled={loading}
          onChange={(e) => setJumpDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitJump();
            }
          }}
          onBlur={commitJump}
        />
        / {pageCount} 页
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[10px] text-muted-foreground"
          disabled={loading}
          onClick={commitJump}
        >
          跳转
        </Button>
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
