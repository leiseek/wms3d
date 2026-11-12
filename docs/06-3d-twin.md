# 06 · 3D 数字孪生

> v2（2026-11-12）：按巷道分块（LOD + 视锥裁剪）、三角形预算分档、空/有货 mesh 归属切换、twinIndex 绑定 layoutVersion、解析式拾取、SDF 文本、上下文丢失处理。

## 1. 原则
- `packages/twin3d` 纯展示：输入 `TwinModel`（含 `layoutVersion`）与 `Occupancy`（同版本），输出事件 `onSelectLocation(locationId)`、`onSelectRack(key)`。不发请求。
- three.js 0.187 + @react-three/fiber 9.8 + drei 10.7（仅 `CameraControls`）；无后处理、无实时阴影。
- 坐标、旋转、编号方向严格遵守 02 §2；几何由 `domain.expandLayout` 生成（与发布仓位同一函数）。

## 2. 场景图（按巷道分块）
```
Scene
├─ Lights: HemisphereLight + DirectionalLight（无阴影）
├─ Floor: Plane + 网格 LineSegments（2 draw calls）
├─ ZoneAreas: 全部库区/地面区合并 1 个 BufferGeometry（顶点色）（1）
├─ Chunk[k]（k = 巷道/货架行，典型 10–30 块）
│   ├─ FrameNear: 该块货架框架（立柱 + 横梁）合并几何（1）
│   ├─ FrameFar: 低模实心盒（每货架 1 个盒，按货架汇总占用着色）（1）
│   ├─ BinsOpaque: 有货仓位 InstancedMesh（分配 N_k 实例）（1）
│   └─ BinsEmpty:  空仓位 InstancedMesh（分配 N_k 实例，透明，depthWrite=false）（1）
├─ Highlight: 高亮/定位仓位脉冲框（≤ 200 实例）（1）
├─ Markers: 定位光柱（≤ 50）（1）
└─ Labels: 近距离仓位编码 troika SDF 文本（≤ 50，合批）（1–2）
```
- 每块有独立包围盒 → three 自动**视锥裁剪**；按块做**距离 LOD**（带滞回：进入近景 < 18m，退出 > 22m；远景切换 40/45m）。
- Draw calls：远景每块 1（FrameFar），近/中景每块 3（FrameNear + 两个 Bins）；20 块全中景 ≈ 60 + 8 固定 ≈ 68 —— 因视锥裁剪与远景合并，实际可见 ≤ 60（预算 §8）。块数 > 30 时，相邻远景块合并为一个 FrameFar 批次。

## 3. 几何与三角形（M14）
| 元素 | 三角形 |
|---|---|
| 仓位盒（去底面，只画 5 面） | 10 / 仓位 |
| 货架框架近景（立柱 4 根 × 12 + 每层前后横梁合并为 1 根盒 × 12 × 层数） | 约 48 + 12·levels（5 层 ≈ 108），上限 200 / 货架 |
| 货架远景实心盒 | 12 / 货架 |
`expandLayout` 输出每块的 `Float32Array` 矩阵缓冲（16×N），零对象分配直接喂 InstancedMesh。

## 4. 着色与空/有货归属（M15）
| 模式 | 规则 |
|---|---|
| 占用（默认） | 空 → 进 `BinsEmpty`（浅灰 #D9D9D9，透明 0.25）；有货 → 进 `BinsOpaque`，颜色按 `fill`（02 §4）绿→黄→橙 |
| SKU 数 | 1 / 2+（混放）用不同色 |
| 停用 | 不透明暗红，放 `BinsOpaque` |
| 定位高亮 | 其余实例颜色**混向灰色（仍不透明，不改透明度）**；目标仓位复制到 `Highlight` mesh 脉冲 + 光柱 |
- **归属切换**：两个 mesh 均为每个仓位分配一个槽位（slot = 块内序号）；空 → 有货时，`BinsOpaque` 写入原矩阵、`BinsEmpty` 写入**缩放 0 矩阵**，反之亦然；同时更新 `instanceColor`。只上传变化的范围（three r159+ `addUpdateRange`；不支持时整段上传）。
- 单测：给定 occupancy 变化（空↔有货、停用），断言两个 mesh 可见槽位集合正确、无重复无遗漏。

## 5. 交互
- 相机：`CameraControls`；PC：左键旋转、右键平移、滚轮缩放；移动端：单指平移、双指缩放+旋转（04 §6）。预设视角：俯视 / 等轴 / 巷道视角；双击（移动端点击卡片按钮）→ `fitToBox` 飞行聚焦。
- **拾取（M23）**：解析式——射线先与各货架 OBB 求交（O(货架数)），命中后在货架局部系按 bay/level/position 网格直接算出仓位；地面区按多边形判定。去掉 three-mesh-bvh 依赖。
- **SKU 定位**：`/inventory/locate` 返回 `{layoutVersion, items:[{locationId,...}]}` → 若版本与本地 TwinModel 不一致先重载 → 用 `idToIndex: Map` 求下标 → `setHighlight` → 飞到包围盒；列表与 3D 双向联动。指标：缓存 TwinModel 命中时，从提交搜索到相机开始飞行 ≤ 1s（写入 00 成功标准，M33）。
- 层过滤：滑杆"只看第 N 层及以下"（缩放 0 隐藏）。
- 选中卡片：只有**单个**选中卡片用 drei `<Html>`；编码文字一律用 troika SDF（M24）。

## 6. 数据加载与实时更新（D16/D17/M17）
- `GET /twin`（ETag，IndexedDB 缓存）→ `GET /twin/occupancy?layoutVersion=v`（ETag/304）。
- 收到 SSE `stock.changed`：若 `layoutVersion` ≠ 本地 → 重载 `/twin`；否则防抖 500ms 全量拉 occupancy，与本地数组比较后只更新变化槽位。
- `409 LAYOUT_STALE` 或 `layout.published` → 重载 TwinModel（提示"布局已更新"）。
- SSE 重连后先全量拉一次 occupancy；无 SSE 时每 60s ETag 轮询。

## 7. 降级与生命周期（M13/M21/M22）
- 启动检测 WebGL2；不支持 → 2D 平面图（同数据 Canvas2D 绘制，仍支持定位高亮）。
- 启动 2s 强制连续渲染基准，p50 帧时间 > 50ms → 自动 dpr=1、关闭抗锯齿与文字标签，仍慢则建议切 2D；交互中持续采样帧时间。
- `frameloop="demand"`；脉冲/光柱动画只在高亮期间请求帧，8s 后停止。
- 不可见时停止渲染；`webglcontextlost` → 停止，`restored` → 重建几何/材质/实例缓冲（twin3d 内部封装 `rebuild()`）。

## 8. 性能预算（分档，M14）
| 场景 | Draw calls（可见） | 三角形（可见） | FPS（中端机，旋转 10s 平均） | 首屏 |
|---|---|---|---|---|
| 5k 仓位（典型） | ≤ 60 | ≤ 150k | ≥ 30 | ≤ 3s（缓存命中 ≤ 1.5s） |
| 20k 仓位（上限） | ≤ 60 | ≤ 300k（依赖远景 LOD） | ≥ 24 | ≤ 5s |
估算：5k 仓位全近景 = 50k（仓位）+ 约 250 货架 × 108 ≈ 27k ≈ 77k；20k 全近景 ≈ 200k + 1,000 × 108 ≈ 308k，常规视角远景块占比 > 50% 时降到 < 200k。
验收：Playwright + Chrome 断言 `renderer.info.render.calls/triangles`（固定 3 个机位：全景俯视、等轴全景、巷道内）；真机 5k 与 20k 两档都测（ADR-0005 v2）。
