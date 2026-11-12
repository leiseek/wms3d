# ADR-0005 · 3D：three.js + React Three Fiber，数据驱动 + InstancedMesh
- 状态：已接受（v1）

## 选项
- **three.js/R3F（选）**：生态最大，PC/移动 WebView 复用，InstancedMesh 一次 draw call 渲染数万仓位，`instanceColor` 着色、raycast 返回 instanceId。
- Babylon.js：功能全但包体更大，团队/Agent 熟悉度低于 three。
- 原生 SceneView/Filament：性能最好但 PC 需另写，违背 ADR-0001。
- Unity/UE 嵌入：包体与授权成本高，不符合 MVP。

## 决策
场景完全由布局数据生成（无手工建模）；货架框架按模板合并几何并实例化；全部仓位一个（或透明/不透明两个）InstancedMesh；按需渲染；draw calls ≤ 60 预算；颜色局部更新。参见 06 文档与 sources [T1][T2][T3]。

## 后果
+ 2 万仓位仍可在中端机流畅；− 单个 InstancedMesh 无逐实例视锥裁剪（可接受，按货架分块是后续优化选项）。
