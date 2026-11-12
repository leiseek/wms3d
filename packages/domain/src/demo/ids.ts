/** 确定性 UUID（v8，RFC 9562 自定义版本）：演示数据在 mock 与 seed 之间共享同一 id。 */
function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export function demoId(name: string): string {
  const hex = [1, 2, 3, 4]
    .map((k) =>
      fnv1a(`wms3d:${name}`, k * 0x9e3779b1)
        .toString(16)
        .padStart(8, '0'),
    )
    .join('');
  const b = hex.split('');
  b[12] = '8';
  b[16] = ((parseInt(b[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = b.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
