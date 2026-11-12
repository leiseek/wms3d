import { useState } from 'react';
import { Alert, Button, Modal, Result, Space, Steps, Table, Tag, Typography, Upload } from 'antd';
import { api } from '../api';
import { errorMessage } from '../lib/errors';
import {
  errorReportCsv,
  mergeRowErrors,
  previewSkuCsv,
  SKU_CSV_TEMPLATE,
  type RowError,
  type SkuCsvPreview,
} from '../lib/csv';
import { downloadText } from '../lib/download';

type ImportRes = Awaited<ReturnType<typeof api.r.importSkus>>;

/** CSV 导入向导（05 §3）：上传 → 预检（前端 + 服务端 dryRun）→ 确认导入（服务端每 1000 行一个事务）。 */
export function SkuImportWizard(props: { open: boolean; onClose(): void; onDone(): void }) {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SkuCsvPreview | null>(null);
  const [dry, setDry] = useState<ImportRes | null>(null);
  const [errors, setErrors] = useState<RowError[]>([]);
  const [result, setResult] = useState<ImportRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);

  const reset = () => {
    setStep(0);
    setFile(null);
    setPreview(null);
    setDry(null);
    setErrors([]);
    setResult(null);
    setFail(null);
  };
  const close = () => {
    reset();
    props.onClose();
  };

  const send = (f: File, dryRun: boolean) => {
    const fd = new FormData();
    fd.append('file', f, f.name);
    return api.r.importSkus({ query: { dryRun: dryRun ? 'true' : 'false' }, body: fd });
  };

  const onFile = async (f: File) => {
    setBusy(true);
    setFail(null);
    try {
      const text = await f.text();
      const p = previewSkuCsv(text);
      setFile(f);
      setPreview(p);
      let server: ImportRes | null = null;
      // 表头错误时不必再请求服务端预检
      if (!p.errors.some((e) => e.row === 0)) server = await send(f, true);
      setDry(server);
      setErrors(mergeRowErrors(p.errors, server?.errors ?? []));
      setStep(1);
    } catch (e) {
      setFail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!file) return;
    setBusy(true);
    setFail(null);
    try {
      const r = await send(file, false);
      setResult(r);
      setStep(2);
      props.onDone();
    } catch (e) {
      setFail(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const hasErrors = errors.length > 0;
  return (
    <Modal
      open={props.open}
      onCancel={close}
      title="SKU CSV 导入"
      width={860}
      footer={null}
      destroyOnHidden
    >
      <Steps
        current={step}
        items={[{ title: '上传' }, { title: '预检' }, { title: '完成' }]}
        style={{ marginBottom: 20 }}
      />
      {fail && <Alert type="error" title={fail} style={{ marginBottom: 12 }} />}
      {step === 0 && (
        <>
          <Typography.Paragraph>
            UTF-8 CSV，列：
            <Typography.Text code>
              code,name,spec,uom,barcode,pack_qty,safety_stock,length_mm,width_mm,height_mm,weight_g
            </Typography.Text>
            。同一 SKU 多个条码请写多行；按 code 更新已存在的 SKU；最多 5 万行。
          </Typography.Paragraph>
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Button onClick={() => downloadText(SKU_CSV_TEMPLATE, 'sku-import-template.csv')}>
              下载模板
            </Button>
            <div data-testid="sku-import-upload">
              <Upload.Dragger
                accept=".csv,text/csv"
                maxCount={1}
                showUploadList={false}
                disabled={busy}
                beforeUpload={(f) => {
                  void onFile(f);
                  return false;
                }}
              >
                <p style={{ padding: 24 }}>{busy ? '正在预检…' : '点击或拖拽 CSV 文件到此处'}</p>
              </Upload.Dragger>
            </div>
          </Space>
        </>
      )}
      {step === 1 && preview && (
        <>
          <Space wrap style={{ marginBottom: 12 }} data-testid="sku-import-summary">
            <Tag>文件 {file?.name}</Tag>
            <Tag>数据行 {preview.rows.length}</Tag>
            <Tag>SKU {preview.skuCount}</Tag>
            {dry && (
              <>
                <Tag color="blue">将新增 {dry.created}</Tag>
                <Tag color="blue">将更新 {dry.updated}</Tag>
              </>
            )}
            <Tag color={hasErrors ? 'red' : 'green'} data-testid="sku-import-error-count">
              错误 {errors.length}
            </Tag>
          </Space>
          {hasErrors ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              title={`发现 ${errors.length} 处错误，请修正后重新上传`}
              action={
                <Button
                  size="small"
                  onClick={() =>
                    downloadText(errorReportCsv(errors, preview.rows), 'sku-import-errors.csv')
                  }
                  data-testid="sku-import-download-errors"
                >
                  下载错误报告
                </Button>
              }
            />
          ) : (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              title="预检通过，可以导入"
            />
          )}
          {hasErrors && (
            <Table
              size="small"
              rowKey={(e) => `${e.row}-${e.column}-${e.code}-${e.message}`}
              dataSource={errors}
              pagination={{ pageSize: 8 }}
              data-testid="sku-import-errors"
              columns={[
                {
                  title: '行',
                  dataIndex: 'row',
                  width: 60,
                  render: (r: number) => (r === 0 ? '表头' : r),
                },
                { title: '列', dataIndex: 'column', width: 110 },
                {
                  title: '错误',
                  dataIndex: 'code',
                  width: 150,
                  render: (c: string) => <Tag color="red">{c}</Tag>,
                },
                { title: '说明', dataIndex: 'message' },
                {
                  title: '来源',
                  dataIndex: 'source',
                  width: 90,
                  render: (s: string) => (s === 'local' ? '前端' : '服务端'),
                },
              ]}
            />
          )}
          <Typography.Text type="secondary">前 5 行预览</Typography.Text>
          <Table
            size="small"
            rowKey={(_r, i) => String(i)}
            pagination={false}
            dataSource={preview.rows.slice(0, 5)}
            scroll={{ x: true }}
            columns={['code', 'name', 'spec', 'uom', 'barcode', 'pack_qty', 'safety_stock'].map(
              (c) => ({
                title: c,
                dataIndex: c,
              }),
            )}
          />
          <Space style={{ marginTop: 16 }}>
            <Button onClick={reset}>重新上传</Button>
            <Button
              type="primary"
              disabled={hasErrors}
              loading={busy}
              onClick={commit}
              data-testid="sku-import-commit"
            >
              确认导入
            </Button>
          </Space>
        </>
      )}
      {step === 2 && result && (
        <Result
          status="success"
          title="导入完成"
          subTitle={`共 ${result.totalRows} 行：新增 ${result.created}，更新 ${result.updated}，分 ${result.committedBatches} 批提交`}
          extra={
            <Button type="primary" onClick={close}>
              关闭
            </Button>
          }
        />
      )}
    </Modal>
  );
}
