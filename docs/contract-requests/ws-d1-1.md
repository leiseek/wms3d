# ws-d1-1 · RACK_OUTSIDE_ZONE 升级为 ERROR 的前置：修正 golden.test.ts 夹具；admin 引入 twin3d 的环境声明

- 提交：WS-D1（2026-11-12 PT，contract-v1.1）
- 是否阻塞：**否**（已用本地方案先行，见各条"现状"）

## 1. golden.test.ts 属性用例的三角形库区（Lead 所有）
**现状**：`packages/domain/src/golden.test.ts` › "属性：随机阵列复制生成的编码全部唯一" 用三点多边形
`[[0,0],[500,0],[500,500]]` 作为库区 A，生成的货架（x≈0、z≥2）几乎全部落在三角形外。WS-D1 在 M2D 补齐了
`RACK_OUTSIDE_ZONE`（多边形包含，贴边不报）；若按 05 §2.1 作为 ERROR，该用例会失败。
为保持 golden.test.ts 全绿，`RACK_OUTSIDE_ZONE` 目前以 **WARNING** 输出（常量
`RACK_OUTSIDE_ZONE_SEVERITY`，`packages/domain/src/layout/expand.ts`）。

**需求**：把该夹具的库区改为矩形（不影响任何黄金数据 / geometry-golden.json）：
```diff
-                polygon: [
-                  [0, 0],
-                  [500, 0],
-                  [500, 500],
-                ] as [number, number][],
+                polygon: [
+                  [0, 0],
+                  [500, 0],
+                  [500, 500],
+                  [0, 500],
+                ] as [number, number][],
```
合并后 WS-D1 将 `RACK_OUTSIDE_ZONE_SEVERITY` 改为 `'ERROR'`（一行，发布时服务端同函数权威拦截）。

## 2. admin 的 tsconfig 未包含 twin3d 的 `troika.d.ts`（Lead / WS-B）
**现状**：admin 直接编译 `@wms3d/twin3d` 源码时，`packages/twin3d/src/labels.ts` 的 `troika-three-text` 缺类型（TS7016）；
twin3d 自带的 `src/troika.d.ts` 是环境声明，不会被 import 链带入。WS-D1 在
`features/layout-designer/components/TwinPreview.tsx` 用 `/// <reference path>` 临时引入。WS-B 挂载 TwinView 时会遇到同样问题。

**建议**（二选一）：
- `apps/admin/tsconfig.json`：`"include": ["src", "vite.config.ts", "../../packages/twin3d/src/troika.d.ts"]`；或
- WS-D2 在 `labels.ts` 顶部 `import type {} from './troika.d.ts'` 之类显式引入。
合并后 WS-D1 删除该 reference。

## 3.（信息）mock 的 validateLayout 不计算 `recoded`
mock 的 `diff.recoded` 恒为空、publish 不检查 `confirmRecode`。设计器的改码确认弹窗在 Playwright 中通过网络层注入 recoded 验证；
真实 API（WS-A1）实现两轮匹配后无需改动前端。若 Lead 希望 mock 也覆盖，可按 02 §9 的第一轮 key 匹配给出 recoded。

---
**Lead 决定（2026-11-12 PT，main 在 contract-v1.2 之后；无契约变更，不另打 tag）**
1. **接受，已做**：`golden.test.ts` 属性用例的库区改为矩形 `[[0,0],[500,0],[500,500],[0,500]]`，黄金数据不变。已在本地验证：把 `RACK_OUTSIDE_ZONE_SEVERITY` 临时改为 `'ERROR'` 后，domain + mock 测试 68/68 全绿。**WS-D1**：rebase 后把常量改为 `'ERROR'`，跑完整 `pnpm verify`（含 api 的布局发布用例）后提交。
2. **接受，已做**（同 ws-c-1 #3）：`packages/twin3d/src/labels.ts` 顶部加 `/// <reference path="./troika.d.ts" />`，声明随 twin3d 源码一起带给消费方。已验证：去掉 TwinPreview 里的 reference 后，admin typecheck 仍通过。**WS-D1** 删除 `TwinPreview.tsx` 中的 reference；**WS-C** 删除 `apps/mobile/tsconfig.json` 中对 troika.d.ts 的 include。twin3d 归 WS-D2，这是 Lead 的一行集成修复，已告知 WS-D2。
3. mock 的 `recoded`：**暂不做**，排到 M4.5。真实 API（WS-A1）已实现两轮匹配和改码确认；联调时以真实 API 为准。
