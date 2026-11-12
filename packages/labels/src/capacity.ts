import type { LabelTemplateKey } from '@wms3d/contracts';
import { countPayloadModules } from './barcode-metrics.ts';
import { isPrefixedPayload, maxModulesFor } from './templates.ts';
import type { CapacityResult, Dpi } from './types.ts';

export class LabelCapacityError extends Error {
  readonly template: LabelTemplateKey;
  readonly payload: string;
  readonly modules: number;
  readonly max: number;
  readonly dpi: Dpi;

  constructor(opts: {
    template: LabelTemplateKey;
    payload: string;
    modules: number;
    max: number;
    dpi: Dpi;
  }) {
    super(
      `条码载荷超出模板容量：${opts.payload} 需要 ${opts.modules} 模块，` +
        `${opts.template} @${opts.dpi}dpi 最多 ${opts.max}。请改用更宽模板或缩短编码。`,
    );
    this.name = 'LabelCapacityError';
    this.template = opts.template;
    this.payload = opts.payload;
    this.modules = opts.modules;
    this.max = opts.max;
    this.dpi = opts.dpi;
  }
}

export function checkCapacity(
  template: LabelTemplateKey,
  payload: string,
  dpi: Dpi,
): CapacityResult {
  const bare = !isPrefixedPayload(payload);
  const max = maxModulesFor(template, dpi, bare);
  if (max == null) return { ok: true, modules: 0, max: Number.POSITIVE_INFINITY };
  const modules = countPayloadModules(template, payload);
  return { ok: modules <= max, modules, max };
}

export function assertCapacity(template: LabelTemplateKey, payload: string, dpi: Dpi): void {
  const r = checkCapacity(template, payload, dpi);
  if (!r.ok) {
    throw new LabelCapacityError({
      template,
      payload,
      modules: r.modules,
      max: r.max,
      dpi,
    });
  }
}
