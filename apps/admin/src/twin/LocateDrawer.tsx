import { lazy, Suspense } from 'react';
import { Drawer, Spin, Typography } from 'antd';

const TwinPanel = lazy(() => import('./TwinPanel'));

/** “在 3D 中定位”抽屉：懒加载 twin3d，高亮给定仓位并飞行到其包围盒。 */
export function LocateDrawer(props: {
  open: boolean;
  onClose(): void;
  warehouseId: string;
  highlight: string[];
  title: string;
  subtitle?: string;
}) {
  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      size="large"
      styles={{ wrapper: { width: 'min(1100px, 92vw)' } }}
      title={props.title}
      destroyOnHidden
    >
      {props.subtitle && (
        <Typography.Paragraph type="secondary">{props.subtitle}</Typography.Paragraph>
      )}
      <Suspense fallback={<Spin />}>
        <TwinPanel
          warehouseId={props.warehouseId}
          highlight={props.highlight}
          height="calc(100vh - 170px)"
        />
      </Suspense>
    </Drawer>
  );
}
