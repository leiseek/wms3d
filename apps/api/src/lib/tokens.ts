import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';
import { AccessClaims } from '@wms3d/contracts';

/** access token 15 分钟（03 §2）；refresh 30 天；同设备宽限 60s（B-N13）。 */
export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_S = 30 * 24 * 3600;
export const REFRESH_GRACE_S = 60;

export interface JwtKeyring {
  currentKid: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

const enc = new TextEncoder();

/**
 * 密钥环（JWT HS256 + kid 轮换，08 §2）：
 * - JWT_SECRET（≥ 32 字符）+ JWT_KID（默认 k1）= 当前签名密钥；
 * - JWT_PREVIOUS_KEYS="kid:secret,kid2:secret2" = 仅用于校验的旧密钥（轮换期内旧 token 仍有效）。
 * 非 production 且未配置时生成进程内随机密钥（重启后旧 token 失效）；production 未配置直接报错。
 */
export function keyringFromEnv(env: NodeJS.ProcessEnv, nodeEnv: string): JwtKeyring {
  const keys = new Map<string, Uint8Array>();
  const kid = env.JWT_KID?.trim() || 'k1';
  let secret = env.JWT_SECRET;
  if (!secret) {
    if (nodeEnv === 'production') throw new Error('production 必须配置 JWT_SECRET');
    secret = randomBytes(32).toString('base64url');
  }
  if (secret.length < 32) throw new Error('JWT_SECRET 至少 32 个字符');
  keys.set(kid, enc.encode(secret));
  for (const part of (env.JWT_PREVIOUS_KEYS ?? '').split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const s = part.slice(i + 1).trim();
    if (k && s.length >= 32 && !keys.has(k)) keys.set(k, enc.encode(s));
  }
  return { currentKid: kid, keys };
}

export type AccessInput = Omit<AccessClaims, 'exp' | 'iat'>;

export async function signAccess(ring: JwtKeyring, c: AccessInput): Promise<string> {
  return new SignJWT({ role: c.role, wh: c.wh, did: c.did, sid: c.sid })
    .setProtectedHeader({ alg: 'HS256', kid: ring.currentKid, typ: 'JWT' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .sign(ring.keys.get(ring.currentKid)!);
}

/** 校验签名/过期/claims 结构；任何失败返回 null。 */
export async function verifyAccess(ring: JwtKeyring, token: string): Promise<AccessClaims | null> {
  try {
    const { kid, alg } = decodeProtectedHeader(token);
    if (alg !== 'HS256' || typeof kid !== 'string') return null;
    const key = ring.keys.get(kid);
    if (!key) return null;
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    const r = AccessClaims.safeParse(payload);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** 刷新令牌：不透明随机串，服务端只存 sha256。 */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
