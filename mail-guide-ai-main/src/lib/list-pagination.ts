/** 管理端列表页默认每页条数（与工作台列表一致） */
export const ADMIN_LIST_PAGE_SIZE = 50;

export function listPageCount(total: number, pageSize = ADMIN_LIST_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function listPageRange(page: number, pageSize = ADMIN_LIST_PAGE_SIZE): { from: number; to: number } {
  const from = page * pageSize;
  return { from, to: from + pageSize - 1 };
}

export function clampListPage(page: number, pageCount: number): number {
  return Math.min(Math.max(0, page), Math.max(0, pageCount - 1));
}

/** 将用户输入的 1-based 页码转为 0-based 页索引；无效输入返回 null */
export function parseListPageJumpInput(raw: string, pageCount: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return clampListPage(n - 1, pageCount);
}
