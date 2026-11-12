/**
 * 生成样张 PDF 与 PNG 预览，写入 /workspace/wms3d-artifacts/labels/（并同步一份到 ws-e/）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderLabelsPdf, type LabelItem } from '../src/index.ts';

const DIRS = ['/workspace/wms3d-artifacts/labels', '/workspace/wms3d-artifacts/ws-e'];

function loc(code: string): LabelItem {
  return {
    kind: 'LOCATION',
    code,
    payload: `WH1.${code}`,
    subtitle: '一号仓库',
  };
}

const a4Items: LabelItem[] = [];
for (let i = 0; i < 24; i++) {
  const aisle = String((i % 12) + 1).padStart(2, '0');
  const bay = String((i % 20) + 1).padStart(2, '0');
  const level = String.fromCharCode(65 + (i % 4));
  const pos = String((i % 3) + 1).padStart(2, '0');
  a4Items.push(loc(`A${aisle}-${bay}-${level}${pos}`));
}

const samples: {
  name: string;
  template: 'a4-3x8' | 'loc-100x50' | 'rack-100x150';
  items: LabelItem[];
}[] = [
  { name: 'a4-3x8-locations', template: 'a4-3x8', items: a4Items },
  { name: 'thermal-100x50-location', template: 'loc-100x50', items: [loc('A03-17-C02')] },
  {
    name: 'rack-100x150',
    template: 'rack-100x150',
    items: [{ kind: 'RACK', code: 'RA03-L02', payload: 'WH1.RA03-L02', subtitle: '一号仓库' }],
  },
];

for (const dir of DIRS) mkdirSync(dir, { recursive: true });

// 删除误把货架码印在 loc-100x50 上的旧样张
for (const dir of DIRS) {
  for (const stale of ['thermal-100x50-rack.pdf', 'thermal-100x50-rack.png']) {
    const f = join(dir, stale);
    if (existsSync(f)) unlinkSync(f);
  }
}

for (const s of samples) {
  const pdf = await renderLabelsPdf({ template: s.template, dpi: 203, items: s.items });
  for (const dir of DIRS) {
    const pdfPath = join(dir, `${s.name}.pdf`);
    writeFileSync(pdfPath, pdf);
    execFileSync(
      '/usr/bin/pdftoppm',
      ['-png', '-r', '120', '-f', '1', '-l', '1', pdfPath, join(dir, s.name)],
      { stdio: 'pipe' },
    );
    const ppm = join(dir, `${s.name}-1.png`);
    if (existsSync(ppm)) renameSync(ppm, join(dir, `${s.name}.png`));
  }
  console.log('wrote', s.name, pdf.byteLength, 'bytes');
}
