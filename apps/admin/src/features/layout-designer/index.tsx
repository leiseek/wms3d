/**
 * WS-D1 布局设计器对外唯一出口（05 §2）。WS-B 在 `/layout` 路由挂载：
 *
 * ```tsx
 * import { LayoutDesignerPage } from './features/layout-designer';
 * <LayoutDesignerPage api={api} warehouseId={currentWarehouseId} canPublish={me.role === 'ADMIN'} canEdit={me.role !== 'OPERATOR' && me.role !== 'VIEWER'} />
 * ```
 */
export { LayoutDesignerPage, type LayoutDesignerPageProps } from './LayoutDesignerPage';
