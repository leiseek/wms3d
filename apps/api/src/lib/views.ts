import type { Me, User } from '@wms3d/contracts';
import { iso, type Queryable } from './db.ts';

interface WhRef {
  id: string;
  code: string;
  name: string;
}

/** 用户可访问的仓库（all_warehouses → 全部）。 */
export async function warehouseRefs(
  q: Queryable,
  userIds: string[],
): Promise<Map<string, WhRef[]>> {
  const out = new Map<string, WhRef[]>(userIds.map((id) => [id, []]));
  if (!userIds.length) return out;
  const r = await q.query<{ user_id: string; id: string; code: string; name: string }>(
    `SELECT u.id AS user_id, w.id, w.code, w.name
       FROM users u
       JOIN warehouses w ON u.all_warehouses
                         OR EXISTS (SELECT 1 FROM user_warehouses uw WHERE uw.user_id = u.id AND uw.warehouse_id = w.id)
      WHERE u.id = ANY($1::uuid[])
      ORDER BY w.code`,
    [userIds],
  );
  for (const row of r.rows)
    out.get(row.user_id)!.push({ id: row.id, code: row.code, name: row.name });
  return out;
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: User['role'];
  all_warehouses: boolean;
  must_change_password: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}
export const USER_COLS = `id, username::text AS username, display_name, role, all_warehouses, must_change_password, is_active, created_at, updated_at`;

export async function usersView(q: Queryable, rows: UserRow[]): Promise<User[]> {
  const refs = await warehouseRefs(
    q,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    allWarehouses: r.all_warehouses,
    warehouses: refs.get(r.id) ?? [],
    isActive: r.is_active,
    mustChangePassword: r.must_change_password,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }));
}

export async function loadUser(q: Queryable, id: string): Promise<User | null> {
  const r = await q.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  if (!r.rows[0]) return null;
  return (await usersView(q, r.rows))[0]!;
}

export async function loadMe(q: Queryable, id: string): Promise<Me | null> {
  const u = await loadUser(q, id);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    allWarehouses: u.allWarehouses,
    warehouses: u.warehouses,
    mustChangePassword: u.mustChangePassword,
  };
}
