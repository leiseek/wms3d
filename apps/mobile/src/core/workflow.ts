import { DEDUPE, type ScanSource } from '@wms3d/scanner';
import type { Resolved } from './masterdata.ts';

/**
 * 扫码驱动作业状态机（docs/04-mobile.md §3.1–§3.3、§3.7 意外码表）。纯函数，组件测试覆盖。
 * UI 负责倒计时（连续模式）、反馈音、打断遮罩与入队。
 */
export type Mode = 'PUTAWAY' | 'PICK' | 'TRANSFER';
export type Phase = 'WAIT_LOC' | 'WAIT_SKU' | 'PENDING' | 'WAIT_TARGET';

export interface Loc {
  id: string;
  code: string;
}
export interface PendingLine {
  sku: { id: string; code: string; name: string } | null;
  /** 离线未知条码：暂存原文（skuBarcode），联网后由服务端解析 */
  rawBarcode: string | null;
  packQty: number;
  /** 件数（基本单位）= 扫码次数 × packQty，或数量键盘输入 */
  qty: number;
  source: ScanSource;
}

export interface FlowState {
  mode: Mode;
  phase: Phase;
  /** 上架/出库：当前仓位（粘滞）；移库：源仓位 */
  location: Loc | null;
  pending: PendingLine | null;
}

export interface CommitLine {
  mode: Mode;
  location: Loc;
  /** 移库目标 */
  target?: Loc;
  line: PendingLine;
}

export type Effect =
  | { type: 'ok' }
  | { type: 'hint'; message: string }
  /** 打断式错误（红色全屏 + 错误音），必须确认 */
  | { type: 'error'; code: string; message: string }
  | { type: 'commit'; commit: CommitLine };

export interface Step {
  state: FlowState;
  effects: Effect[];
}

export function initialState(mode: Mode): FlowState {
  return { mode, phase: 'WAIT_LOC', location: null, pending: null };
}

const HINT_RACK = '请扫仓位码，而不是货架码';
const err = (code: string, message: string): Effect => ({ type: 'error', code, message });
const wrongWh = (r: Extract<Resolved, { kind: 'WRONG_WAREHOUSE' }>) =>
  err('WRONG_WAREHOUSE', `不是本仓库的条码${r.other ? `（${r.other}）` : ''}：${r.raw}`);
const unknown = (raw: string) => err('UNKNOWN_BARCODE', `未知条码：${raw}`);
const inactive = (code: string) => err('LOCATION_INACTIVE', `仓位已停用：${code}`);

function commitOf(s: FlowState, target?: Loc): Effect[] {
  if (!s.location || !s.pending) return [];
  return [
    {
      type: 'commit',
      commit: {
        mode: s.mode,
        location: s.location,
        line: s.pending,
        ...(target ? { target } : {}),
      },
    },
  ];
}

function newPending(r: Extract<Resolved, { kind: 'SKU' }>, source: ScanSource): PendingLine {
  return { sku: r.sku, rawBarcode: null, packQty: r.packQty, qty: r.packQty, source };
}

export interface FlowOptions {
  /** 设置页：相机来源再扫同 SKU 也累加（默认关闭，用数量键盘；04 §2.4） */
  cameraAccumulate?: boolean;
}

/** 处理一次扫码 */
export function onScan(
  s: FlowState,
  r: Resolved,
  source: ScanSource,
  opts: FlowOptions = {},
): Step {
  return s.mode === 'TRANSFER' ? transfer(s, r, source) : moveFlow(s, r, source, opts);
}

function moveFlow(s: FlowState, r: Resolved, source: ScanSource, opts: FlowOptions): Step {
  const accumulates =
    source === 'CAMERA' ? !!opts.cameraAccumulate : DEDUPE[source].accumulateSameSku;
  const stay = (effects: Effect[]): Step => ({ state: s, effects });
  switch (s.phase) {
    case 'WAIT_LOC':
      switch (r.kind) {
        case 'LOCATION':
          if (!r.loc.isActive) return stay([inactive(r.loc.code)]);
          return {
            state: { ...s, phase: 'WAIT_SKU', location: r.loc, pending: null },
            effects: [{ type: 'ok' }],
          };
        case 'RACK':
          return stay([{ type: 'hint', message: HINT_RACK }]);
        case 'SKU':
          return stay([{ type: 'hint', message: '请先扫仓位' }]);
        case 'WRONG_WAREHOUSE':
          return stay([wrongWh(r)]);
        default:
          return stay([unknown(r.raw)]);
      }
    case 'WAIT_SKU':
      switch (r.kind) {
        case 'LOCATION':
          if (!r.loc.isActive) return stay([inactive(r.loc.code)]);
          return { state: { ...s, location: r.loc }, effects: [{ type: 'ok' }] };
        case 'RACK':
          return stay([{ type: 'hint', message: HINT_RACK }]);
        case 'SKU':
          return {
            state: { ...s, phase: 'PENDING', pending: newPending(r, source) },
            effects: [{ type: 'ok' }],
          };
        case 'WRONG_WAREHOUSE':
          return stay([wrongWh(r)]);
        default:
          if (r.offline)
            return {
              state: {
                ...s,
                phase: 'PENDING',
                pending: { sku: null, rawBarcode: r.raw.trim(), packQty: 1, qty: 1, source },
              },
              effects: [
                { type: 'hint', message: `离线：未识别条码已暂存原文 ${r.raw.trim()}，联网后校验` },
              ],
            };
          return stay([unknown(r.raw)]);
      }
    case 'PENDING': {
      const p = s.pending!;
      switch (r.kind) {
        case 'LOCATION': {
          const c = commitOf(s);
          if (!r.loc.isActive)
            return {
              state: { ...s, phase: 'WAIT_SKU', pending: null },
              effects: [...c, inactive(r.loc.code)],
            };
          return {
            state: { ...s, phase: 'WAIT_SKU', location: r.loc, pending: null },
            effects: [...c, { type: 'ok' }],
          };
        }
        case 'RACK':
          return stay([{ type: 'hint', message: HINT_RACK }]);
        case 'SKU': {
          if (p.sku?.id === r.sku.id) {
            if (!accumulates)
              return stay([{ type: 'hint', message: '相机扫码不累加数量，请用数量键盘' }]);
            return {
              state: { ...s, pending: { ...p, qty: p.qty + r.packQty, source } },
              effects: [{ type: 'ok' }],
            };
          }
          return {
            state: { ...s, pending: newPending(r, source) },
            effects: [...commitOf(s), { type: 'ok' }],
          };
        }
        case 'WRONG_WAREHOUSE':
          return stay([wrongWh(r)]);
        default:
          if (r.offline && p.rawBarcode === r.raw.trim() && accumulates)
            return {
              state: { ...s, pending: { ...p, qty: p.qty + 1 } },
              effects: [{ type: 'ok' }],
            };
          return stay([unknown(r.raw)]);
      }
    }
    default:
      return stay([]);
  }
}

function transfer(s: FlowState, r: Resolved, source: ScanSource): Step {
  const stay = (effects: Effect[]): Step => ({ state: s, effects });
  if (r.kind === 'WRONG_WAREHOUSE') return stay([wrongWh(r)]);
  if (r.kind === 'RACK') return stay([{ type: 'hint', message: HINT_RACK }]);
  if (r.kind === 'UNKNOWN') return stay([unknown(r.raw)]);
  switch (s.phase) {
    case 'WAIT_LOC':
    case 'WAIT_SKU':
      if (r.kind === 'LOCATION') {
        if (!r.loc.isActive) return stay([inactive(r.loc.code)]);
        return {
          state: { ...s, phase: 'WAIT_SKU', location: r.loc, pending: null },
          effects: [{ type: 'ok' }],
        };
      }
      if (s.phase === 'WAIT_LOC') return stay([{ type: 'hint', message: '请先扫源仓位' }]);
      return {
        state: { ...s, phase: 'WAIT_TARGET', pending: newPending(r, source) },
        effects: [{ type: 'ok' }],
      };
    case 'WAIT_TARGET':
      if (r.kind === 'SKU')
        return stay([{ type: 'hint', message: '请扫目标仓位（数量用数量键盘）' }]);
      if (!r.loc.isActive) return stay([inactive(r.loc.code)]);
      if (r.loc.id === s.location!.id)
        return stay([{ type: 'hint', message: '目标仓位不能与源仓位相同' }]);
      return {
        state: { ...s, phase: 'WAIT_SKU', pending: null },
        effects: [...commitOf(s, r.loc), { type: 'ok' }],
      };
    default:
      return stay([]);
  }
}

/** 连续模式倒计时到 / 点“确认”：提交待确认行（移库无倒计时，需扫目标） */
export function confirm(s: FlowState): Step {
  if (s.phase !== 'PENDING' || !s.pending) return { state: s, effects: [] };
  return { state: { ...s, phase: 'WAIT_SKU', pending: null }, effects: commitOf(s) };
}

/** 数量键盘输入（件数） */
export function setQty(s: FlowState, qty: number): FlowState {
  if (!s.pending || !Number.isInteger(qty) || qty <= 0) return s;
  return { ...s, pending: { ...s.pending, qty } };
}

/** 放弃待确认行 */
export function cancelPending(s: FlowState): FlowState {
  if (!s.pending) return s;
  return { ...s, phase: s.location ? 'WAIT_SKU' : 'WAIT_LOC', pending: null };
}

/** 换仓位/结束：清空 */
export function reset(s: FlowState): FlowState {
  return initialState(s.mode);
}

export function prompt(s: FlowState): string {
  if (s.mode === 'TRANSFER') {
    if (s.phase === 'WAIT_LOC') return '请扫源仓位';
    if (s.phase === 'WAIT_SKU') return `源仓位 ${s.location!.code}：请扫 SKU`;
    return `请扫目标仓位（从 ${s.location!.code} 移出）`;
  }
  if (s.phase === 'WAIT_LOC') return '请扫仓位';
  if (s.phase === 'WAIT_SKU') return `仓位 ${s.location!.code}：请扫 SKU`;
  return '再扫同 SKU 累加，或扫下一个码';
}
