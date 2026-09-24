import { HttpError } from "./http-response.js";

export type AdminPageSize = number | "all";

export interface AdminPagination {
  page: number;
  pageSize: AdminPageSize;
  total: number;
  totalPages: number;
  hasNext: boolean;
}

export function paginateAdminList<T>(items: readonly T[], url: URL): {
  items: T[];
  pagination: AdminPagination;
} {
  const rawPage = url.searchParams.get("page");
  const page = rawPage === null || rawPage === "" ? 1 : Number(rawPage);
  if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, "invalid_page");

  const rawPageSize = url.searchParams.get("pageSize");
  const pageSize: AdminPageSize = rawPageSize === "all" || rawPageSize === null || rawPageSize === ""
    ? "all"
    : Number(rawPageSize);
  if (pageSize !== "all" && (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)) {
    throw new HttpError(400, "invalid_page_size");
  }

  const total = items.length;
  if (pageSize === "all") {
    return { items: [...items], pagination: { page: 1, pageSize, total, totalPages: 1, hasNext: false } };
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  return {
    items: items.slice(offset, offset + pageSize),
    pagination: { page: safePage, pageSize, total, totalPages, hasNext: safePage < totalPages },
  };
}
