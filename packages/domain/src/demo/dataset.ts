import type { LayoutDoc, Role } from '@wms3d/contracts';
import { DEFAULT_PATTERN, toPayload } from '../core/coding.ts';
import { expandLayout } from '../layout/expand.ts';
import { demoId } from './ids.ts';

/**
 * 演示数据集（09 §4）：mock server 与 `pnpm --filter @wms3d/api db:seed:demo` 共用，id 确定。
 * 仓库 WH1：A 区 3 条水平巷道（每条两侧各 2 个货架）、B 区 1 条竖直巷道、收货区 RCV-01、发货区 SHP-01，共 386 个仓位。
 */
export const DEMO_PASSWORD = 'Wms3d#demo';

export const demoWarehouse = {
  id: demoId('warehouse:WH1'),
  code: 'WH1',
  name: '演示一号仓',
  timezone: 'Asia/Shanghai',
  widthM: 60,
  depthM: 40,
  heightM: 10,
  locationCodePattern: DEFAULT_PATTERN,
  barcodePrefixEnabled: true,
  allowMixedSku: true,
} as const;

export const demoWarehouse2 = {
  ...demoWarehouse,
  id: demoId('warehouse:WH2'),
  code: 'WH2',
  name: '演示二号仓（空）',
} as const;

export const demoUsers: ReadonlyArray<{
  id: string;
  username: string;
  displayName: string;
  role: Role;
  allWarehouses: boolean;
  warehouseCodes: string[];
}> = [
  {
    id: demoId('user:admin'),
    username: 'admin',
    displayName: '系统管理员',
    role: 'ADMIN',
    allWarehouses: true,
    warehouseCodes: [],
  },
  {
    id: demoId('user:manager'),
    username: 'manager',
    displayName: '王主管',
    role: 'MANAGER',
    allWarehouses: true,
    warehouseCodes: [],
  },
  {
    id: demoId('user:op1'),
    username: 'op1',
    displayName: '李作业',
    role: 'OPERATOR',
    allWarehouses: false,
    warehouseCodes: ['WH1'],
  },
  {
    id: demoId('user:op2'),
    username: 'op2',
    displayName: '张作业',
    role: 'OPERATOR',
    allWarehouses: false,
    warehouseCodes: ['WH1'],
  },
  {
    id: demoId('user:viewer'),
    username: 'viewer',
    displayName: '只读访客',
    role: 'VIEWER',
    allWarehouses: false,
    warehouseCodes: ['WH1'],
  },
];

const RT = {
  key: 'std-4x3',
  name: '标准横梁架 4 列 3 层',
  bays: 4,
  levels: 3,
  positionsPerLevel: 2,
  bayWidthM: 2.7,
  depthM: 1.0,
  levelHeightsM: [1.5, 1.5, 1.5],
  beamM: 0.1,
  uprightM: 0.08,
  defaultMaxQty: 200,
};
const L = 4 * 2.7 + 5 * 0.08; // 11.2

function horizontalAisle(aisle: number, zL: number): LayoutDoc['racks'] {
  const zR = zL + 3; // 巷道宽 3m
  return [
    {
      key: `a${aisle}l1`,
      zone: 'A',
      type: RT.key,
      aisle,
      rackNo: 1,
      bayStart: 1,
      x: 2,
      z: zL,
      rotationDeg: 0,
    },
    {
      key: `a${aisle}l2`,
      zone: 'A',
      type: RT.key,
      aisle,
      rackNo: 2,
      bayStart: 9,
      x: 2 + L,
      z: zL,
      rotationDeg: 0,
    },
    {
      key: `a${aisle}r1`,
      zone: 'A',
      type: RT.key,
      aisle,
      rackNo: 1,
      bayStart: 2,
      x: 2 + L,
      z: zR,
      rotationDeg: 180,
    },
    {
      key: `a${aisle}r2`,
      zone: 'A',
      type: RT.key,
      aisle,
      rackNo: 2,
      bayStart: 10,
      x: 2 + 2 * L,
      z: zR,
      rotationDeg: 180,
    },
  ];
}

export const demoLayout: LayoutDoc = {
  schemaVersion: 2,
  warehouse: { widthM: 60, depthM: 40, heightM: 10 },
  zones: [
    {
      code: 'A',
      name: 'A 区（水平巷道）',
      kind: 'STORAGE',
      polygon: [
        [0, 0],
        [36, 0],
        [36, 40],
        [0, 40],
      ],
      color: '#5B8FF9',
    },
    {
      code: 'B',
      name: 'B 区（竖直巷道）',
      kind: 'STORAGE',
      polygon: [
        [36, 0],
        [52, 0],
        [52, 40],
        [36, 40],
      ],
      color: '#5AD8A6',
    },
    {
      code: 'RCV',
      name: '收货区',
      kind: 'RECEIVING',
      polygon: [
        [52, 0],
        [60, 0],
        [60, 10],
        [52, 10],
      ],
      color: '#F6BD16',
    },
    {
      code: 'SHP',
      name: '发货区',
      kind: 'SHIPPING',
      polygon: [
        [52, 30],
        [60, 30],
        [60, 40],
        [52, 40],
      ],
      color: '#E86452',
    },
  ],
  rackTypes: [RT],
  racks: [
    ...horizontalAisle(1, 4),
    ...horizontalAisle(2, 9.2),
    ...horizontalAisle(3, 14.4),
    {
      key: 'b1l1',
      zone: 'B',
      type: RT.key,
      aisle: 1,
      rackNo: 1,
      bayStart: 1,
      x: 44,
      z: 2,
      rotationDeg: 90,
    },
    {
      key: 'b1l2',
      zone: 'B',
      type: RT.key,
      aisle: 1,
      rackNo: 2,
      bayStart: 9,
      x: 44,
      z: 2 + L,
      rotationDeg: 90,
    },
    {
      key: 'b1r1',
      zone: 'B',
      type: RT.key,
      aisle: 1,
      rackNo: 1,
      bayStart: 2,
      x: 41,
      z: 2 + L,
      rotationDeg: 270,
    },
    {
      key: 'b1r2',
      zone: 'B',
      type: RT.key,
      aisle: 1,
      rackNo: 2,
      bayStart: 10,
      x: 41,
      z: 2 + 2 * L,
      rotationDeg: 270,
    },
  ],
  floorAreas: [
    {
      zone: 'RCV',
      locationCode: 'RCV-01',
      polygon: [
        [52, 0],
        [60, 0],
        [60, 10],
        [52, 10],
      ],
    },
    {
      zone: 'SHP',
      locationCode: 'SHP-01',
      polygon: [
        [52, 30],
        [60, 30],
        [60, 40],
        [52, 40],
      ],
    },
  ],
};

/** EAN-13 校验位 */
export function ean13(body12: string): string {
  const s = body12.split('').reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return body12 + ((10 - (s % 10)) % 10);
}

const SKU_NAMES = [
  '矿泉水 550ml',
  '纯牛奶 250ml',
  '方便面 五连包',
  '洗衣液 2kg',
  '抽纸 3层',
  '酱油 500ml',
  '食用油 5L',
  '大米 10kg',
  '牙膏 120g',
  '洗发水 400ml',
  '电池 AA 4粒',
  '垃圾袋 中号',
  '咖啡豆 1kg',
  '绿茶 500ml',
  '饼干 礼盒',
  '巧克力 排块',
  '湿巾 80抽',
  '保鲜膜 30m',
  '一次性手套',
  '螺丝刀套装',
  '胶带 48mm',
  '记号笔 黑色',
  'A4 打印纸',
  '纸箱 3号',
];
export const demoSkus = SKU_NAMES.map((name, i) => {
  const code = `SKU-${String(i + 1).padStart(3, '0')}`;
  return {
    id: demoId(`sku:${code}`),
    code,
    name,
    spec: null as string | null,
    uom: 'EA',
    safetyStock: i % 5 === 0 ? 50 : 10,
    barcodes: [
      {
        id: demoId(`barcode:${code}:1`),
        barcode: ean13(`690${String(1000000 + i * 37).padStart(9, '0')}`),
        packQty: 1,
        isPrimary: true,
      },
      ...(i % 4 === 0
        ? [
            {
              id: demoId(`barcode:${code}:12`),
              barcode: `${code}-CASE12`,
              packQty: 12,
              isPrimary: false,
            },
          ]
        : []),
    ],
  };
});

export const demoExpanded = expandLayout(demoLayout, demoWarehouse.locationCodePattern);
export const demoLocations = demoExpanded.locations.map((l) => ({
  ...l,
  id: demoId(`location:WH1:${l.code}`),
  rackId: l.rackKey ? demoId(`rack:WH1:${l.rackKey}`) : null,
  payload: toPayload(demoWarehouse.code, l.code, demoWarehouse.barcodePrefixEnabled),
}));
export const demoRacks = demoExpanded.racks.map((r) => ({ ...r, id: demoId(`rack:WH1:${r.key}`) }));

/** 初始库存（确定性）：约 1/3 仓位有货。seed 时以 INBOUND 交易写入（走 postTransaction）。 */
export const demoBalances = demoLocations
  .filter((l, i) => l.rackKey && i % 3 === 0)
  .map((l, i) => ({
    locationId: l.id,
    locationCode: l.code,
    skuId: demoSkus[i % demoSkus.length]!.id,
    onHand: 5 + ((i * 37) % 120),
  }));
