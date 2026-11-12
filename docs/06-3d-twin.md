# 06 · 3D 数字孪生

## 1. 原则
- `packages/twin3d` 是**纯展示**包：输入 `TwinModel`（布局 + 仓位列式数组）与 `Occupancy`（与 twinIndex 对齐的数值数组），输出交互事件（`onSelectLocation(twinIndex)`、`onSelectRack(key)`）。不发请求、不依赖业务状态库，便于 PC/移动复用与单测。
- three.js + @react-three/fiber + drei（只用 `CameraControls`、`Bvh` 等轻量部件），不用后处理、不用实时阴影。

## 2. 场景图
```
Scene
├─ Lights: HemisphereLight + 1×DirectionalLight（无阴影）
├─ Floor: 1 个 PlaneGeometry（仓库尺寸）+ 网格线（LineSegments，1 draw call）
├─ ZoneAreas: 所有库区/地面区多边形合并为 1 个 BufferGeometry（顶点色），1 draw call
├─ RackFrames: 每种 RackType 的框架（立柱+横梁）预先 mergeGeometries 成一个几何 → 每种模板 1 个 InstancedMesh（实例 = 货架）
├─ Bins: 全仓库仓位 1 个 InstancedMesh（单位立方体 BoxGeometry，实例矩阵 = 仓位中心+尺寸缩放 0.9），instanceColor 着色
├─ Labels: 仅对"选中/高亮/近距离"的 ≤ 50 个仓位用 drei <Html> 或 SDF 文本（troika）显示编码
├─ Highlight: 高亮仓位的描边/脉冲框（独立小 InstancedMesh，≤ 200 实例）
└─ Markers: 定位结果的竖直"光柱"（InstancedMesh）
```
总 draw calls ≈ 2 + 模板数 + 4 ≈ 10–20，远低于 60 预算。

## 3. 几何计算（domain 共享）
`expandLayout(doc) → TwinModel`：对每个货架，根据模板计算每个仓位局部 AABB（bay 宽 / positionsPerLevel、层高累计、深度），再乘货架世界矩阵（平移 x,z + 绕 Y 旋转）。与服务端发布生成仓位使用**同一函数**，保证"编码 ↔ 3D 位置"一致；输出 Float32Array 矩阵缓冲（16×N）直接喂给 InstancedMesh（零对象分配）。

## 4. 着色方案（可切换图例）
| 模式 | 规则 |
|---|---|
| 占用（默认） | 空：浅灰半透明 `#D9D9D9` 透明度 0.25；有货：按 fill ratio 绿→黄→橙（有 max_qty 时为数量比，否则 有货=绿） |
| SKU 数 | 0 / 1 / 2+（混放提示） |
| 热度 | 近 7 天动碰次数（M5 可选） |
| 停用 | 斜线灰 / 暗红 |
| 定位高亮 | 其它仓位整体降饱和 + 透明，目标仓位亮色 + 脉冲 + 光柱 |
透明度处理：空仓位与有货仓位分两个 InstancedMesh（透明/不透明），避免排序问题（总 draw call +1）。

## 5. 交互
- 相机：`CameraControls`，单指旋转、双指缩放/平移；预设视角按钮（俯视/等轴/巷道视角），双击仓位 → 平滑飞行聚焦（`fitToBox`）。
- 拾取：Raycast 命中 InstancedMesh 得 `instanceId = twinIndex`，用 three-mesh-bvh 加速（≥ 5k 实例时）；点击弹出底部卡片：仓位编码、SKU 列表与数量、"移库/出库"快捷入口。
- **SKU 定位**：`/inventory/locate` 返回 twinIndex 列表 → `setHighlight(indices)` → 相机飞到包围盒；列表与 3D 双向联动；多仓位按数量排序。
- 楼层/层过滤：滑杆"只看第 N 层及以下"（通过实例缩放为 0 隐藏，无需重建）。

## 6. 实时更新
- 首次加载：`GET /twin`（ETag，本地缓存 IndexedDB）+ `GET /twin/occupancy`。
- SSE `stock.changed {locationIds}` → 防抖 500ms 批量 `GET /twin/occupancy?since=` 获取变更的 `(twinIndex, qty, fill)` → 只改对应 `instanceColor` 段并 `needsUpdate`（`addUpdateRange` 局部上传）。
- `layout.published` → 提示"布局已更新"并重新加载 TwinModel。

## 7. LOD 与降级
| 距离/条件 | 表现 |
|---|---|
| 远（> 40m） | 货架框架换成实心盒（每模板 1 个 InstancedMesh 的低模版本），仓位不画，仅货架按汇总占用着色 |
| 中 | 框架 + 仓位方块 |
| 近（< 8m） | 加仓位编码文字（最多 50 个，最近优先） |
| 低端机 | 自动：dpr=1、关闭抗锯齿、关闭标签；FPS < 20 → 提示切换 2D 平面图（同数据画 Canvas2D） |
LOD 用 drei `<Detailed>` 风格的距离切换，但作用于整个 InstancedMesh 组（切换开销低）。

## 8. 性能验收方法
- 基准场景：生成 5,000 / 20,000 仓位的种子布局。
- 自动化：Playwright + Chrome（CPU 4× 降速、GPU 软件模拟只验 draw call/三角形）断言 `renderer.info.render.calls ≤ 60`、`triangles ≤ 150k`；
- 真机：中端 Android 平板/手机各 1 台，用 `stats-gl` 面板记录 FPS（旋转 10s 平均 ≥ 30）。
