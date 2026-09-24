import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PortalContainer } from '../../api';

export type AdminPageSize = 20 | 50 | 100 | 'all';
const PAGE_SIZE_OPTIONS: AdminPageSize[] = [20, 50, 100, 'all'];

export function normalizeAdminPageSize(value: string | null, fallback: AdminPageSize = 20): AdminPageSize {
  if (value === 'all') return 'all';
  const numeric = Number(value);
  return PAGE_SIZE_OPTIONS.includes(numeric as AdminPageSize) ? numeric as AdminPageSize : fallback;
}

export function usePersistentPageSize(listKey: string, fallback: AdminPageSize = 20): [AdminPageSize, (value: AdminPageSize) => void] {
  const storageKey = `openapp.admin.pagination.${listKey}`;
  const [pageSize, setPageSize] = useState<AdminPageSize>(() => {
    if (typeof window === 'undefined') return fallback;
    return normalizeAdminPageSize(window.localStorage.getItem(storageKey), fallback);
  });
  useEffect(() => { window.localStorage.setItem(storageKey, String(pageSize)); }, [pageSize, storageKey]);
  return [pageSize, setPageSize];
}

export function PaginationBar({ page, total, pageSize, onPage, onPageSize }: {
  page: number;
  total: number;
  pageSize: AdminPageSize;
  onPage(page: number): void;
  onPageSize(size: AdminPageSize): void;
}) {
  const size = pageSize === 'all' ? Math.max(total, 1) : pageSize;
  const totalPages = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  if (total <= 0) return null;
  return <div className="pagination-bar">
    <span>{total} 条</span>
    <label>每页<select value={pageSize} onChange={(event) => onPageSize(event.target.value === 'all' ? 'all' : Number(event.target.value) as AdminPageSize)}>
      {PAGE_SIZE_OPTIONS.map((option) => <option value={option} key={option}>{option === 'all' ? '全部' : option}</option>)}
    </select></label>
    {pageSize !== 'all' && <><span>第 {currentPage}/{totalPages} 页</span><button className="icon-button compact" title="上一页" aria-label="上一页" disabled={currentPage <= 1} onClick={() => onPage(currentPage - 1)}><ChevronLeft size={15} /></button><button className="icon-button compact" title="下一页" aria-label="下一页" disabled={currentPage >= totalPages} onClick={() => onPage(currentPage + 1)}><ChevronRight size={15} /></button></>}
  </div>;
}

export function paginateItems<T>(items: readonly T[], page: number, pageSize: AdminPageSize): T[] {
  if (pageSize === 'all') return [...items];
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function Status({ status }: { status: PortalContainer['status'] }) {
  const labels: Record<PortalContainer['status'], string> = {
    creating: '创建中',
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    failed: '异常',
  };
  return <span className={`status ${status}`}><i />{labels[status]}</span>;
}

export function EmptyRow({ columns, text }: { columns: number; text: string }) {
  return <tr><td colSpan={columns} className="table-empty">{text}</td></tr>;
}

export function message(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message === 'config_revision_conflict') return '配置已被其他管理员修改，请刷新后再保存。';
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function createUserErrorMessage(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : '';
  if (code === 'valid_email_required' || code === 'invalid_email') return '请输入有效的用户邮箱地址。';
  if (code === 'account_exists') return '该邮箱已经存在 OpenApp 账号。';
  if (code === 'invalid_role') return '请选择有效的账号角色。';
  if (code === 'password_required' || code === 'password_too_short') return '初始密码至少需要 12 个字符。';
  if (code === 'password_too_long') return '初始密码过长。';
  if (code === 'super_admin_required' || code === 'target_role_not_manageable') return '只有超级管理员可以创建管理账号。';
  if (code === 'network_unavailable') return '无法连接管理服务，请检查网络后重试。';
  return message(reason, '用户创建失败，请稍后重试。');
}
