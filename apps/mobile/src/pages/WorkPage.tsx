import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ago,
  BigButton,
  CountdownBar,
  pauseCountdown,
  QtyPad,
  restartCountdown,
  startCountdown,
  useNow,
  type Countdown,
} from '@wms3d/ui';
import type { ScanEvent } from '@wms3d/scanner';
import { toEnqueue } from '../core/commit.ts';
import type { OutboxEntry } from '../core/outbox-types.ts';
import * as wf from '../core/workflow.ts';
import { useScanHandler } from '../app/hooks.ts';
import { getServices, useUi } from '../app/services.ts';
import { CameraView } from './CameraView.tsx';

const MODES: { mode: wf.Mode; label: string }[] = [
  { mode: 'PUTAWAY', label: '上架' },
  { mode: 'PICK', label: '出库' },
  { mode: 'TRANSFER', label: '移库' },
];

interface StockCache {
  locationId: string;
  at: number;
  bySku: Map<string, number>;
}

export function statusMark(e: OutboxEntry): { icon: string; cls: string; text: string } {
  switch (e.status) {
    case 'DONE':
      return { icon: '✔', cls: 'tick-green', text: '服务端已确认' };
    case 'REJECTED':
      return { icon: '✖', cls: 'tick-red', text: '被拒绝' };
    case 'CANCELLED':
      return { icon: '↺', cls: 'tick-cancel', text: '已撤销' };
    case 'WAITING_STOCK':
      return { icon: '✔', cls: 'tick-grey', text: '等待库存（自动重试）' };
    case 'BLOCKED_AUTH':
      return { icon: '✔', cls: 'tick-grey', text: '暂停：需重新登录' };
    default:
      return { icon: '✔', cls: 'tick-grey', text: '已落本机，待上传' };
  }
}

/** 作业页（04 §3.1–§3.3）：扫码驱动，无可编辑焦点；连续模式倒计时自动提交、撤销、打断式拒绝 */
export function WorkPage(props: { active: boolean }) {
  const svc = getServices();
  const settings = useUi((s) => s.settings);
  const session = useUi((s) => s.session);
  const online = useUi((s) => s.online);
  const entries = useUi((s) => s.entries);
  const mdReady = useUi((s) => s.mdReady);
  const rejects = useUi((s) => s.rejects);
  const [mode, setMode] = useState<wf.Mode>('PUTAWAY');
  const [st, setSt] = useState<wf.FlowState>(() => wf.initialState('PUTAWAY'));
  const stRef = useRef(st);
  const [hint, setHint] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [qtyOpen, setQtyOpen] = useState(false);
  const [camera, setCamera] = useState(false);
  const [lastCommit, setLastCommit] = useState<{ id: string; at: number } | null>(null);
  const [stock, setStock] = useState<StockCache | null>(null);
  const now = useNow(100);

  const update = (s: wf.FlowState) => {
    stRef.current = s;
    setSt(s);
  };

  const cachedOnHand = (locId: string | undefined, skuId: string | undefined) =>
    stock && locId === stock.locationId && skuId ? (stock.bySku.get(skuId) ?? 0) : undefined;
  const overStock =
    st.mode === 'PICK' && st.pending?.sku
      ? (() => {
          const c = cachedOnHand(st.location?.id, st.pending.sku.id);
          return c !== undefined && st.pending.qty > c;
        })()
      : false;

  const commit = useCallback(
    async (c: wf.CommitLine) => {
      const s = svc.session.current;
      if (!s) return;
      const e = await svc.outbox.enqueue(
        toEnqueue(c, {
          warehouseId: s.warehouseId,
          performedBy: s.user.id,
          performerSessionId: s.sessionId,
          online: useUi.getState().online,
        }),
      );
      setLastCommit({ id: e.id, at: Date.now() });
    },
    [svc],
  );

  const apply = useCallback(
    async (step: wf.Step) => {
      const prevPending = stRef.current.pending;
      update(step.state);
      for (const e of step.effects) {
        if (e.type === 'commit') await commit(e.commit);
        else if (e.type === 'hint') {
          setHint(e.message);
          void svc.feedback('warn');
        } else if (e.type === 'error')
          svc.pushReject({
            title: '扫码被拒绝',
            message: e.message,
            entryId: null,
            canAutoRetry: false,
          });
        else if (e.type === 'ok') void svc.feedback('ok');
      }
      // 待确认行变化 → 重新计时（连续模式；移库需扫目标仓位，不自动提交）
      if (step.state.phase !== 'PENDING' || !settings.continuous) setCountdown(null);
      else if (step.state.pending !== prevPending)
        setCountdown(startCountdown(settings.countdownMs, Date.now()));
    },
    [commit, settings.continuous, settings.countdownMs, svc],
  );

  useScanHandler(async (e: ScanEvent) => {
    if (!svc.md?.ready) return;
    setHint(null);
    let r;
    try {
      r = await svc.md.resolve(useUi.getState().online ? svc.api : null, e.text);
    } catch (err) {
      svc.pushReject({
        title: '解析失败',
        message: (err as Error).message,
        entryId: null,
        canAutoRetry: false,
      });
      return;
    }
    await apply(
      wf.onScan(stRef.current, r, e.source, { cameraAccumulate: settings.cameraAccumulate }),
    );
  }, props.active && !qtyOpen);

  // 出库：扫到仓位后取缓存在库（标注“x 分钟前”）
  useEffect(() => {
    const loc = st.location;
    const s = svc.session.current;
    if (st.mode !== 'PICK' || !loc || !s || stock?.locationId === loc.id) return;
    if (!useUi.getState().online) return;
    void svc.api.r
      .listBalances({ query: { warehouseId: s.warehouseId, locationId: loc.id, limit: 200 } })
      .then((p) =>
        setStock({
          locationId: loc.id,
          at: Date.now(),
          bySku: new Map(p.items.map((b) => [b.skuId, b.onHand])),
        }),
      )
      .catch(() => undefined);
  }, [st.mode, st.location, svc, stock?.locationId]);

  // 倒计时到 → 自动提交（出库超过缓存在库时暂停自动提交，必须手动确认）
  useEffect(() => {
    if (!countdown || countdown.pausedAt !== null || overStock || rejects.length > 0) return;
    const left = countdown.durationMs - (now - countdown.startedAt - countdown.pausedTotal);
    if (left <= 0) {
      setCountdown(null);
      void apply(wf.confirm(stRef.current));
    }
  }, [now, countdown, overStock, apply, rejects.length]);

  const switchMode = (m: wf.Mode) => {
    if (stRef.current.pending) void apply(wf.confirm(stRef.current));
    setMode(m);
    update(wf.initialState(m));
    setCountdown(null);
    setStock(null);
    setHint(null);
  };

  const openQty = () => {
    if (!st.pending) return;
    setQtyOpen(true);
    if (countdown) setCountdown(pauseCountdown(countdown, Date.now()));
  };

  const undo = async () => {
    if (!lastCommit) return;
    try {
      const r = await svc.outbox.undo(lastCommit.id);
      setHint(r === 'cancelled' ? '已撤销（未上传，已从队列作废）' : '已撤销（已提交冲正单）');
      setLastCommit(null);
    } catch (e) {
      svc.pushReject({
        title: '撤销失败',
        message: (e as Error).message,
        entryId: null,
        canAutoRetry: false,
      });
    }
  };

  if (!mdReady)
    return (
      <div className="page-pad" data-testid="work-blocked">
        首次主数据同步完成前不能作业（离线作业需要本地主数据）。
      </div>
    );

  const myRecent = entries
    .filter((e) => e.operatorUserId === session?.user.id)
    .slice(-6)
    .reverse();
  const undoVisible = lastCommit && now - lastCommit.at < 10_000;
  const pend = st.pending;

  return (
    <div className={`work ${camera ? 'work-camera' : ''}`} data-testid="work-page">
      {camera ? (
        <CameraView onClose={() => setCamera(false)} />
      ) : (
        <div className="mode-tabs" role="tablist">
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="tab"
              aria-selected={mode === m.mode}
              className={`mode-tab ${mode === m.mode ? 'mode-tab-on' : ''}`}
              data-testid={`mode-${m.mode}`}
              onClick={() => switchMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      <div className="work-panel">
        <div className="prompt" data-testid="prompt">
          {wf.prompt(st)}
        </div>
        {!online && (
          <div className="offline-note" data-testid="offline-note">
            离线作业：单据先存本机，联网后自动上传
            {mode === 'PICK' ? '（离线出库，联网后校验）' : ''}
          </div>
        )}
        <div className="loc-line">
          <span className="loc-label">{mode === 'TRANSFER' ? '源仓位' : '仓位'}</span>
          <span className="loc-code" data-testid="current-location">
            {st.location?.code ?? '—'}
          </span>
        </div>
        {pend && (
          <div className="pending-card" data-testid="pending-line">
            <div className="pending-sku">
              {pend.sku
                ? `${pend.sku.code} ${pend.sku.name}`
                : `未识别条码 ${pend.rawBarcode}（离线暂存）`}
            </div>
            <div className="pending-qty">
              数量 <b data-testid="pending-qty">{pend.qty}</b>
              {pend.packQty > 1 ? `（每次 +${pend.packQty}）` : ''}
            </div>
            {mode === 'PICK' && pend.sku && stock && stock.locationId === st.location?.id && (
              <div className={overStock ? 'stock-warn' : 'stock-info'} data-testid="cached-stock">
                缓存在库 {cachedOnHand(st.location?.id, pend.sku.id)}（{ago(stock.at, now)}）
                {overStock ? ' · 超过在库，已暂停自动提交，请确认' : ''}
              </div>
            )}
            {mode !== 'TRANSFER' && !overStock && <CountdownBar countdown={countdown} now={now} />}
            <div className="ui-row">
              <BigButton testId="btn-qty" onClick={openQty}>
                数量
              </BigButton>
              {mode !== 'TRANSFER' && (
                <BigButton
                  kind="primary"
                  testId="btn-confirm"
                  onClick={() => void apply(wf.confirm(st))}
                >
                  确认
                </BigButton>
              )}
              <BigButton
                kind="danger"
                testId="btn-cancel-line"
                onClick={() => {
                  update(wf.cancelPending(st));
                  setCountdown(null);
                }}
              >
                放弃
              </BigButton>
            </div>
          </div>
        )}
        {hint && (
          <div className="hint" data-testid="hint">
            {hint}
          </div>
        )}
        <div className="ui-row">
          {undoVisible && (
            <BigButton kind="danger" testId="btn-undo" onClick={() => void undo()}>
              撤销上一笔
            </BigButton>
          )}
          {!camera && (
            <BigButton testId="btn-camera" onClick={() => setCamera(true)}>
              相机扫码
            </BigButton>
          )}
          <BigButton
            testId="btn-reset"
            onClick={async () => {
              if (stRef.current.pending) await apply(wf.confirm(stRef.current));
              update(wf.initialState(mode));
              setCountdown(null);
            }}
          >
            {mode === 'TRANSFER' ? '换源仓位' : '换仓位'}
          </BigButton>
        </div>
        <ul className="recent" data-testid="recent">
          {myRecent.map((e) => {
            const m = statusMark(e);
            return (
              <li
                key={e.id}
                className="recent-item"
                data-status={e.status}
                data-testid="recent-item"
              >
                <span className={`tick ${m.cls}`} title={m.text}>
                  {m.icon}
                </span>
                <span className="recent-label">{e.label}</span>
                {e.mayBeAffected && <span className="badge-warn">可能受影响</span>}
              </li>
            );
          })}
        </ul>
      </div>
      {qtyOpen && pend && (
        <QtyPad
          initial={pend.qty}
          hint={pend.source === 'CAMERA' ? '相机来源：扫一次 + 数量键盘' : undefined}
          onCancel={() => {
            setQtyOpen(false);
            if (countdown) setCountdown(restartCountdown(countdown, Date.now()));
          }}
          onOk={(q) => {
            setQtyOpen(false);
            update(wf.setQty(stRef.current, q));
            if (countdown) setCountdown(restartCountdown(countdown, Date.now()));
          }}
        />
      )}
    </div>
  );
}
