# ADR-0005 · 3D：three.js + React Three Fiber，数据驱动 + InstancedMesh
- 状态：已接受 · **v2 2026-11-12**（按 R1 M14/M15/M16/M23/M24 修订） · **v2.1**（2026-11-12 按 R2 M-N4/M-N13/M-N14 补充）

## 选项
- **three.js/R3F（选）**：生态最大，PC/移动 WebView 复用，InstancedMesh 一次 draw call 渲染数万仓位，`instanceColor` 着色、raycast 返回 instanceId。
- Babylon.js：功能全但包体更大，团队/Agent 熟悉度低于 three。
- 原生 SceneView/Filament：性能最好但 PC 需另写，违背 ADR-0001。
- Unity/UE 嵌入：包体与授权成本高，不符合 MVP。

## 决策
场景完全由布局数据生成；**按巷道分块**，每块：框架近景合并几何、远景实心盒、有货/空仓位两个 InstancedMesh（每仓位一个槽位，以缩放 0 切换归属）；按块距离 LOD（滞回）+ 视锥裁剪；解析式拾取（射线→货架 OBB→网格），不用 BVH；文字用 troika SDF；按需渲染；预算分档：5k 仓位 ≤ 60 draw calls / ≤ 150k 三角形，20k 仓位 ≤ 300k（依赖远景 LOD）。参见 06 与 sources [T1][T2][T3][T4]。

## 后果
+ 经分块 LOD 后 2 万仓位可在中端机达到 ≥ 24 FPS（需 M4 真机基准确认）；5k 仓位 ≥ 30 FPS。− 分块增加少量 draw calls 与实现复杂度；空/有货切换需维护两套槽位。

## v2.1 补充（R2）
- **紧凑槽位**（M-N4）：有货/空两个 InstancedMesh 各自紧凑存放，`slotOf/locOf` + swap-remove，`mesh.count` = 实际数量；层过滤同理；取代"缩放 0"。
- **FrameFar** 为每块一个 InstancedMesh；拾取遵从 LOD 与层过滤（M-N13）。
- **预算** draw calls ≤ 80，并断言各机位期望 LOD 分布（M-N14）。
- occupancy 承载 `isActive/effectiveMax`，ETag 为内容哈希；客户端拉取最小间隔 2s/1s（N2/M-N3）。
