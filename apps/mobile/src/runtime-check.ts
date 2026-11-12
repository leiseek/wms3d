/** 运行时特性检测（docs/04-mobile.md §1）。WebGL2 不在此处强制：缺失时 3D 降级为 2D（06 §7）。 */
export function checkRuntime(): string[] {
  const missing: string[] = [];
  if (!('at' in Array.prototype)) missing.push('Array.prototype.at');
  if (typeof globalThis.structuredClone !== 'function') missing.push('structuredClone');
  if (typeof globalThis.crypto?.getRandomValues !== 'function')
    missing.push('crypto.getRandomValues');
  if (typeof globalThis.indexedDB === 'undefined') missing.push('indexedDB');
  return missing;
}
