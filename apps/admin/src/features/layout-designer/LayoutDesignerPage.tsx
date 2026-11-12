import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ApiClient } from '@wms3d/api-client';
import type {
  LayoutDoc,
  LayoutRack,
  LayoutVersion,
  RackTypeSpec,
  RotationDeg,
  Warehouse,
} from '@wms3d/contracts';
import { compilePattern, deriveSide, rackCode, validateLayout, zoneAt } from '@wms3d/domain';
import { DesignerCanvas, type CanvasHandle, type Tool } from './components/DesignerCanvas';
import { PropertiesPanel, type PropertiesActions } from './components/PropertiesPanel';
import { ValidationPanel } from './components/ValidationPanel';
import { PublishDialog, type PublishPhase } from './components/PublishDialog';
import { ConflictDialog } from './components/ConflictDialog';
import { ElevationView } from './components/ElevationView';
import { RackTypePicker } from './components/RackTypePicker';
import { createDesignerStore, type DesignerStore } from './model/history';
import { DraftSync, type SaveState } from './model/draftSync';
import {
  describePublishError,
  isPreconditionFailed,
  layoutApi,
  type LayoutApi,
} from './model/layoutApi';
import * as ops from './model/ops';

const TwinPreview = lazy(() => import('./components/TwinPreview'));

export interface LayoutDesignerPageProps {
  /** 已登录的 api-client（WS-B 的会话） */
  api: ApiClient;
  warehouseId: string;
  /** ADMIN 才能发布（03 routes：publishLayout roles=ADMIN）；默认 true，服务端仍做权威校验 */
  canPublish?: boolean;
  /** MANAGER 及以上可编辑草稿；默认 true */
  canEdit?: boolean;
  /** 整页高度，默认 calc(100vh - 64px) */
  height?: number | string;
  /** 在 window.__wmsLayoutDesigner 暴露测试句柄（Playwright 坐标断言用） */
  exposeTestHandle?: boolean;
}

interface Loaded {
  warehouse: Warehouse;
  library: RackTypeSpec[];
  published: LayoutVersion | null;
  draft: LayoutVersion | null;
}

const MIN_AISLE_M = 1.2;

/**
 * 布局设计器（05 §2）。对外唯一导出（经 index.tsx），由 WS-B 挂到 `/layout`：
 * `<LayoutDesignerPage api={api} warehouseId={id} canPublish={me.role === 'ADMIN'} />`
 */
export function LayoutDesignerPage(props: LayoutDesignerPageProps) {
  return (
    <AntApp>
      <DesignerRoot {...props} />
    </AntApp>
  );
}

function DesignerRoot(props: LayoutDesignerPageProps) {
  const la = useMemo(() => layoutApi(props.api, props.warehouseId), [props.api, props.warehouseId]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let off = false;
    setError(null);
    (async () => {
      const warehouse = await la.warehouse();
      const [lib, draft, published] = await Promise.all([
        la
          .rackTypes()
          .then((r) => r.items as RackTypeSpec[])
          .catch(() => [] as RackTypeSpec[]),
        la.draft(),
        warehouse.publishedLayoutVersion
          ? la.get('published').catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!off)
        setLoaded({
          warehouse,
          library: lib.map(({ id: _id, ...t }: RackTypeSpec & { id?: string }) => t),
          draft,
          published,
        });
    })().catch((e: unknown) => !off && setError((e as Error).message));
    return () => {
      off = true;
    };
  }, [la, nonce]);

  const height = props.height ?? 'calc(100vh - 64px)';
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        title="加载布局失败"
        description={error}
        action={<Button onClick={reload}>重试</Button>}
      />
    );
  if (!loaded) return <Spin style={{ margin: 48 }} />;
  if (!loaded.draft)
    return <NoDraft la={la} loaded={loaded} canEdit={props.canEdit ?? true} onCreated={reload} />;
  return (
    <Editor
      key={`${loaded.draft.id}:${nonce}`}
      la={la}
      loaded={loaded as Loaded & { draft: LayoutVersion }}
      height={height}
      canPublish={props.canPublish ?? true}
      canEdit={props.canEdit ?? true}
      exposeTestHandle={!!props.exposeTestHandle}
      reload={reload}
    />
  );
}

function NoDraft({
  la,
  loaded,
  canEdit,
  onCreated,
}: {
  la: LayoutApi;
  loaded: Loaded;
  canEdit: boolean;
  onCreated(): void;
}) {
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);
  const create = async (base: number | null) => {
    setBusy(true);
    try {
      await la.createDraft(base);
      onCreated();
    } catch (e) {
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const v = loaded.warehouse.publishedLayoutVersion;
  return (
    <Card
      title={`布局设计器 · ${loaded.warehouse.code} ${loaded.warehouse.name}`}
      data-testid="no-draft"
    >
      <Empty
        description={
          v
            ? `当前已发布 v${v}（${loaded.published?.doc.racks.length ?? 0} 个货架），没有草稿`
            : '仓库还没有布局'
        }
      >
        <Space>
          {v && (
            <Button
              type="primary"
              loading={busy}
              disabled={!canEdit}
              onClick={() => void create(v)}
              data-testid="create-draft"
            >
              基于 v{v} 创建草稿
            </Button>
          )}
          <Button
            loading={busy}
            disabled={!canEdit}
            onClick={() => void create(null)}
            data-testid="create-blank-draft"
          >
            空白草稿
          </Button>
        </Space>
      </Empty>
    </Card>
  );
}

function useCanvasSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setSize({
        width: Math.max(200, Math.floor(r.width)),
        height: Math.max(200, Math.floor(r.height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

function Editor(p: {
  la: LayoutApi;
  loaded: Loaded & { draft: LayoutVersion };
  height: number | string;
  canPublish: boolean;
  canEdit: boolean;
  exposeTestHandle: boolean;
  reload(): void;
}) {
  const { la, loaded } = p;
  const { message, modal } = AntApp.useApp();
  const pattern = loaded.warehouse.locationCodePattern;
  const storeRef = useRef<DesignerStore | null>(null);
  storeRef.current ??= createDesignerStore(loaded.draft.doc);
  const store = storeRef.current;
  const doc = useStore(store, (s) => s.doc);
  const selection = useStore(store, (s) => s.selection);
  const canUndo = useStore(store, (s) => s.past.length > 0);
  const canRedo = useStore(store, (s) => s.future.length > 0);
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  const syncRef = useRef<DraftSync | null>(null);
  syncRef.current ??= new DraftSync(loaded.draft, {
    save: la.saveDraft,
    fetchDraft: () => la.get('draft'),
    isPreconditionFailed,
    onState: setSave,
  });
  const sync = syncRef.current;
  useEffect(() => () => sync.dispose(), [sync]);
  useEffect(() => sync.touch(doc), [doc, sync]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (sync.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [sync]);

  const [tool, setTool] = useState<Tool>('select');
  const [library, setLibrary] = useState(loaded.library);
  const [placing, setPlacing] = useState<RackTypeSpec | null>(
    loaded.draft.doc.rackTypes[0] ?? loaded.library[0] ?? null,
  );
  const [placeRot, setPlaceRot] = useState<RotationDeg>(0);
  const [show3d, setShow3d] = useState(false);
  const [publish, setPublish] = useState<PublishPhase>({ phase: 'closed' });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [floorPts, setFloorPts] = useState<Array<[number, number]> | null>(null);
  const canvasHandle = useRef<CanvasHandle | null>(null);
  const { ref: canvasBox, size } = useCanvasSize();

  const issues = useMemo(
    () =>
      validateLayout(doc, {
        pattern,
        maxCodeLength: safeMaxLen(pattern),
        minAisleWidthM: MIN_AISLE_M,
      }),
    [doc, pattern],
  );
  const errorCount = issues.filter((i) => i.severity === 'ERROR').length;
  const exec = store.getState().exec;
  const ro = !p.canEdit;

  const publishedCodes = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of loaded.published?.doc.racks ?? [])
      try {
        m.set(r.key, rackCode(r.zone, r.aisle, deriveSide(r.rotationDeg), r.rackNo));
      } catch {
        /* 忽略 */
      }
    return m;
  }, [loaded.published]);

  const actions: PropertiesActions = {
    patchRack: (key, patch) => exec('修改货架', (d) => ops.patchRack(d, key, patch)),
    rotate: (keys) => exec('旋转', (d) => keys.reduce((acc, k) => ops.rotateRack(acc, k), d)),
    remove: (keys) => exec('删除货架', (d) => ops.deleteRacks(d, keys), { kind: 'none' }),
    arrayCopy: (key, count, gap) => {
      try {
        const res = ops.arrayCopy(store.getState().doc, key, count, gap);
        exec(`阵列复制 ×${count}`, () => res.doc, { kind: 'racks', keys: [key, ...res.keys] });
      } catch (e) {
        void message.error((e as Error).message);
      }
    },
    renumber: (zone, aisle) => exec('巷道重新编号', (d) => ops.renumberAisle(d, zone, aisle)),
    patchZone: (code, patch) =>
      exec(
        '修改库区',
        (d) => ops.patchZone(d, code, patch),
        patch.code ? { kind: 'zone', code: patch.code } : undefined,
      ),
    removeZone: (code) => exec('删除库区', (d) => ops.deleteZone(d, code), { kind: 'none' }),
    removeFloor: (code) =>
      exec('删除地面区', (d) => ops.deleteFloorArea(d, code), { kind: 'none' }),
    patchWarehouse: (patch) =>
      exec('仓库尺寸', (d) => ({ ...d, warehouse: { ...d.warehouse, ...patch } })),
    setAisle: (keys, aisle) =>
      exec('批量设置巷道', (d) => keys.reduce((acc, k) => ops.patchRack(acc, k, { aisle }), d)),
  };

  // 键盘：R 旋转、Delete 删除、Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y、Esc 回到选择
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
        return;
      const st = store.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if (!mod && e.key.toLowerCase() === 'r') {
        if (tool === 'place') setPlaceRot((r) => ops.nextRotation(r));
        else if (st.selection.kind === 'racks' && !ro) actions.rotate(st.selection.keys);
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        st.selection.kind === 'racks' &&
        !ro
      ) {
        actions.remove(st.selection.keys);
      } else if (e.key === 'Escape') setTool('select');
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  useEffect(() => {
    if (!p.exposeTestHandle) return;
    const w = window as unknown as Record<string, unknown>;
    w.__wmsLayoutDesigner = {
      getDoc: () => store.getState().doc,
      exec: (label: string, fn: (d: LayoutDoc) => LayoutDoc) => store.getState().exec(label, fn),
      select: (keys: string[]) => store.getState().select({ kind: 'racks', keys }),
      canvas: () => canvasHandle.current,
      flush: () => sync.flush(),
      rowVersion: () => sync.rowVersion,
    };
    return () => {
      delete w.__wmsLayoutDesigner;
    };
  }, [p.exposeTestHandle, store, sync]);

  const onPolygon = (kind: 'zone' | 'floor', pts: Array<[number, number]>) => {
    if (kind === 'floor') return setFloorPts(pts);
    const code = ops.nextZoneCode(store.getState().doc);
    exec(
      '绘制库区',
      (d) =>
        ops.addZone(d, {
          code,
          kind: 'STORAGE',
          polygon: pts,
          color: ops.ZONE_COLORS[d.zones.length % ops.ZONE_COLORS.length],
        }),
      { kind: 'zone', code },
    );
    setTool('select');
  };

  const openPublish = async () => {
    setPublish({ phase: 'checking' });
    try {
      const ok = await sync.flush();
      if (!ok) return setPublish({ phase: 'closed' });
      const v = await la.validate();
      setPublish({ phase: 'review', v });
    } catch (e) {
      setPublish({ phase: 'failed', v: null, err: describePublishError(e) });
    }
  };
  const doPublish = async (confirmRecode: boolean) => {
    const v = publish.phase === 'review' || publish.phase === 'failed' ? publish.v : null;
    if (!v) return;
    setPublish({ phase: 'publishing', v });
    try {
      const res = await la.publish(sync.rowVersion, confirmRecode);
      setPublish({
        phase: 'done',
        version: res.layoutVersion,
        reprints: res.reprintRequestIds.length,
        diff: res.diff,
      });
    } catch (e) {
      setPublish({ phase: 'failed', v, err: describePublishError(e) });
    }
  };

  const discard = async () => {
    try {
      await la.deleteDraft();
      sync.dispose();
      p.reload();
    } catch (e) {
      void message.error((e as Error).message);
    }
  };

  const exportMine = (d: LayoutDoc) => {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `layout-${loaded.warehouse.code}-draft-mine-${new Date().toISOString().replace(/[:.]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const selRack: LayoutRack | null =
    selection.kind === 'racks' && selection.keys.length === 1
      ? (doc.racks.find((r) => r.key === selection.keys[0]) ?? null)
      : null;
  const selectedKeys = selection.kind === 'racks' ? selection.keys : [];

  return (
    <div
      style={{ height: p.height, display: 'flex', flexDirection: 'column', minHeight: 480 }}
      data-testid="layout-designer"
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '6px 8px',
          borderBottom: '1px solid #eee',
          flexWrap: 'wrap',
        }}
      >
        <Typography.Text strong>
          {loaded.warehouse.code} 布局草稿
          {loaded.draft.basedOnVersion ? `（基于 v${loaded.draft.basedOnVersion}）` : ''}
        </Typography.Text>
        <Segmented
          size="small"
          value={tool}
          onChange={(v) => setTool(v as Tool)}
          options={[
            { value: 'select', label: '选择' },
            { value: 'place', label: '放置货架', disabled: ro || !placing },
            { value: 'zone', label: '库区多边形', disabled: ro },
            { value: 'floor', label: '地面区', disabled: ro },
            { value: 'measure', label: '测距' },
          ]}
          data-testid="tools"
        />
        <RackTypePicker
          library={library}
          docTypes={doc.rackTypes}
          value={placing?.key ?? null}
          onChange={(_k, t) => {
            setPlacing(t);
            setTool('place');
          }}
          onCreate={
            p.canPublish
              ? async (t) => {
                  const saved = await la.createRackType(t);
                  const { id: _id, ...spec } = saved as RackTypeSpec & { id: string };
                  setLibrary((l) => [...l, spec]);
                  return spec;
                }
              : undefined
          }
        />
        {tool === 'place' && (
          <Tooltip title="R 键切换">
            <Tag data-testid="place-rotation">放置角度 {placeRot}°</Tag>
          </Tooltip>
        )}
        <Space.Compact>
          <Button
            size="small"
            disabled={!canUndo}
            onClick={() => store.getState().undo()}
            data-testid="undo"
          >
            撤销
          </Button>
          <Button
            size="small"
            disabled={!canRedo}
            onClick={() => store.getState().redo()}
            data-testid="redo"
          >
            重做
          </Button>
        </Space.Compact>
        <Button size="small" onClick={() => canvasHandle.current?.fit()}>
          适配视图
        </Button>
        <SaveBadge s={save} onRetry={() => void sync.flush()} />
        <div style={{ flex: 1 }} />
        <Space size={4}>
          <Switch size="small" checked={show3d} onChange={setShow3d} data-testid="toggle-3d" />
          <span style={{ fontSize: 12 }}>3D 预览</span>
        </Space>
        <Button size="small" onClick={() => setVersionsOpen(true)}>
          历史版本
        </Button>
        <Popconfirm
          title="丢弃草稿？未发布的修改全部丢失"
          onConfirm={() => void discard()}
          disabled={ro}
        >
          <Button size="small" danger disabled={ro}>
            丢弃草稿
          </Button>
        </Popconfirm>
        <Badge count={errorCount} size="small">
          <Button
            size="small"
            type="primary"
            disabled={ro}
            onClick={() => void openPublish()}
            data-testid="publish"
          >
            校验并发布
          </Button>
        </Badge>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div
              ref={canvasBox}
              style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}
            >
              <DesignerCanvas
                doc={doc}
                selection={selection}
                issues={issues}
                tool={ro && tool !== 'measure' ? 'select' : tool}
                placingType={placing}
                placingRotation={placeRot}
                width={size.width}
                height={size.height}
                handleRef={(h) => (canvasHandle.current = h)}
                onSelect={(s) => store.getState().select(s)}
                onMoveRacks={(keys, dx, dz) =>
                  !ro && exec('移动货架', (d) => ops.moveRacks(d, keys, dx, dz))
                }
                onPlace={(x, z) => {
                  if (!placing || ro) return;
                  const res = ops.placeRack(store.getState().doc, {
                    type: placing,
                    x,
                    z,
                    rotationDeg: placeRot,
                  });
                  exec('放置货架', () => res.doc, { kind: 'racks', keys: [res.key] });
                }}
                onPolygon={onPolygon}
              />
            </div>
            {show3d && (
              <div
                style={{ width: '42%', borderLeft: '1px solid #eee', position: 'relative' }}
                data-testid="twin-preview"
              >
                <Suspense fallback={<Spin style={{ margin: 24 }} />}>
                  <TwinPreview
                    doc={doc}
                    pattern={pattern}
                    warehouseId={loaded.warehouse.id}
                    warehouseCode={loaded.warehouse.code}
                    selectedRackKeys={selectedKeys}
                    onPickRack={(k) => store.getState().select({ kind: 'racks', keys: [k] })}
                  />
                </Suspense>
              </div>
            )}
          </div>
          {selRack && (
            <div
              style={{ borderTop: '1px solid #eee', padding: 8, maxHeight: 300, overflow: 'auto' }}
            >
              <ElevationView
                doc={doc}
                rack={selRack}
                pattern={pattern}
                publishedRackCode={publishedRackCodeFor(selRack, publishedCodes)}
                api={la}
                canEdit={p.canEdit}
              />
            </div>
          )}
        </div>
        <div
          style={{
            width: 340,
            borderLeft: '1px solid #eee',
            padding: 10,
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <PropertiesPanel
            doc={doc}
            selection={selection}
            pattern={pattern}
            actions={actions}
            readOnly={ro}
          />
          <ValidationPanel
            issues={issues}
            onPick={(keys) => store.getState().select({ kind: 'racks', keys })}
          />
        </div>
      </div>
      <PublishDialog
        key={publish.phase === 'closed' ? 'c' : 'o'}
        state={publish}
        canPublish={p.canPublish}
        onPublish={(c) => void doPublish(c)}
        onClose={() => {
          const done = publish.phase === 'done';
          setPublish({ phase: 'closed' });
          if (done) p.reload();
        }}
      />
      {save.status === 'conflict' && (
        <ConflictDialog
          conflict={save.conflict}
          onKeepMine={() => void sync.keepMine(save.conflict.server)}
          onAdoptServer={() => store.getState().reset(sync.adoptServer(save.conflict.server))}
          onExportAndReload={() => {
            exportMine(save.conflict.mine);
            store.getState().reset(sync.adoptServer(save.conflict.server));
          }}
        />
      )}
      <FloorAreaModal
        pts={floorPts}
        doc={doc}
        onCancel={() => setFloorPts(null)}
        onOk={(zone, code) => {
          const pts = floorPts!;
          setFloorPts(null);
          exec('地面区', (d) => ops.addFloorArea(d, { zone, locationCode: code, polygon: pts }), {
            kind: 'floor',
            code,
          });
          setTool('select');
        }}
      />
      <VersionsDrawer
        open={versionsOpen}
        la={la}
        onClose={() => setVersionsOpen(false)}
        onRebase={(v) =>
          modal.confirm({
            title: `基于 v${v} 重新创建草稿？`,
            content: '当前草稿会被丢弃（回滚）。',
            onOk: async () => {
              await la.deleteDraft();
              await la.createDraft(v);
              sync.dispose();
              setVersionsOpen(false);
              p.reload();
            },
          })
        }
      />
    </div>
  );
}

function publishedRackCodeFor(r: LayoutRack, published: Map<string, string>): string | null {
  const code = published.get(r.key);
  if (!code) return null;
  try {
    return rackCode(r.zone, r.aisle, deriveSide(r.rotationDeg), r.rackNo) === code ? code : null;
  } catch {
    return null;
  }
}

function safeMaxLen(pattern: string): number | undefined {
  try {
    return compilePattern(pattern).maxLength;
  } catch {
    return undefined;
  }
}

function SaveBadge({ s, onRetry }: { s: SaveState; onRetry(): void }) {
  const map: Record<SaveState['status'], [string, string]> = {
    idle: ['default', '已同步'],
    dirty: ['processing', '有未保存修改（空闲 2 秒自动保存）'],
    saving: ['processing', '保存中…'],
    saved: ['success', '已保存'],
    conflict: ['warning', '保存冲突'],
    error: ['error', '保存失败'],
  };
  const [status, text] = map[s.status];
  return (
    <span data-testid="save-status" data-status={s.status}>
      <Badge status={status as 'default'} text={<span style={{ fontSize: 12 }}>{text}</span>} />
      {s.status === 'error' && (
        <Button size="small" type="link" onClick={onRetry}>
          重试
        </Button>
      )}
    </span>
  );
}

function FloorAreaModal(p: {
  pts: Array<[number, number]> | null;
  doc: LayoutDoc;
  onOk(zone: string, code: string): void;
  onCancel(): void;
}) {
  const [form] = Form.useForm();
  const open = !!p.pts;
  useEffect(() => {
    if (!p.pts) return;
    const cx = p.pts.reduce((a, q) => a + q[0], 0) / p.pts.length;
    const cz = p.pts.reduce((a, q) => a + q[1], 0) / p.pts.length;
    const zone =
      zoneAt({ ...p.doc, zones: p.doc.zones.filter((z) => z.kind !== 'STORAGE') }, [cx, cz]) ??
      p.doc.zones.find((z) => z.kind !== 'STORAGE')?.code;
    form.setFieldsValue({
      zone,
      code: zone
        ? `${zone}-${String(p.doc.floorAreas.filter((f) => f.zone === zone).length + 1).padStart(2, '0')}`
        : '',
    });
  }, [p.pts, p.doc, form]);
  return (
    <Modal
      open={open}
      title="新地面功能区（收货/发货/质检）"
      onCancel={p.onCancel}
      onOk={() => void form.validateFields().then((v) => p.onOk(v.zone, v.code))}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="zone" label="所属库区" rules={[{ required: true }]}>
          <Select
            options={p.doc.zones.map((z) => ({ value: z.code, label: `${z.code}（${z.kind}）` }))}
          />
        </Form.Item>
        <Form.Item
          name="code"
          label="仓位码"
          rules={[
            { required: true, pattern: /^[A-Z0-9-]{1,32}$/, message: '大写字母/数字/-，如 RCV-02' },
          ]}
        >
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function VersionsDrawer(p: {
  open: boolean;
  la: LayoutApi;
  onClose(): void;
  onRebase(v: number): void;
}) {
  const [items, setItems] = useState<Array<Omit<LayoutVersion, 'doc'>>>([]);
  useEffect(() => {
    if (p.open)
      void p.la.versions().then((r) => setItems(r.items as Array<Omit<LayoutVersion, 'doc'>>));
  }, [p.open, p.la]);
  return (
    <Drawer open={p.open} onClose={p.onClose} title="布局版本历史" size={560}>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={items}
        columns={[
          {
            title: '版本',
            dataIndex: 'version',
            render: (v: number | null) => (v ? `v${v}` : '草稿'),
          },
          { title: '状态', dataIndex: 'status', render: (s: string) => <Tag>{s}</Tag> },
          {
            title: '发布时间',
            dataIndex: 'publishedAt',
            render: (t: string | null) => (t ? new Date(t).toLocaleString('zh-CN') : '—'),
          },
          {
            title: '',
            render: (_: unknown, r) =>
              r.version ? (
                <Button size="small" onClick={() => p.onRebase(r.version!)}>
                  基于此版本创建草稿
                </Button>
              ) : null,
          },
        ]}
      />
    </Drawer>
  );
}
