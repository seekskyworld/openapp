export const ADMIN_VIEWS = ['overview', 'resources', 'apps', 'policy', 'runtime', 'forwarding', 'operations'] as const;
export type AdminView = typeof ADMIN_VIEWS[number];
