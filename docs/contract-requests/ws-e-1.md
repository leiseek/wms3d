# WS-E-1 · contracts 补齐 LabelKind / LabelTemplate 的 type 导出

- 工作流：ws-e
- 阻塞：否（本包已用字面量 union / 手写 `TemplateSpec` 对齐字段，可先合并）
- 现状：`packages/contracts/src/labels.ts` 只 `export type LabelTemplateKey`，`LabelKind` 与 `LabelTemplate` 仅有 Zod 值导出。`import type { LabelKind, LabelTemplate }` 在 `verbatimModuleSyntax` 下报 “refers to a value, but is being used as a type”。
- 需求：与同文件 `LabelTemplateKey`、以及其他契约模块（如 `ScanKind`）一致，增加：

```ts
export type LabelKind = z.infer<typeof LabelKind>;
export type LabelTemplate = z.infer<typeof LabelTemplate>;
```

- schema 无需改动，无兼容性风险。
- 合并后 WS-E 会删掉库内重复的 `LabelKind` / `TemplateSpec` 手写类型，改为直接引用 contracts。
