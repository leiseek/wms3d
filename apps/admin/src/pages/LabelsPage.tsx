import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import type { LabelKind, LabelTemplateKey } from '@wms3d/contracts';
import { api } from '../api';
import { useMe, useWarehouseId } from '../session';
import { can } from '../lib/rbac';
import {
  CursorPager,
  fmtTime,
  PageHeader,
  useCursorPager,
  useNotifyError,
} from '../components/common';
import {
  buildRenderBody,
  KIND_LABELS,
  loadOffset,
  MAX_LABELS_PER_JOB,
  perSheet,
  pickTemplate,
  saveOffset,
  templatesFor,
  type OffsetMm,
} from '../lib/labels';
import { downloadBlob } from '../lib/download';

type Sel = Map<string, string>; // id → code

function useObjects(kind: LabelKind, warehouseId: string) {
  const pager = useCursorPager();
  const [q, setQ] = useState<{ zone?: string; rack?: string; q?: string }>({});
  const locs = useQuery({
    queryKey: ['locations', warehouseId, 'labels', q, pager.cursor],
    queryFn: () =>
      api.r.listLocations({
        params: { id: warehouseId },
        query: { ...q, isActive: 'true', limit: 200, cursor: pager.cursor },
      }),
    enabled: kind === 'LOCATION',
  });
  const racks = useQuery({
    queryKey: ['racks', warehouseId],
    queryFn: () => api.r.listRacks({ params: { id: warehouseId } }),
    enabled: kind === 'RACK',
  });
  const skus = useQuery({
    queryKey: ['skus', 'labels', q.q, pager.cursor],
    queryFn: () =>
      api.r.listSkus({ query: { q: q.q, limit: 200, cursor: pager.cursor, isActive: 'true' } }),
    enabled: kind === 'SKU',
  });
  const rows: { id: string; code: string; desc: string }[] =
    kind === 'LOCATION'
      ? (locs.data?.items ?? []).map((l) => ({ id: l.id, code: l.code, desc: l.payload }))
      : kind === 'RACK'
        ? (racks.data?.items ?? [])
            .filter((r) => r.isActive && (!q.q || r.code.includes(q.q.toUpperCase())))
            .map((r) => ({
              id: r.id,
              code: r.code,
              desc: `巷道 ${r.aisle} · ${r.rackType.name ?? r.rackType.key}`,
            }))
        : (skus.data?.items ?? []).map((s) => ({ id: s.id, code: s.code, desc: s.name }));
  const next =
    kind === 'LOCATION' ? locs.data?.nextCursor : kind === 'SKU' ? skus.data?.nextCursor : null;
  const loading = locs.isLoading || racks.isLoading || skus.isLoading;
  return { rows, next, pager, setQ, loading };
}

function PrintGuide() {
  return (
    <Alert
      type="warning"
      showIcon
      data-testid="print-guide"
      title="打印前请确认"
      description={
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            缩放选择 <b>“实际大小 / 100%”</b>，<b>关闭“适合纸张 / 缩放以适合”</b>。
          </li>
          <li>纸张选择与模板一致的自定义尺寸（如 100×50mm）；A4 模板选 A4。</li>
          <li>
            首次使用或换纸后先打印一张<b>校准页</b>，量 10mm 刻度尺，偏差用下方“偏移”修正。
          </li>
          <li>TSC / 佳博 / 斑马驱动需在“首选项 → 纸张”里新建自定义尺寸。</li>
        </ol>
      }
    />
  );
}

function ReprintQueue({
  warehouseId,
  onPrint,
}: {
  warehouseId: string;
  onPrint(kind: LabelKind, rows: { id: string; entityId: string; code: string }[]): void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const notify = useNotifyError();
  const pager = useCursorPager();
  const [status, setStatus] = useState<'PENDING' | 'DONE' | 'CANCELLED'>('PENDING');
  const [selected, setSelected] = useState<string[]>([]);
  const list = useQuery({
    queryKey: ['reprints', warehouseId, status, pager.cursor],
    queryFn: () =>
      api.r.listReprints({ query: { warehouseId, status, limit: 200, cursor: pager.cursor } }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api.r.patchReprint({ params: { id }, body: { status: 'CANCELLED' } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reprints'] }),
    onError: notify,
  });
  const items = list.data?.items ?? [];
  const sel = items.filter((r) => selected.includes(r.id));
  const kinds = [...new Set(sel.map((r) => r.kind))];
  const REASON: Record<string, string> = {
    DAMAGED: '损坏',
    MISSING: '缺失',
    LAYOUT_RECODE: '布局改码',
    LAYOUT_NEW: '布局新增',
    OTHER: '其他',
  };
  return (
    <div data-testid="reprint-queue">
      <Space style={{ marginBottom: 12 }} wrap>
        <Segmented
          value={status}
          onChange={(v) => {
            setStatus(v as typeof status);
            setSelected([]);
            pager.reset();
          }}
          options={[
            { value: 'PENDING', label: '待补打' },
            { value: 'DONE', label: '已完成' },
            { value: 'CANCELLED', label: '已取消' },
          ]}
        />
        {status === 'PENDING' && can(me, 'labels.print') && (
          <>
            <Button
              type="primary"
              disabled={!sel.length || kinds.length > 1}
              onClick={() => onPrint(kinds[0]!, sel)}
              data-testid="reprint-print"
            >
              打印所选（{sel.length}）
            </Button>
            <Button
              disabled={!items.length}
              onClick={() =>
                setSelected(
                  items.filter((r) => r.kind === (items[0]?.kind ?? 'LOCATION')).map((r) => r.id),
                )
              }
            >
              全选同类
            </Button>
            {kinds.length > 1 && (
              <Typography.Text type="danger">一次只能打印同一类标签</Typography.Text>
            )}
          </>
        )}
      </Space>
      <Table
        size="small"
        rowKey="id"
        loading={list.isLoading}
        pagination={false}
        dataSource={items}
        rowSelection={
          status === 'PENDING'
            ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }
            : undefined
        }
        locale={{ emptyText: <Empty description="没有补打请求" /> }}
        columns={[
          { title: '对象', dataIndex: 'kind', render: (k: LabelKind) => KIND_LABELS[k] },
          {
            title: '编码',
            dataIndex: 'code',
            render: (c: string) => <b style={{ fontFamily: 'monospace' }}>{c}</b>,
          },
          {
            title: '原因',
            dataIndex: 'reason',
            render: (r: string) => <Tag>{REASON[r] ?? r}</Tag>,
          },
          { title: '备注', dataIndex: 'note' },
          { title: '申请时间', dataIndex: 'requestedAt', render: fmtTime },
          { title: '完成时间', dataIndex: 'doneAt', render: fmtTime },
          {
            title: '',
            render: (_, r) =>
              r.status === 'PENDING' &&
              can(me, 'labels.print') && (
                <Popconfirm title="取消该补打请求？" onConfirm={() => cancel.mutate(r.id)}>
                  <Button size="small" type="link" danger>
                    取消
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
      <CursorPager pager={pager} nextCursor={list.data?.nextCursor} loading={list.isFetching} />
    </div>
  );
}

function ReprintRequestForm({ warehouseId }: { warehouseId: string }) {
  const qc = useQueryClient();
  const notify = useNotifyError();
  const { message } = AntApp.useApp();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState<'DAMAGED' | 'MISSING' | 'OTHER'>('DAMAGED');
  const m = useMutation({
    mutationFn: async () => {
      const c = code.includes('.') ? code.slice(code.indexOf('.') + 1) : code;
      const r = await api.r.listLocations({
        params: { id: warehouseId },
        query: { q: c.toUpperCase(), limit: 5 },
      });
      const l = r.items.find((x) => x.code === c.toUpperCase());
      if (!l) throw new Error(`未找到仓位 ${c}`);
      return api.r.createReprint({
        body: { warehouseId, kind: 'LOCATION', entityId: l.id, reason },
      });
    },
    onSuccess: () => {
      setCode('');
      void message.success('已加入补打队列');
      void qc.invalidateQueries({ queryKey: ['reprints'] });
    },
    onError: notify,
  });
  return (
    <Space.Compact style={{ marginBottom: 12 }}>
      <Input
        placeholder="扫描/输入仓位编码申请补打"
        value={code}
        onChange={(e) => setCode(e.target.value.trim())}
        style={{ width: 260 }}
        onPressEnter={() => code && m.mutate()}
        data-testid="reprint-code"
      />
      <Select
        value={reason}
        onChange={setReason}
        style={{ width: 100 }}
        options={[
          { value: 'DAMAGED', label: '损坏' },
          { value: 'MISSING', label: '缺失' },
          { value: 'OTHER', label: '其他' },
        ]}
      />
      <Button
        onClick={() => m.mutate()}
        disabled={!code}
        loading={m.isPending}
        data-testid="reprint-add"
      >
        申请补打
      </Button>
    </Space.Compact>
  );
}

export default function LabelsPage() {
  const warehouseId = useWarehouseId();
  const me = useMe();
  const printable = can(me, 'labels.print');
  const notify = useNotifyError();
  const qc = useQueryClient();
  const routeState = useLocation().state as { kind?: LabelKind; ids?: string[] } | null;
  const [tab, setTab] = useState(printable ? 'print' : 'queue');
  const [kind, setKind] = useState<LabelKind>(routeState?.kind ?? 'LOCATION');
  const [sel, setSel] = useState<Sel>(
    () => new Map((routeState?.ids ?? []).map((id) => [id, id.slice(0, 8)])),
  );
  const [template, setTemplate] = useState<LabelTemplateKey | null>(null);
  const [dpi, setDpi] = useState<203 | 300>(203);
  const [startCell, setStartCell] = useState<number | null>(1);
  const [offset, setOffset] = useState<OffsetMm>({ x: 0, y: 0 });
  const [reprintIds, setReprintIds] = useState<string[]>([]);
  const [pdf, setPdf] = useState<{ url: string; blob: Blob; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const tpls = useQuery({
    queryKey: ['labelTemplates'],
    queryFn: () => api.r.listLabelTemplates({}),
  });
  const all = useMemo(() => tpls.data?.items ?? [], [tpls.data]);
  const avail = templatesFor(all, kind);
  const tpl = all.find((t) => t.key === template) ?? null;
  const objs = useObjects(kind, warehouseId);

  useEffect(() => setTemplate((cur) => pickTemplate(all, kind, cur)), [all, kind]);
  useEffect(() => {
    if (template) setOffset(loadOffset(template));
  }, [template]);
  useEffect(() => () => void (pdf && URL.revokeObjectURL(pdf.url)), [pdf]);

  // 来自路由（仓位页“打印标签”）的 id 只有前缀：补上编码
  useEffect(() => {
    if (!objs.rows.length) return;
    setSel((m) => {
      let changed = false;
      const n = new Map(m);
      for (const r of objs.rows)
        if (n.has(r.id) && n.get(r.id) !== r.code) {
          n.set(r.id, r.code);
          changed = true;
        }
      return changed ? n : m;
    });
  }, [objs.rows]);

  const render = async (opts: {
    ids: string[];
    kind: LabelKind;
    reprint?: string[];
    download?: boolean;
  }) => {
    if (!template || !tpl) return;
    setBusy(true);
    try {
      const body = buildRenderBody({
        template,
        kind: opts.kind,
        warehouseId,
        ids: opts.ids,
        dpi,
        offset,
        startCell,
        isSheet: !!tpl.sheet,
        ...(opts.reprint ? { reprintRequestIds: opts.reprint } : {}),
      });
      const res = await api.r.renderLabels({ body });
      const blob = await res.blob();
      const name = `labels-${template}-${opts.ids.length}.pdf`;
      if (opts.download) downloadBlob(blob, name);
      setPdf((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { url: URL.createObjectURL(blob), blob, name };
      });
      if (opts.reprint) void qc.invalidateQueries({ queryKey: ['reprints'] });
    } catch (e) {
      notify(e);
    } finally {
      setBusy(false);
    }
  };

  const calibration = async () => {
    if (!template) return;
    try {
      const res = await api.r.calibrationPdf({ query: { template, dpi } });
      const blob = await res.blob();
      setPdf((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { url: URL.createObjectURL(blob), blob, name: `calibration-${template}.pdf` };
      });
    } catch (e) {
      notify(e);
    }
  };

  const ids = [...sel.keys()];
  const printPanel = (
    <Row gutter={16}>
      <Col xs={24} xl={11}>
        <Card
          size="small"
          title="1. 选择对象"
          extra={
            <Tag color="blue" data-testid="label-selected-count">
              已选 {sel.size}
            </Tag>
          }
        >
          <Segmented
            value={kind}
            onChange={(v) => {
              setKind(v as LabelKind);
              setSel(new Map());
              setReprintIds([]);
              objs.pager.reset();
            }}
            options={(['LOCATION', 'RACK', 'SKU'] as const).map((k) => ({
              value: k,
              label: KIND_LABELS[k],
            }))}
            style={{ marginBottom: 8 }}
            data-testid="label-kind"
          />
          <Space wrap style={{ marginBottom: 8 }}>
            {kind === 'LOCATION' && (
              <Input.Search
                placeholder="货架码，如 A01-L01"
                allowClear
                style={{ width: 170 }}
                onSearch={(v) => {
                  objs.setQ((q) => ({ ...q, rack: v.trim().toUpperCase() || undefined }));
                  objs.pager.reset();
                }}
              />
            )}
            <Input.Search
              placeholder="编码"
              allowClear
              style={{ width: 150 }}
              onSearch={(v) => {
                objs.setQ((q) => ({ ...q, q: v.trim() || undefined }));
                objs.pager.reset();
              }}
            />
            <Button
              size="small"
              onClick={() =>
                setSel((m) => {
                  const n = new Map(m);
                  for (const r of objs.rows) n.set(r.id, r.code);
                  return n;
                })
              }
              data-testid="label-select-page"
            >
              选中本页
            </Button>
            <Button size="small" onClick={() => setSel(new Map())}>
              清空
            </Button>
          </Space>
          <Table
            size="small"
            rowKey="id"
            loading={objs.loading}
            dataSource={objs.rows}
            pagination={kind === 'RACK' ? { pageSize: 15 } : false}
            scroll={{ y: 360 }}
            rowSelection={{
              selectedRowKeys: ids,
              preserveSelectedRowKeys: true,
              onChange: (_k, rows) =>
                setSel((m) => {
                  const pageIds = new Set(objs.rows.map((r) => r.id));
                  const n = new Map([...m].filter(([id]) => !pageIds.has(id)));
                  for (const r of rows) if (r) n.set(r.id, r.code);
                  return n;
                }),
            }}
            columns={[
              {
                title: '编码',
                dataIndex: 'code',
                render: (c: string) => <b style={{ fontFamily: 'monospace' }}>{c}</b>,
              },
              { title: '说明', dataIndex: 'desc', ellipsis: true },
            ]}
          />
          {kind !== 'RACK' && <CursorPager pager={objs.pager} nextCursor={objs.next} />}
        </Card>
      </Col>
      <Col xs={24} xl={13}>
        <Card size="small" title="2. 模板与校准">
          <Form layout="vertical">
            <Form.Item label={`模板（仅显示适用于${KIND_LABELS[kind]}的模板）`}>
              <Radio.Group
                value={template}
                onChange={(e) => setTemplate(e.target.value as LabelTemplateKey)}
                data-testid="label-templates"
              >
                <Space orientation="vertical">
                  {avail.map((t) => (
                    <Radio key={t.key} value={t.key}>
                      <b>{t.name}</b>{' '}
                      <Typography.Text type="secondary">
                        {t.key} · {t.widthMm}×{t.heightMm}mm
                        {t.sheet
                          ? ` · A4 ${t.sheet.cols}×${t.sheet.rows}=${perSheet(t)} 张/页`
                          : ' · 热敏单张'}
                      </Typography.Text>
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </Form.Item>
            <Space wrap>
              <Form.Item label="打印机分辨率">
                <Select
                  value={dpi}
                  onChange={setDpi}
                  style={{ width: 120 }}
                  options={[
                    { value: 203, label: '203 dpi' },
                    { value: 300, label: '300 dpi' },
                  ]}
                />
              </Form.Item>
              {tpl?.sheet && (
                <Form.Item label="起始格（用过的 A4 纸）">
                  <InputNumber
                    min={1}
                    max={perSheet(tpl)}
                    value={startCell}
                    onChange={(v) => setStartCell(v)}
                  />
                </Form.Item>
              )}
              <Form.Item label="偏移 X (mm)">
                <InputNumber
                  min={-10}
                  max={10}
                  step={0.5}
                  value={offset.x}
                  onChange={(v) => setOffset((o) => ({ ...o, x: v ?? 0 }))}
                />
              </Form.Item>
              <Form.Item label="偏移 Y (mm)">
                <InputNumber
                  min={-10}
                  max={10}
                  step={0.5}
                  value={offset.y}
                  onChange={(v) => setOffset((o) => ({ ...o, y: v ?? 0 }))}
                />
              </Form.Item>
              <Form.Item label=" ">
                <Button
                  onClick={() => template && (saveOffset(template, offset), void 0)}
                  data-testid="label-save-offset"
                >
                  保存偏移
                </Button>
              </Form.Item>
            </Space>
          </Form>
          <Space wrap>
            <Button
              type="primary"
              loading={busy}
              disabled={!ids.length || !template}
              onClick={() =>
                void render({ ids, kind, ...(reprintIds.length ? { reprint: reprintIds } : {}) })
              }
              data-testid="label-preview"
            >
              生成预览
            </Button>
            <Button
              disabled={!pdf}
              onClick={() => pdf && downloadBlob(pdf.blob, pdf.name)}
              data-testid="label-download"
            >
              下载 PDF
            </Button>
            <Button disabled={!template} onClick={calibration} data-testid="label-calibration">
              校准页
            </Button>
            {ids.length > MAX_LABELS_PER_JOB && (
              <Typography.Text type="danger">超过 {MAX_LABELS_PER_JOB} 张，请分批</Typography.Text>
            )}
            {reprintIds.length > 0 && (
              <Tag color="purple">补打 {reprintIds.length} 张（打印后标记完成）</Tag>
            )}
          </Space>
          <div style={{ marginTop: 12 }}>
            <PrintGuide />
          </div>
        </Card>
        <Card size="small" title="3. 预览" style={{ marginTop: 16 }}>
          {pdf ? (
            <iframe
              title="标签 PDF 预览"
              src={pdf.url}
              style={{ width: '100%', height: 520, border: '1px solid #eee' }}
              data-testid="label-pdf"
            />
          ) : (
            <Empty description="选择对象和模板后点击“生成预览”" />
          )}
          {sel.size > 0 && (
            <Typography.Paragraph
              type="secondary"
              style={{ marginTop: 8, marginBottom: 0 }}
              data-testid="label-selection-codes"
            >
              {[...sel.values()].slice(0, 12).join('、')}
              {sel.size > 12 ? ` 等 ${sel.size} 个` : ''}
            </Typography.Paragraph>
          )}
        </Card>
      </Col>
    </Row>
  );

  return (
    <div data-testid="labels-page">
      <PageHeader
        title="标签打印"
        sub="选对象 → 选模板 → 预览 PDF → 下载后用系统 PDF 阅读器按 100% 打印"
      />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          ...(printable ? [{ key: 'print', label: '打印', children: printPanel }] : []),
          {
            key: 'queue',
            label: '补打队列',
            children: (
              <>
                <ReprintRequestForm warehouseId={warehouseId} />
                <ReprintQueue
                  warehouseId={warehouseId}
                  onPrint={(k, rows) => {
                    setKind(k);
                    setSel(new Map(rows.map((r) => [r.entityId, r.code])));
                    setReprintIds(rows.map((r) => r.id));
                    setTab('print');
                  }}
                />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
