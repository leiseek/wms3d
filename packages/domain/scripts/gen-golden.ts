import { writeFileSync } from 'node:fs';
import { computeGolden } from '../src/__fixtures__/golden.ts';

const out = new URL('../src/__fixtures__/geometry-golden.json', import.meta.url);
writeFileSync(out, JSON.stringify(computeGolden(), null, 2) + '\n');
console.log(`已生成 ${out.pathname}`);
