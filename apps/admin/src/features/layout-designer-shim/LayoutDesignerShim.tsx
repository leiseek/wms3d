import { Alert, Card, Typography } from 'antd';

/**
 * WS-D1 的 LayoutDesignerPage 合并前的占位（brief §8）。D1 合并后，router 改为从
 * `src/features/layout-designer/index.tsx` 懒加载 LayoutDesignerPage，并删除本 shim。
 */
export default function LayoutDesignerShim() {
  return (
    <Card title="布局设计器" data-testid="layout-shim">
      <Alert
        type="info"
        showIcon
        title="布局设计器由 WS-D1 交付，合并后在此处挂载"
        description="当前为占位页。库区 / 货架只能通过布局草稿编辑（02 §4）；运行时属性（停用、容量）可在“仓位”页批量修改。"
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
        路由：/layout → features/layout-designer/index.tsx 的 LayoutDesignerPage。
      </Typography.Paragraph>
    </Card>
  );
}
