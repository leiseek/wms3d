import { Badge, Empty, List, Tag, Typography } from 'antd';
import type { LayoutIssue } from '@wms3d/contracts';

export const ISSUE_LABEL: Record<LayoutIssue['code'], string> = {
  RACK_OVERLAP: '货架重叠',
  OUT_OF_BOUNDS: '超出仓库边界',
  AISLE_TOO_NARROW: '巷道过窄',
  AISLE_FACE_MISALIGNED: '取货面不一致',
  BAY_RANGE_OVERLAP: 'bay 区间重叠',
  BAY_PARITY: 'bay 奇偶错误',
  CODE_DUPLICATE: '编码重复',
  CODE_TOO_LONG: '编码超长/超位数',
  UNKNOWN_ZONE: '库区不存在',
  UNKNOWN_RACK_TYPE: '模板不存在',
  RACK_OUTSIDE_ZONE: '越出库区',
  OTHER: '其他',
};

/** 实时校验面板（domain.validateLayout，与服务端同一函数）。点击条目选中相关货架。 */
export function ValidationPanel(p: {
  issues: readonly LayoutIssue[];
  onPick(rackKeys: string[]): void;
}) {
  const errors = p.issues.filter((i) => i.severity === 'ERROR').length;
  const warnings = p.issues.length - errors;
  return (
    <div data-testid="validation-panel">
      <Typography.Text strong>
        实时校验 <Badge count={errors} color="#f5222d" showZero data-testid="error-count" />{' '}
        <Badge count={warnings} color="#fa8c16" showZero />
      </Typography.Text>
      {p.issues.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有问题" />
      ) : (
        <List
          size="small"
          dataSource={p.issues as LayoutIssue[]}
          style={{ maxHeight: 220, overflow: 'auto' }}
          renderItem={(i) => (
            <List.Item
              style={{ cursor: i.rackKeys.length ? 'pointer' : 'default', padding: '4px 0' }}
              onClick={() => i.rackKeys.length && p.onPick(i.rackKeys)}
              data-testid={`issue-${i.code}`}
            >
              <span style={{ fontSize: 12 }}>
                <Tag color={i.severity === 'ERROR' ? 'red' : 'orange'}>{ISSUE_LABEL[i.code]}</Tag>
                {i.message}
                {i.codes.length > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {' '}
                    {i.codes.slice(0, 6).join('、')}
                    {i.codes.length > 6 ? '…' : ''}
                  </Typography.Text>
                )}
              </span>
            </List.Item>
          )}
        />
      )}
    </div>
  );
}
