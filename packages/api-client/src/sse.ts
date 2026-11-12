import { createParser } from 'eventsource-parser';
import { API_PREFIX, parseEvent, type WmsEvent } from '@wms3d/contracts';

export interface EventStreamOptions {
  warehouseId: string;
  baseUrl?: string;
  getAccessToken: () => string | null | undefined;
  /** 401 / 服务端在 exp 关流时调用；返回 true 后立即重连 */
  refresh?: () => Promise<boolean>;
  onEvent: (e: WmsEvent) => void;
  /** 每次（重）连接成功：客户端应在此全量拉取 occupancy（03 §6：不支持 Last-Event-ID） */
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  fetch?: typeof fetch;
  /** 重连退避（毫秒），缺省 [1000, 2000, 5000, 10000, 30000] */
  backoffMs?: number[];
}

/**
 * SSE（fetch + Bearer，非 EventSource，03 §6）。返回 close()。断线按退避自动重连。
 */
export function connectEvents(opts: EventStreamOptions): { close(): void } {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const backoff = opts.backoffMs ?? [1000, 2000, 5000, 10000, 30000];
  let closed = false;
  let attempt = 0;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (closed) return;
    const ms = backoff[Math.min(attempt, backoff.length - 1)]!;
    attempt += 1;
    timer = setTimeout(run, ms);
  };

  async function run(): Promise<void> {
    if (closed) return;
    ctrl = new AbortController();
    try {
      const token = opts.getAccessToken();
      const res = await f(
        `${opts.baseUrl ?? ''}${API_PREFIX}/events?warehouseId=${encodeURIComponent(opts.warehouseId)}`,
        {
          headers: {
            accept: 'text/event-stream',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          signal: ctrl.signal,
        },
      );
      if (res.status === 401 && opts.refresh && (await opts.refresh())) return void run();
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      attempt = 0;
      opts.onOpen?.();
      const parser = createParser({
        onEvent: (m) => {
          const e = parseEvent(m.event ?? 'message', m.data);
          if (e) opts.onEvent(e);
        },
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.feed(value);
      }
      // 服务端关流（如 token exp）：尝试刷新后重连
      if (!closed && opts.refresh) await opts.refresh().catch(() => false);
      schedule();
    } catch (err) {
      if (closed) return;
      opts.onError?.(err);
      schedule();
    }
  }

  void run();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    },
  };
}
