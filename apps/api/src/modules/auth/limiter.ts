/**
 * 登录限流与锁定（03 §2）：5 次/分钟/账号+IP；同一账号连续失败 10 次锁 15 分钟；
 * 失败审计按 IP+账号 1 分钟聚合。单进程部署（ADR-0001），状态在内存（重启清零，书面接受）。
 */
export interface LimiterOptions {
  perMinute?: number;
  maxFailures?: number;
  lockMs?: number;
  now?: () => number;
}

export class LoginLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  private readonly auditBuckets = new Map<string, number>();
  private readonly perMinute: number;
  private readonly maxFailures: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(o: LimiterOptions = {}) {
    this.perMinute = o.perMinute ?? 5;
    this.maxFailures = o.maxFailures ?? 10;
    this.lockMs = o.lockMs ?? 15 * 60_000;
    this.now = o.now ?? Date.now;
  }

  /** 记录一次尝试并判定；返回需要等待的秒数（0 = 放行）。 */
  check(username: string, ip: string): { retryAfterS: number; reason: 'locked' | 'rate' | null } {
    const now = this.now();
    const u = username.toLowerCase();
    const f = this.failures.get(u);
    if (f && f.lockedUntil > now)
      return { retryAfterS: Math.ceil((f.lockedUntil - now) / 1000), reason: 'locked' };
    const key = `${u}|${ip}`;
    const list = (this.attempts.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= this.perMinute) {
      this.attempts.set(key, list);
      return {
        retryAfterS: Math.max(1, Math.ceil((list[0]! + 60_000 - now) / 1000)),
        reason: 'rate',
      };
    }
    list.push(now);
    this.attempts.set(key, list);
    this.gc(now);
    return { retryAfterS: 0, reason: null };
  }

  /** 失败一次；达到阈值时锁定并返回 true。 */
  fail(username: string): boolean {
    const u = username.toLowerCase();
    const f = this.failures.get(u) ?? { count: 0, lockedUntil: 0 };
    f.count += 1;
    let locked = false;
    if (f.count >= this.maxFailures) {
      f.lockedUntil = this.now() + this.lockMs;
      f.count = 0;
      locked = true;
    }
    this.failures.set(u, f);
    return locked;
  }

  succeed(username: string): void {
    this.failures.delete(username.toLowerCase());
  }

  /** 失败审计聚合：同 IP+账号每分钟只写一条。 */
  shouldAuditFailure(username: string, ip: string): boolean {
    const key = `${username.toLowerCase()}|${ip}`;
    const minute = Math.floor(this.now() / 60_000);
    if (this.auditBuckets.get(key) === minute) return false;
    this.auditBuckets.set(key, minute);
    return true;
  }

  private gc(now: number): void {
    if (this.attempts.size < 5000) return;
    for (const [k, v] of this.attempts)
      if (!v.some((t) => now - t < 60_000)) this.attempts.delete(k);
    for (const [k, v] of this.failures)
      if (v.lockedUntil < now && v.count === 0) this.failures.delete(k);
    this.auditBuckets.clear();
  }
}
