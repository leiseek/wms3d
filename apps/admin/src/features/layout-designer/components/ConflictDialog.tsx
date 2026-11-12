import { Alert, Button, Descriptions, Modal, Space, Typography } from 'antd';
import type { Conflict, DocDelta } from '../model/draftSync';

const fmt = (d: DocDelta) =>
  (['racks', 'zones', 'floorAreas', 'rackTypes'] as const)
    .map((k) => {
      const n = d[k];
      const label = { racks: '货架', zones: '库区', floorAreas: '地面区', rackTypes: '模板' }[k];
      const parts = [
        n.added.length && `+${n.added.length}`,
        n.changed.length && `~${n.changed.length}`,
        n.removed.length && `−${n.removed.length}`,
      ].filter(Boolean);
      return parts.length ? `${label} ${parts.join(' ')}` : null;
    })
    .filter(Boolean)
    .join('，') || (d.warehouseChanged ? '仓库尺寸' : '无');

/** 412 三方提示（05 §2.2）：保留我的 / 采用服务器 / 导出我的副本后重载。 */
export function ConflictDialog(p: {
  conflict: Conflict;
  onKeepMine(): void;
  onAdoptServer(): void;
  onExportAndReload(): void;
}) {
  const c = p.conflict;
  return (
    <Modal
      open
      closable={false}
      maskClosable={false}
      title="草稿已被他人修改"
      width={620}
      footer={null}
    >
      <div data-testid="conflict-dialog">
        <Alert
          type="warning"
          showIcon
          title="保存时服务器返回 412（rowVersion 已变化）。三方对比如下（相对你上次保存/载入的版本）："
          style={{ marginBottom: 12 }}
        />
        <Descriptions size="small" bordered column={1}>
          <Descriptions.Item label="我的改动">
            <span data-testid="conflict-mine">{fmt(c.mineDelta)}</span>
          </Descriptions.Item>
          <Descriptions.Item label="服务器上的改动">
            <span data-testid="conflict-server">{fmt(c.serverDelta)}</span>（rowVersion{' '}
            {c.server.rowVersion}）
          </Descriptions.Item>
          <Descriptions.Item label="双方都改的对象">
            {c.overlapping.length ? (
              <Typography.Text type="danger">{c.overlapping.join('、')}</Typography.Text>
            ) : (
              '无'
            )}
          </Descriptions.Item>
        </Descriptions>
        <Space style={{ marginTop: 16 }} wrap>
          <Button type="primary" danger onClick={p.onKeepMine} data-testid="conflict-keep-mine">
            保留我的（覆盖服务器）
          </Button>
          <Button onClick={p.onAdoptServer} data-testid="conflict-adopt-server">
            采用服务器（丢弃我的改动）
          </Button>
          <Button onClick={p.onExportAndReload} data-testid="conflict-export">
            导出我的副本后重载
          </Button>
        </Space>
      </div>
    </Modal>
  );
}
