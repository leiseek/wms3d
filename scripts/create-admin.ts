/**
 * 生产首个管理员（运维引导）。生产库不写演示数据，安装后用本脚本建一个 ADMIN（all_warehouses，首登强制改密）。
 * 本地 shim（ws-f）：正式实现已提契约请求 docs/contract-requests/ws-f-1.md（建议由 apps/api 提供同名 CLI，复用 users 模块与审计）；
 * 合并后删除本文件。与 apps/api/src/db/seed-demo.ts 使用相同的列与 argon2id 参数。
 * 用法：node --experimental-strip-types scripts/create-admin.ts --url <DATABASE_URL> --username <name> [--display-name 名称]
 *       临时密码从环境变量 WMS_ADMIN_TEMP_PASSWORD 读取（不经命令行，避免进 shell 历史/进程列表）；≥ 12 字符。
 */
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const req = createRequire(new URL('../apps/api/package.json', import.meta.url));
// 依赖解析自 apps/api（根 package.json 不含 argon2/pg）；类型只声明用到的部分
const argon2 = req('argon2') as {
  argon2id: number;
  hash(pw: string, o: { type: number }): Promise<string>;
};
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}
const pg = req('pg') as { Client: new (o: { connectionString: string }) => PgClient };

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.DATABASE_URL },
    username: { type: 'string' },
    'display-name': { type: 'string', default: '系统管理员' },
  },
});
const password = process.env.WMS_ADMIN_TEMP_PASSWORD ?? '';
if (!values.url || !values.username) {
  console.error('缺少 --url 或 --username');
  process.exit(2);
}
if (password.length < 12) {
  console.error('请通过环境变量 WMS_ADMIN_TEMP_PASSWORD 提供 ≥ 12 字符的临时密码');
  process.exit(2);
}
const client = new pg.Client({ connectionString: values.url });
await client.connect();
try {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const r = await client.query(
    `INSERT INTO users (username, display_name, password_hash, role, all_warehouses, must_change_password)
     VALUES ($1, $2, $3, 'ADMIN', true, true) ON CONFLICT DO NOTHING RETURNING id`,
    [values.username, values['display-name'], hash],
  );
  if (!r.rowCount) {
    console.error(`用户 ${values.username} 已存在，未修改`);
    process.exitCode = 1;
  } else console.log(`已创建管理员 ${values.username}（首次登录须改密）`);
} finally {
  await client.end();
}
