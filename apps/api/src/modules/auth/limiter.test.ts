import { describe, expect, it } from 'vitest';
import { LoginLimiter } from './limiter.ts';

describe('LoginLimiter', () => {
  it('5 次/分钟/账号+IP，窗口滑动后恢复', () => {
    let t = 0;
    const l = new LoginLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) expect(l.check('u', 'ip').reason).toBeNull();
    expect(l.check('u', 'ip')).toMatchObject({ reason: 'rate', retryAfterS: 60 });
    expect(l.check('u', 'ip2').reason).toBeNull();
    t = 60_001;
    expect(l.check('u', 'ip').reason).toBeNull();
  });
  it('连续 10 次失败锁 15 分钟（不分 IP、不分大小写）；成功清零', () => {
    let t = 0;
    const l = new LoginLimiter({ now: () => t });
    for (let i = 0; i < 9; i++) expect(l.fail('Op1')).toBe(false);
    l.succeed('op1');
    for (let i = 0; i < 9; i++) l.fail('op1');
    expect(l.fail('OP1')).toBe(true);
    expect(l.check('op1', 'any')).toMatchObject({ reason: 'locked', retryAfterS: 900 });
    t = 15 * 60_000 + 1;
    expect(l.check('op1', 'any').reason).toBeNull();
  });
  it('失败审计按分钟聚合', () => {
    let t = 0;
    const l = new LoginLimiter({ now: () => t });
    expect(l.shouldAuditFailure('u', 'ip')).toBe(true);
    expect(l.shouldAuditFailure('u', 'ip')).toBe(false);
    t = 60_000;
    expect(l.shouldAuditFailure('u', 'ip')).toBe(true);
  });
});
