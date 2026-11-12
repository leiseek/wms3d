/** 浏览器下载（Blob / 文本）。 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(text: string, filename: string, type = 'text/csv;charset=utf-8') {
  downloadBlob(new Blob([text], { type }), filename);
}

/** 从 Content-Disposition 取文件名（缺省用 fallback）。 */
export function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
  if (star) return decodeURIComponent(star);
  return /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? fallback;
}
