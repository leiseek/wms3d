/**
 * 演示库存（09 §4，D42）：**只经 HTTP postTransaction** 写入（与真实作业同一路径，审计/台账/幂等全部生效），不直接写表。
 * 用法：node --experimental-strip-types scripts/demo-stock.ts [--api http://127.0.0.1:4700] [--user manager] [--dry-run]
 * 幂等：每条演示余额用确定性幂等键 `demo-stock:<locationId>`（演示余额每个仓位一条），重复运行返回 replayed，不会重复入库。
 * 退出码：0 成功；1 失败；5 目标 API 尚未实现 postTransaction（501）。
 */
import { parseArgs } from 'node:util';
import { demo } from '../packages/domain/src/index.ts';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: `http://127.0.0.1:${process.env.PORT_API ?? 4700}` },
    user: { type: 'string', default: 'manager' },
    password: { type: 'string', default: demo.DEMO_PASSWORD },
    'dry-run': { type: 'boolean', default: false },
  },
});
const base = `${values.api!.replace(/\/$/, '')}/api/v1`;

async function http(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const login = await http('POST', '/auth/login', {
  username: values.user,
  password: values.password,
  deviceId: 'demo-stock-seeder',
  client: 'mobile',
  appVersion: 'demo-stock',
});
if (login.status !== 200) {
  console.error(`登录失败：HTTP ${login.status} ${JSON.stringify(login.json)}`);
  process.exit(1);
}
const token = login.json.accessToken as string;
const userId = (login.json.user as { id: string }).id;
const auth = { authorization: `Bearer ${token}` };

let created = 0;
let replayed = 0;
const plan = demo.demoBalances;
if (values['dry-run']) {
  console.log(
    `dry-run：将写入 ${plan.length} 笔 INBOUND，合计 ${plan.reduce((s, b) => s + b.onHand, 0)} 件`,
  );
  process.exit(0);
}
for (const b of plan) {
  const r = await http(
    'POST',
    '/inventory/transactions',
    {
      type: 'INBOUND',
      warehouseId: demo.demoWarehouse.id,
      performedBy: userId,
      clientCreatedAt: new Date().toISOString(),
      refNo: 'DEMO-STOCK',
      note: '演示初始库存（scripts/demo-stock.ts）',
      lines: [{ locationId: b.locationId, skuId: b.skuId, qty: b.onHand }],
    },
    { ...auth, 'idempotency-key': `demo-stock:${b.locationId}` },
  );
  if (r.status === 501) {
    console.error(
      '目标 API 尚未实现 postTransaction（501）：主数据已就绪，库存稍后再补（ws-a2 合并后重跑本脚本）',
    );
    process.exit(5);
  }
  if (r.status === 201) created++;
  else if (r.status === 200) replayed++;
  else {
    console.error(`入库失败 ${b.locationCode}：HTTP ${r.status} ${JSON.stringify(r.json)}`);
    process.exit(1);
  }
}
console.log(`演示库存：新建 ${created} 笔，重放 ${replayed} 笔（共 ${plan.length}）`);
