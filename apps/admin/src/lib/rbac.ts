import type { Me, Role } from '@wms3d/contracts';

export type Ability =
  | 'sku.write'
  | 'location.write'
  | 'warehouse.write'
  | 'rackType.read'
  | 'rackType.write'
  | 'layout.edit'
  | 'labels.print'
  | 'labels.requestReprint'
  | 'inventory.write'
  | 'inventory.adjust'
  | 'inventory.export'
  | 'users.manage'
  | 'audit.read';

const ROLE_ABILITIES: Record<Role, readonly Ability[]> = {
  ADMIN: [
    'sku.write',
    'location.write',
    'warehouse.write',
    'rackType.read',
    'rackType.write',
    'layout.edit',
    'labels.print',
    'labels.requestReprint',
    'inventory.write',
    'inventory.adjust',
    'inventory.export',
    'users.manage',
    'audit.read',
  ],
  MANAGER: [
    'location.write',
    'rackType.read',
    'layout.edit',
    'labels.print',
    'labels.requestReprint',
    'inventory.write',
    'inventory.adjust',
    'inventory.export',
    'audit.read',
  ],
  OPERATOR: ['labels.requestReprint', 'inventory.write'],
  VIEWER: [],
};

/** 与契约 roles/policy 一致（routes.ts）。skuWrite：ADMIN，或 allWarehouses 的 MANAGER（D25）。 */
export function can(me: Pick<Me, 'role' | 'allWarehouses'> | null | undefined, a: Ability) {
  if (!me) return false;
  if (a === 'sku.write') return me.role === 'ADMIN' || (me.role === 'MANAGER' && me.allWarehouses);
  return ROLE_ABILITIES[me.role].includes(a);
}

export interface NavItem {
  key: string;
  label: string;
  path?: string;
  roles: readonly Role[];
  children?: NavItem[];
}

const ALL: readonly Role[] = ['ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'];
const MGR: readonly Role[] = ['ADMIN', 'MANAGER'];

/** 信息架构（05 §1）。roles = 能看到该菜单的角色（与对应 GET 端点的 roles 一致）。 */
export const NAV: NavItem[] = [
  { key: 'dashboard', label: '看板', path: '/', roles: ALL },
  {
    key: 'inv',
    label: '库存',
    roles: ALL,
    children: [
      { key: 'stock', label: '库存查询', path: '/stock', roles: ALL },
      { key: 'movements', label: '流水台账', path: '/movements', roles: ALL },
      { key: 'txns', label: '交易单', path: '/transactions', roles: ALL },
      { key: 'adjust', label: '调整 / 移库', path: '/adjust', roles: MGR },
    ],
  },
  { key: 'twin', label: '3D 孪生', path: '/twin', roles: ALL },
  {
    key: 'master',
    label: '主数据',
    roles: ALL,
    children: [
      { key: 'skus', label: 'SKU', path: '/skus', roles: ALL },
      { key: 'locations', label: '仓位', path: '/locations', roles: ALL },
    ],
  },
  {
    key: 'design',
    label: '仓库设计',
    roles: ALL,
    children: [
      { key: 'warehouses', label: '仓库 / 库区 / 货架', path: '/warehouses', roles: ALL },
      { key: 'rackTypes', label: '货架模板', path: '/rack-types', roles: MGR },
      { key: 'layout', label: '布局设计器', path: '/layout', roles: MGR },
    ],
  },
  { key: 'labels', label: '标签打印', path: '/labels', roles: ['ADMIN', 'MANAGER', 'OPERATOR'] },
  {
    key: 'system',
    label: '系统',
    roles: MGR,
    children: [
      { key: 'users', label: '用户与设备', path: '/users', roles: ['ADMIN'] },
      { key: 'audit', label: '审计日志', path: '/audit', roles: MGR },
    ],
  },
];

/** 按角色过滤菜单；子菜单全被过滤掉的分组一并隐藏。 */
export function navFor(role: Role, items: NavItem[] = NAV): NavItem[] {
  const out: NavItem[] = [];
  for (const it of items) {
    if (!it.roles.includes(role)) continue;
    if (it.children) {
      const children = navFor(role, it.children);
      if (children.length) out.push({ ...it, children });
    } else out.push(it);
  }
  return out;
}

/** 路由守卫用：某路径是否对该角色可见。 */
export function pathAllowed(role: Role, path: string, items: NavItem[] = NAV): boolean {
  for (const it of items) {
    if (it.path === path) return it.roles.includes(role);
    if (it.children && it.roles.includes(role) && pathAllowed(role, path, it.children)) return true;
  }
  return false;
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: '管理员',
  MANAGER: '主管',
  OPERATOR: '操作员',
  VIEWER: '只读',
};
