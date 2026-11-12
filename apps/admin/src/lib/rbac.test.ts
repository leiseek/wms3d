import { describe, expect, it } from 'vitest';
import { routes, type Role } from '@wms3d/contracts';
import { can, NAV, navFor, pathAllowed, type NavItem } from './rbac';

const flat = (items: NavItem[]): NavItem[] =>
  items.flatMap((i) => (i.children ? flat(i.children) : [i]));
const keys = (role: Role) => flat(navFor(role)).map((i) => i.key);

describe('权限菜单', () => {
  it('viewer 只读：无用户、审计、调整、标签、布局', () => {
    expect(keys('VIEWER')).toEqual([
      'dashboard',
      'stock',
      'movements',
      'txns',
      'twin',
      'skus',
      'locations',
      'warehouses',
    ]);
  });
  it('operator 多出标签（补打）', () => {
    expect(keys('OPERATOR')).toContain('labels');
    expect(keys('OPERATOR')).not.toContain('adjust');
  });
  it('manager 无用户管理；admin 全部', () => {
    expect(keys('MANAGER')).not.toContain('users');
    expect(keys('MANAGER')).toContain('audit');
    expect(keys('ADMIN')).toHaveLength(flat(NAV).length);
  });
  it('分组内全部隐藏时整组隐藏', () => {
    expect(navFor('VIEWER').map((i) => i.key)).not.toContain('system');
  });
  it('路由守卫', () => {
    expect(pathAllowed('VIEWER', '/users')).toBe(false);
    expect(pathAllowed('VIEWER', '/stock')).toBe(true);
    expect(pathAllowed('ADMIN', '/users')).toBe(true);
    expect(pathAllowed('MANAGER', '/nope')).toBe(false);
  });
});

describe('能力与契约 roles 一致', () => {
  const allowed = (id: keyof typeof routes, role: Role) => {
    const r = routes[id].roles;
    return r === 'any' || (Array.isArray(r) && r.includes(role));
  };
  const ROLES: Role[] = ['ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'];
  it.each(ROLES)('%s', (role) => {
    const me = { role, allWarehouses: true };
    expect(can(me, 'users.manage')).toBe(allowed('createUser', role));
    expect(can(me, 'labels.print')).toBe(allowed('renderLabels', role));
    expect(can(me, 'labels.requestReprint')).toBe(allowed('createReprint', role));
    expect(can(me, 'location.write')).toBe(allowed('bulkPatchLocations', role));
    expect(can(me, 'warehouse.write')).toBe(allowed('patchWarehouse', role));
    expect(can(me, 'rackType.write')).toBe(allowed('createRackType', role));
    expect(can(me, 'inventory.export')).toBe(allowed('exportMovements', role));
    expect(can(me, 'audit.read')).toBe(allowed('auditLogs', role));
    expect(can(me, 'inventory.write')).toBe(allowed('postTransaction', role));
  });
  it('NAV 每个页面的角色 ⊆ 其主数据端点的角色', () => {
    const map: Record<string, keyof typeof routes> = {
      users: 'listUsers',
      audit: 'auditLogs',
      labels: 'listReprints',
      rackTypes: 'listRackTypes',
      layout: 'listLayoutVersions',
      stock: 'listBalances',
      movements: 'listMovements',
      skus: 'listSkus',
    };
    for (const item of flat(NAV))
      if (map[item.key])
        for (const r of item.roles)
          expect(allowed(map[item.key]!, r), `${item.key}/${r}`).toBe(true);
  });
  it('skuWrite：ADMIN 或 allWarehouses 的 MANAGER', () => {
    expect(can({ role: 'ADMIN', allWarehouses: false }, 'sku.write')).toBe(true);
    expect(can({ role: 'MANAGER', allWarehouses: true }, 'sku.write')).toBe(true);
    expect(can({ role: 'MANAGER', allWarehouses: false }, 'sku.write')).toBe(false);
    expect(can({ role: 'OPERATOR', allWarehouses: true }, 'sku.write')).toBe(false);
    expect(can(null, 'sku.write')).toBe(false);
  });
});
