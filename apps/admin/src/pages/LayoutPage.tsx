import { api } from '../api';
import { useMe, useWarehouseId } from '../session';
import { can } from '../lib/rbac';
import { LayoutDesignerPage } from '../features/layout-designer';

/** /layout：挂载 WS-D1 的布局设计器（05 §2），传入本后台的会话与当前仓库。 */
export default function LayoutPage() {
  const warehouseId = useWarehouseId();
  const me = useMe();
  return (
    <LayoutDesignerPage
      key={warehouseId}
      api={api}
      warehouseId={warehouseId}
      canPublish={me?.role === 'ADMIN'}
      canEdit={can(me, 'layout.edit')}
      height="calc(100vh - 104px)"
    />
  );
}
