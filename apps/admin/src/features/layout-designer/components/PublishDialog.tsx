import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Descriptions,
  Modal,
  Result,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { LayoutDiff, LayoutIssue } from '@wms3d/contracts';
import { ISSUE_LABEL } from './ValidationPanel';
import type { PublishErrorView } from '../model/layoutApi';

export interface ValidateView {
  issues: LayoutIssue[];
  diff: LayoutDiff;
  locationCount: number;
}

export type PublishPhase =
  | { phase: 'closed' }
  | { phase: 'checking' }
  | { phase: 'review'; v: ValidateView }
  | { phase: 'publishing'; v: ValidateView }
  | { phase: 'failed'; v: ValidateView | null; err: PublishErrorView }
  | { phase: 'done'; version: number; reprints: number; diff: LayoutDiff };

/**
 * 发布差异弹窗（05 §2.2）：+新增 / =保留 / ~改码 / −停用；改码（尤其有库存）必须勾选确认；有库存仓位停用 = 阻断；
 * 发布失败（编码冲突、有库存、需确认、412）逐条列出原因。
 */
export function PublishDialog(p: {
  state: PublishPhase;
  canPublish: boolean;
  onPublish(confirmRecode: boolean): void;
  onClose(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const s = p.state;
  if (s.phase === 'closed') return null;
  const v =
    s.phase === 'review' || s.phase === 'publishing' ? s.v : s.phase === 'failed' ? s.v : null;
  const errors = v?.issues.filter((i) => i.severity === 'ERROR') ?? [];
  const blockedStock = v?.diff.deactivated.filter((d) => d.onHand > 0) ?? [];
  const needsConfirm = (v?.diff.recoded.length ?? 0) > 0;
  const canGo =
    p.canPublish &&
    !!v &&
    errors.length === 0 &&
    blockedStock.length === 0 &&
    (!needsConfirm || confirm);

  return (
    <Modal
      open
      width={760}
      title="发布布局"
      onCancel={p.onClose}
      maskClosable={false}
      footer={
        s.phase === 'done' ? (
          <Button type="primary" onClick={p.onClose} data-testid="publish-close">
            完成
          </Button>
        ) : (
          <Space>
            <Button onClick={p.onClose} data-testid="publish-cancel">
              取消
            </Button>
            <Button
              type="primary"
              disabled={!canGo}
              loading={s.phase === 'publishing'}
              onClick={() => p.onPublish(confirm)}
              data-testid="publish-confirm"
            >
              确认发布
            </Button>
          </Space>
        )
      }
    >
      <div data-testid="publish-dialog">
        {s.phase === 'checking' && <Spin description="保存草稿并在服务器校验…" />}
        {s.phase === 'done' && (
          <Result
            status="success"
            title={<span data-testid="publish-done">已发布 v{s.version}</span>}
            subTitle={`新增 ${s.diff.added.length}、保留 ${s.diff.kept}、改码 ${s.diff.recoded.length}、停用 ${s.diff.deactivated.length}；${s.reprints} 张标签已进入待补打队列`}
          />
        )}
        {s.phase === 'failed' && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            title={<span data-testid="publish-error-title">{s.err.title}</span>}
            description={
              <div>
                <div data-testid="publish-error-detail">{s.err.detail}</div>
                {s.err.issues.length > 0 && <IssueList issues={s.err.issues} />}
                {s.err.locations.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    {s.err.locations.slice(0, 30).map((l) => (
                      <Tag key={l.code} color="red">
                        {l.code}（库存 {l.onHand}）
                      </Tag>
                    ))}
                  </div>
                )}
              </div>
            }
          />
        )}
        {v && (
          <>
            <Descriptions size="small" bordered column={5} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="仓位总数">{v.locationCount}</Descriptions.Item>
              <Descriptions.Item label="+ 新增">
                <span data-testid="diff-added">{v.diff.added.length}</span>
              </Descriptions.Item>
              <Descriptions.Item label="= 保留">{v.diff.kept}</Descriptions.Item>
              <Descriptions.Item label="~ 改码">
                <span data-testid="diff-recoded">{v.diff.recoded.length}</span>
              </Descriptions.Item>
              <Descriptions.Item label="− 停用">
                <span data-testid="diff-deactivated">{v.diff.deactivated.length}</span>
              </Descriptions.Item>
            </Descriptions>
            {errors.length > 0 && (
              <Alert
                type="error"
                showIcon
                title={`服务器校验有 ${errors.length} 个错误，不能发布`}
                description={<IssueList issues={errors} />}
                style={{ marginBottom: 12 }}
                data-testid="server-errors"
              />
            )}
            {blockedStock.length > 0 && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 12 }}
                title={`${blockedStock.length} 个有库存的仓位会被停用，请先移库`}
                description={blockedStock.slice(0, 30).map((d) => (
                  <Tag key={d.locationId} color="red">
                    {d.code}（{d.onHand}）
                  </Tag>
                ))}
              />
            )}
            {needsConfirm && (
              <div data-testid="recode-confirm-block" style={{ marginBottom: 12 }}>
                <Alert
                  type="warning"
                  showIcon
                  title={`${v.diff.recoded.length} 个仓位将改码（${v.diff.recoded.filter((r) => r.onHand > 0).length} 个有库存），旧标签作废、需补打`}
                />
                <Table
                  size="small"
                  rowKey="locationId"
                  pagination={{ pageSize: 6, size: 'small' }}
                  dataSource={v.diff.recoded}
                  columns={[
                    { title: '原编码', dataIndex: 'from' },
                    { title: '新编码', dataIndex: 'to' },
                    {
                      title: '库存',
                      dataIndex: 'onHand',
                      render: (n: number) => (n > 0 ? <Tag color="orange">{n}</Tag> : n),
                    },
                  ]}
                />
                <Checkbox
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                  data-testid="recode-confirm"
                >
                  我已确认改码，并会补打这些仓位标签
                </Checkbox>
              </div>
            )}
            <Collapse
              size="small"
              items={[
                {
                  key: 'more',
                  label: '明细：新增 / 停用 / 复用 / 警告',
                  children: (
                    <Space orientation="vertical" style={{ width: '100%' }}>
                      <Typography.Text>
                        新增：
                        {v.diff.added
                          .slice(0, 40)
                          .map((a) => a.code)
                          .join('、') || '无'}
                        {v.diff.added.length > 40 ? '…' : ''}
                      </Typography.Text>
                      <Typography.Text>
                        停用：{v.diff.deactivated.map((d) => d.code).join('、') || '无'}
                      </Typography.Text>
                      <Typography.Text>
                        复用停用仓位：{v.diff.reused.map((d) => d.code).join('、') || '无'}
                      </Typography.Text>
                      <IssueList issues={v.issues.filter((i) => i.severity === 'WARNING')} />
                    </Space>
                  ),
                },
              ]}
            />
            {!p.canPublish && (
              <Alert
                type="info"
                title="只有管理员（ADMIN）可以发布；你可以保存草稿并请管理员发布"
                style={{ marginTop: 12 }}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function IssueList({ issues }: { issues: LayoutIssue[] }) {
  return (
    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
      {issues.slice(0, 20).map((i, k) => (
        <li key={k} style={{ fontSize: 12 }}>
          <Tag color={i.severity === 'ERROR' ? 'red' : 'orange'}>{ISSUE_LABEL[i.code]}</Tag>
          {i.message}
          {i.codes.length > 0 &&
            `：${i.codes.slice(0, 8).join('、')}${i.codes.length > 8 ? '…' : ''}`}
        </li>
      ))}
    </ul>
  );
}
