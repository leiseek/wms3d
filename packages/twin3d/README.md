# @wms3d/twin3d（WS-D2）

3D 数字孪生展示组件，设计见 `docs/06-3d-twin.md`。**纯展示，不发请求**：输入 `TwinModel` + `Occupancy`，输出拾取事件。

## 接入（WS-B 大屏 / WS-C 移动 3D Tab / WS-D1 设计器预览）

```tsx
import { TwinView, buildTwinIndex, detectWebGL2, Twin2DFallback, createOccupancySync } from '@wms3d/twin3d';

<TwinView
  model={twin}                 // GET /warehouses/{id}/twin（null = 加载中）
  occupancy={occ}              // GET /twin/occupancy?layoutVersion=；版本不符会被忽略并回调 onStaleOccupancy
  colorMode="occupancy"        // 'occupancy' | 'skuCount' | 'zone'
  highlight={locateIds}        // /inventory/locate 返回的 locationId[]；变化时高亮 + 光柱 + 相机飞行
  onPick={(locationId) => …}
  cameraPreset="iso"           // 'top' | 'iso' | 'aisle'
  // 可选：onPickRack、maxLevel（层过滤）、labelFont（同源字体 URL，开启编码文字）、force2D、
  //       autoFallback（默认 true）、onStaleOccupancy、onModeChange、onPerf、ref（TwinViewHandle）
/>
```

- 容器需要有高度（组件撑满父元素）。
- `ref` 句柄：`flyTo(ids)`、`setCameraPreset(p)`、`stats()`（draw calls / 三角形 / 各 LOD 块数）、`rebuild()`、`mode()`、`engine()`。
- 实时更新：`createOccupancySync({ getLayoutVersion, fetchOccupancy, onOccupancy, reloadTwin, platform })`，把 `connectEvents` 的事件喂给 `handleEvent`，SSE 连上调 `onConnected()`、断开调 `onDisconnected()`。它负责 500ms 防抖、最小间隔（PC 1s / 移动 2s）、只在页面可见时拉取、版本不一致或 `LAYOUT_STALE` 时重载 TwinModel。
- 标签文字：troika 默认会去 CDN 取字体，**内网部署必须传 `labelFont`**（同源 .ttf/.woff）。不传则不显示文字。
- 2D 降级：WebGL2 不可用、初始化失败、启动基准降级后仍慢（p50 > 50ms）或 1 分钟内上下文丢失 3 次 → 自动切 `Twin2DFallback`（同 props），并提示“仍用 3D”。

## 实现要点

- 按巷道（zone + aisle）分块；每块：近景框架合并几何 1 + 有货 InstancedMesh 1 + 空仓位（透明）InstancedMesh 1；远景货架全仓 1 个 InstancedMesh；固定开销：地面、网格、库区、高亮、光柱、文字。
- 空/有货/停用切换：紧凑槽位 swap-remove（`CompactSlots`），只上传变化区间，不重建。
- 拾取：解析式（射线 × 货架 OBB → bay/level/position 网格），遵从 LOD（远景只返回货架）与层过滤。
- LOD：近 18/22m、远 45/40m 滞回；仓位数 ≤ 8000 时不启用远景（`farLodMinBins`），5k 全中景仍在预算内。
- 内部用 three.js + OrbitControls 直接驱动（按需渲染），未使用 R3F Canvas / drei CameraControls；对外接口不受影响。

## 脚本

```bash
packages/twin3d/scripts/playground.sh            # http://127.0.0.1:4530/?data=mock|bench5k|bench20k&preset=top|iso|aisle&locate=SKU-001
node packages/twin3d/scripts/e2e.mjs             # 浏览器验收（Chrome + Playwright）
node packages/twin3d/scripts/shots.mjs           # 截图 → /workspace/wms3d-artifacts/screens/ws-d2/
flock /tmp/wms3d-perf.lock node packages/twin3d/scripts/bench.mjs   # 5k/20k × 3 机位，结果 bench-results/latest.json
```
