import type { PortalUser, UserRole } from './api';

export function isManagementRole(role: UserRole): role is 'admin' | 'super_admin' {
  return role === 'admin' || role === 'super_admin';
}

export function canGovernUserRole(actor: PortalUser, target: PortalUser): boolean {
  return actor.role === 'super_admin' && actor.id !== target.id;
}

export function userRoleLabel(role: UserRole): string {
  if (role === 'super_admin') return '超级管理员';
  if (role === 'admin') return '管理员';
  return '成员';
}
