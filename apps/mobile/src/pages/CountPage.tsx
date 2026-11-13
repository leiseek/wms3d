import { useCallback, useEffect, useMemo, useState } from 'react';
import { newIdempotencyKey } from '@wms3d/api-client';
import type { CountTask } from '@wms3d/contracts';
import { BigButton, QtyPad } from '@wms3d/ui';
import { useScanHandler } from '../app/hooks.ts';
import { getServices, useUi } from '../app/services.ts';
import { locationRefs, ACTIVE_STATUSES } from '../core/outbox-types.ts';

interface Line {
  skuId: string;
  skuCode: string;
  name: string;
  qty: number;
}

export function CountPage(props: { active: boolean; onBack(): void }) {
  const svc = getServices();
  const session = useUi((s) => s.session);
  const whId = session?.warehouseId;
  const [tasks, setTasks] = useState<CountTask[]>([]);
  const [task, setTask] = useState<CountTask | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loc, setLoc] = useState<{ id: string; code: string } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!whId) return;
    try {
      const r = await svc.api.r.listCounts({ query: { warehouseId: whId, limit: 50 } });
      setTasks(r.items.filter((t) => t.status === 'OPEN' || t.status === 'COUNTING'));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [svc, whId]);

  useEffect(() => {
    if (props.active) void load();
  }, [props.active, load]);

  useScanHandler(async (e) => {
    const raw = e.text.trim();
    if (!svc.md) return;
    const r = svc.md.resolveLocal(raw);
    if (!task) {
      setMsg('请先选择盘点任务');
      return;
    }
    if (task.status !== 'COUNTING') {
      setMsg('任务尚未开始，请主管在后台点击「开始」');
      return;
    }
    if (r.kind === 'LOCATION') {
      if (!r.loc.isActive) {
        setErr(`仓位已停用：${r.loc.code}`);
        return;
      }
      const pending = (await svc.outbox.list()).filter(
        (x) =>
          (ACTIVE_STATUSES as readonly string[]).includes(x.status) &&
          locationRefs(x.payload).some(
            (ref) => ref === r.loc.id || ref === r.loc.code || ref === raw,
          ),
      );
      if (pending.length) {
        setErr('本仓位有待传单据，请先同步后再盘点');
        return;
      }
      setLoc({ id: r.loc.id, code: r.loc.code });
      setLines([]);
      setErr(null);
      setMsg(`已选仓位 ${r.loc.code}，请扫 SKU`);
      return;
    }
    if (!loc) {
      setMsg('请先扫仓位');
      return;
    }
    if (r.kind === 'SKU') {
      setLines((cur) => {
        const i = cur.findIndex((l) => l.skuId === r.sku.id);
        if (i >= 0) {
          const next = cur.slice();
          next[i] = { ...next[i]!, qty: next[i]!.qty + r.packQty };
          return next;
        }
        return [...cur, { skuId: r.sku.id, skuCode: r.sku.code, name: r.sku.name, qty: r.packQty }];
      });
      setMsg(null);
      return;
    }
    if (r.kind === 'WRONG_WAREHOUSE') {
      setErr(`不是本仓库的条码：${raw}`);
      return;
    }
    setErr(`无法识别：${raw}`);
  }, props.active);

  const setQty = (skuId: string, qty: number) =>
    setLines((cur) => cur.map((l) => (l.skuId === skuId ? { ...l, qty: Math.max(0, qty) } : l)));

  const submit = async () => {
    if (!task || !loc) return;
    setBusy(true);
    try {
      await svc.api.r.submitCount({
        params: { id: task.id },
        body: {
          submissionId: newIdempotencyKey(),
          locationId: loc.id,
          clientCountedAt: new Date().toISOString(),
          lines: lines.map((l) => ({ skuId: l.skuId, countedQty: l.qty })),
        },
      });
      setDone((d) => (d.includes(loc.code) ? d : [...d, loc.code]));
      setMsg(`${loc.code} 已提交（未列出的 SKU 计 0）`);
      setLoc(null);
      setLines([]);
      setErr(null);
      const t = await svc.api.r.getCount({ params: { id: task.id } });
      setTask(t);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = useMemo(() => {
    if (!task) return '选择盘点任务';
    return `${task.code} · ${task.progress.locationsSubmitted}/${task.progress.locationsTotal}`;
  }, [task]);

  return (
    <div className="page-pad" data-testid="count-page">
      <div className="ui-row wrap">
        <BigButton
          testId="count-back"
          onClick={
            task
              ? () => {
                  setTask(null);
                  setLoc(null);
                  setLines([]);
                }
              : props.onBack
          }
        >
          返回
        </BigButton>
        <h2 style={{ margin: 0, flex: 1 }}>{title}</h2>
      </div>
      {err && (
        <div className="hint" data-testid="count-error">
          {err}
        </div>
      )}
      {msg && (
        <div className="muted" data-testid="count-msg">
          {msg}
        </div>
      )}
      {!task && (
        <div data-testid="count-task-list">
          {tasks.length === 0 && <p className="muted">没有进行中的盘点任务</p>}
          {tasks.map((t) => (
            <BigButton key={t.id} testId={`count-task-${t.code}`} onClick={() => setTask(t)}>
              {t.code} {t.blind ? '盲盘' : ''} {t.status} · {t.progress.locationsSubmitted}/
              {t.progress.locationsTotal}
            </BigButton>
          ))}
        </div>
      )}
      {task && (
        <>
          <p className="muted">
            {task.blind ? '盲盘：不显示系统库存' : '明盘'}。扫仓位后扫 SKU
            计数，点「本仓位完成」提交。
          </p>
          <div data-testid="count-location">当前仓位：{loc?.code ?? '请扫仓位'}</div>
          {done.length > 0 && <div className="muted">已交：{done.join('、')}</div>}
          {loc && (
            <>
              <ul data-testid="count-lines">
                {lines.map((l) => (
                  <li key={l.skuId}>
                    {l.skuCode} {l.name} ×{l.qty}{' '}
                    <button type="button" onClick={() => setEdit(l.skuId)}>
                      改数量
                    </button>
                  </li>
                ))}
              </ul>
              {edit && (
                <QtyPad
                  initial={lines.find((l) => l.skuId === edit)?.qty ?? 0}
                  onOk={(n) => {
                    setQty(edit, n);
                    setEdit(null);
                  }}
                  onCancel={() => setEdit(null)}
                  hint="输入实盘数量"
                />
              )}
              <BigButton
                testId="count-submit"
                kind="primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                本仓位完成
              </BigButton>
            </>
          )}
        </>
      )}
    </div>
  );
}
