import { createStore, type StoreApi } from 'zustand/vanilla';
import type { LayoutDoc } from '@wms3d/contracts';

/** 设计器本地状态（Zustand，05 §1）：命令栈式撤销/重做（≥ 100 步，这里上限 200）。 */
export const HISTORY_LIMIT = 200;

export type Selection =
  | { kind: 'none' }
  | { kind: 'racks'; keys: string[] }
  | { kind: 'zone'; code: string }
  | { kind: 'floor'; code: string };

export interface DesignerState {
  doc: LayoutDoc;
  past: Array<{ label: string; doc: LayoutDoc }>;
  future: Array<{ label: string; doc: LayoutDoc }>;
  selection: Selection;
  /** 每次文档变化 +1（自动保存据此判断"有变化"） */
  revision: number;
  /** 执行一条命令；返回 null/同一对象表示无变化（不入栈） */
  exec(label: string, fn: (doc: LayoutDoc) => LayoutDoc | null, select?: Selection): void;
  undo(): void;
  redo(): void;
  select(s: Selection): void;
  /** 载入（服务器版本/新草稿）：清空历史 */
  reset(doc: LayoutDoc): void;
}

export type DesignerStore = StoreApi<DesignerState>;

export function createDesignerStore(doc: LayoutDoc): DesignerStore {
  return createStore<DesignerState>()((set, get) => ({
    doc,
    past: [],
    future: [],
    selection: { kind: 'none' },
    revision: 0,
    exec(label, fn, select) {
      const cur = get().doc;
      const next = fn(cur);
      if (!next || next === cur) {
        if (select) set({ selection: select });
        return;
      }
      const past = [...get().past, { label, doc: cur }];
      if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
      set({
        doc: next,
        past,
        future: [],
        revision: get().revision + 1,
        selection: select ?? pruneSelection(get().selection, next),
      });
    },
    undo() {
      const { past, future, doc: cur, revision, selection } = get();
      const prev = past[past.length - 1];
      if (!prev) return;
      set({
        doc: prev.doc,
        past: past.slice(0, -1),
        future: [{ label: prev.label, doc: cur }, ...future],
        revision: revision + 1,
        selection: pruneSelection(selection, prev.doc),
      });
    },
    redo() {
      const { past, future, doc: cur, revision, selection } = get();
      const nxt = future[0];
      if (!nxt) return;
      set({
        doc: nxt.doc,
        past: [...past, { label: nxt.label, doc: cur }],
        future: future.slice(1),
        revision: revision + 1,
        selection: pruneSelection(selection, nxt.doc),
      });
    },
    select(s) {
      set({ selection: s });
    },
    reset(d) {
      set({
        doc: d,
        past: [],
        future: [],
        selection: { kind: 'none' },
        revision: get().revision + 1,
      });
    },
  }));
}

function pruneSelection(s: Selection, doc: LayoutDoc): Selection {
  if (s.kind === 'racks') {
    const keys = s.keys.filter((k) => doc.racks.some((r) => r.key === k));
    return keys.length ? { kind: 'racks', keys } : { kind: 'none' };
  }
  if (s.kind === 'zone') return doc.zones.some((z) => z.code === s.code) ? s : { kind: 'none' };
  if (s.kind === 'floor')
    return doc.floorAreas.some((f) => f.locationCode === s.code) ? s : { kind: 'none' };
  return s;
}
