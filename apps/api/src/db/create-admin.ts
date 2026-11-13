/**
 * 生产首个管理员（ws-f-1 #2，Lead）：建 ADMIN（all_warehouses、首登强制改密）并写审计，同一事务。
 * 用法：WMS_ADMIN_TEMP_PASSWORD=… pnpm --filter @wms3d/api admin:create -- --username <name> [--display-name 名称] [--url <DATABASE_URL>]
 * 临时密码只从环境变量读取（不进命令行/进程列表），≥ 12 字符。已存在同名用户 → 退出码 1，不修改。
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { hashPassword } from '../modules/auth/service.ts';

export type CreateAdminResult = { status: 'created'; id: string } | { status: 'exists' };

export async function createAdmin(
  url: string,
  opts: { username: string; displayName?: string; password: string },
): Promise<CreateAdminResult> {
  if (opts.password.length < 12) throw new Error('临时密码须 ≥ 12 字符');
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(opts.username)) throw new Error('用户名格式不正确');
  const hash = await hashPassword(opts.password);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, all_warehouses, must_change_password)
       VALUES ($1, $2, $3, 'ADMIN', true, true) ON CONFLICT DO NOTHING RETURNING id`,
      [opts.username, opts.displayName ?? '系统管理员', hash],
    );
    const id = r.rows[0]?.id;
    if (!id) {
      await client.query('ROLLBACK');
      return { status: 'exists' };
    }
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, result, after)
       VALUES (NULL, 'user.create', 'user', $1, 'SUCCESS', $2)`,
      [id, JSON.stringify({ username: opts.username, role: 'ADMIN', source: 'cli:create-admin' })],
    );
    await client.query('COMMIT');
    return { status: 'created', id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: process.env.DATABASE_URL },
      username: { type: 'string' },
      'display-name': { type: 'string' },
    },
  });
  const password = process.env.WMS_ADMIN_TEMP_PASSWORD ?? '';
  if (!values.url || !values.username) {
    console.error('缺少 --username 或 DATABASE_URL/--url');
    process.exit(2);
  }
  if (password.length < 12) {
    console.error('请通过环境变量 WMS_ADMIN_TEMP_PASSWORD 提供 ≥ 12 字符的临时密码');
    process.exit(2);
  }
  const r = await createAdmin(values.url, {
    username: values.username,
    displayName: values['display-name'],
    password,
  });
  if (r.status === 'exists') {
    console.error(`用户 ${values.username} 已存在，未修改`);
    process.exitCode = 1;
  } else console.log(`已创建管理员 ${values.username}（首次登录须改密）`);
}
