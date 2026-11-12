import { z } from 'zod';
import { Id } from './common.ts';

/** SSE 事件（03 §6）：`event: <name>`，`data: <JSON>`。不支持 Last-Event-ID；（重）连接后客户端先全量拉 occupancy。 */
export const EVENT_SCHEMAS = {
  'stock.changed': z
    .object({ layoutVersion: z.number().int(), locationIds: z.array(Id), txnId: Id })
    .meta({ id: 'EvtStockChanged' }),
  'locations.changed': z
    .object({ layoutVersion: z.number().int(), locationIds: z.array(Id) })
    .meta({ id: 'EvtLocationsChanged' }),
  'layout.published': z
    .object({ layoutVersion: z.number().int() })
    .meta({ id: 'EvtLayoutPublished' }),
  'reprint.created': z.object({ count: z.number().int() }).meta({ id: 'EvtReprintCreated' }),
  ping: z.object({ t: z.number().int() }).meta({ id: 'EvtPing' }),
} as const;
export type EventName = keyof typeof EVENT_SCHEMAS;
export type EventPayload<N extends EventName> = z.infer<(typeof EVENT_SCHEMAS)[N]>;
export type WmsEvent = { [N in EventName]: { event: N; data: EventPayload<N> } }[EventName];
export const EventsQuery = z.object({ warehouseId: Id });
export const SSE_PING_INTERVAL_MS = 25_000;

export function parseEvent(event: string, data: string): WmsEvent | null {
  if (!(event in EVENT_SCHEMAS)) return null;
  const schema = EVENT_SCHEMAS[event as EventName];
  const r = schema.safeParse(JSON.parse(data));
  return r.success ? ({ event, data: r.data } as WmsEvent) : null;
}
