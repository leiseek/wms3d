/**
 * 仓位编码模式（02 §3.1，ADR-0008）。contract-v1 冻结：改动走契约请求。
 * 段：{Zone} {Zone:n} {Aisle:n} {Bay:n} {Level:A} {Level:n} {Pos:n} {Side}，字面量只允许 '-'。
 */
export interface LocationCodeParts {
  zone: string;
  aisle: number;
  bay: number;
  level: number; // 1 = A = 最底层
  position: number;
  side?: 'L' | 'R';
}

type Seg =
  | { k: 'lit'; v: string }
  | { k: 'zone'; n: number | null }
  | { k: 'aisle' | 'bay' | 'pos'; n: number }
  | { k: 'level'; alpha: boolean; n: number }
  | { k: 'side' };

export interface CompiledPattern {
  readonly source: string;
  readonly segments: readonly Seg[];
  readonly regex: RegExp;
  format(p: LocationCodeParts): string;
  parse(code: string): LocationCodeParts | null;
  /** 该模式下编码的最大长度（标签容量校验用） */
  readonly maxLength: number;
}

export class PatternError extends Error {}

export function levelLetter(level: number): string {
  if (!Number.isInteger(level) || level < 1 || level > 26)
    throw new RangeError(`level 超出 A–Z：${level}`);
  return String.fromCharCode(64 + level);
}

const pad = (v: number, n: number) => {
  const s = String(v);
  if (!Number.isInteger(v) || v < 0 || s.length > n) throw new RangeError(`数值 ${v} 超出 ${n} 位`);
  return s.padStart(n, '0');
};

export function compilePattern(source: string): CompiledPattern {
  const segs: Seg[] = [];
  const re = /\{(Zone|Aisle|Bay|Level|Pos|Side)(?::([A0-9]+))?\}|(-)/gy;
  let idx = 0;
  while (idx < source.length) {
    re.lastIndex = idx;
    const m = re.exec(source);
    if (!m) throw new PatternError(`无法解析模式（位置 ${idx}）：${source}`);
    idx = re.lastIndex;
    if (m[3]) {
      segs.push({ k: 'lit', v: '-' });
      continue;
    }
    const name = m[1]!;
    const arg = m[2];
    const num = (def: number) => {
      const n = arg === undefined ? def : Number(arg);
      if (!Number.isInteger(n) || n < 1 || n > 4) throw new PatternError(`${name} 位数必须 1–4`);
      return n;
    };
    if (name === 'Zone') segs.push({ k: 'zone', n: arg === undefined ? null : num(1) });
    else if (name === 'Aisle') segs.push({ k: 'aisle', n: num(2) });
    else if (name === 'Bay') segs.push({ k: 'bay', n: num(2) });
    else if (name === 'Pos') segs.push({ k: 'pos', n: num(2) });
    else if (name === 'Side') segs.push({ k: 'side' });
    else
      segs.push(
        arg === 'A' || arg === undefined
          ? { k: 'level', alpha: true, n: 1 }
          : { k: 'level', alpha: false, n: num(2) },
      );
  }
  for (const k of ['zone', 'aisle', 'bay', 'level', 'pos'] as const) {
    const c = segs.filter((s) => s.k === k).length;
    if (c !== 1) throw new PatternError(`模式必须且只能包含一个 ${k} 段：${source}`);
  }
  const reSrc = segs
    .map((s) => {
      switch (s.k) {
        case 'lit':
          return '-';
        case 'zone':
          return s.n === null ? '([A-Z])' : `([A-Z][A-Z0-9]{${s.n - 1}})`;
        case 'level':
          return s.alpha ? '([A-Z])' : `(\\d{${s.n}})`;
        case 'side':
          return '([LR])';
        default:
          return `(\\d{${s.n}})`;
      }
    })
    .join('');
  const regex = new RegExp(`^${reSrc}$`);
  const maxLength = segs.reduce(
    (acc, s) =>
      acc +
      (s.k === 'lit' || s.k === 'side'
        ? 1
        : s.k === 'zone'
          ? (s.n ?? 1)
          : s.k === 'level'
            ? s.alpha
              ? 1
              : s.n
            : s.n),
    0,
  );
  return {
    source,
    segments: segs,
    regex,
    maxLength,
    format(p) {
      return segs
        .map((s) => {
          switch (s.k) {
            case 'lit':
              return '-';
            case 'zone':
              if (
                !/^[A-Z][A-Z0-9]*$/.test(p.zone) ||
                (s.n === null ? p.zone.length !== 1 : p.zone.length !== s.n)
              )
                throw new RangeError(`库区编码 ${p.zone} 与模式不符`);
              return p.zone;
            case 'aisle':
              return pad(p.aisle, s.n);
            case 'bay':
              return pad(p.bay, s.n);
            case 'pos':
              return pad(p.position, s.n);
            case 'level':
              return s.alpha ? levelLetter(p.level) : pad(p.level, s.n);
            case 'side':
              if (!p.side) throw new RangeError('模式含 {Side}，缺少 side');
              return p.side;
          }
        })
        .join('');
    },
    parse(code) {
      const m = regex.exec(code);
      if (!m) return null;
      const out: LocationCodeParts = { zone: '', aisle: 0, bay: 0, level: 0, position: 0 };
      let g = 1;
      for (const s of segs) {
        if (s.k === 'lit') continue;
        const v = m[g++]!;
        if (s.k === 'zone') out.zone = v;
        else if (s.k === 'aisle') out.aisle = Number(v);
        else if (s.k === 'bay') out.bay = Number(v);
        else if (s.k === 'pos') out.position = Number(v);
        else if (s.k === 'level') out.level = s.alpha ? v.charCodeAt(0) - 64 : Number(v);
        else out.side = v as 'L' | 'R';
      }
      return out;
    },
  };
}

export const DEFAULT_PATTERN = '{Zone}{Aisle:2}-{Bay:2}-{Level:A}{Pos:2}';

/** 货架码 `R{Zone}{Aisle:2}-{Side}{RackNo:2}` → `RA03-L02`。 */
export function rackCode(zone: string, aisle: number, side: 'L' | 'R', rackNo: number): string {
  return `R${zone}${pad(aisle, 2)}-${side}${pad(rackNo, 2)}`;
}

/** 条码载荷（02 §3.2）。 */
export function toPayload(warehouseCode: string, code: string, prefixEnabled = true): string {
  return prefixEnabled ? `${warehouseCode}.${code}` : code;
}

/** 解析带前缀的载荷；不带前缀返回 null。 */
export function splitPayload(text: string): { warehouseCode: string; code: string } | null {
  const m = /^([A-Z0-9]{2,4})\.(.+)$/.exec(text);
  return m ? { warehouseCode: m[1]!, code: m[2]! } : null;
}
