/** 极简 RFC 4180 CSV（05 §3；csv-parse 未在依赖中，服务端权威解析在此实现）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let quoted = false;
  let any = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      any = true;
      i++;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
      any = true;
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      any = false;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += ch;
      any = true;
      i++;
    }
  }
  if (any || cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 导出防公式注入（08 §2）：= + - @ TAB CR 开头的单元格前加 '，并按需加引号。 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s.trimStart())) s = `'${s.trimStart()}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 导入时还原导出加的转义前缀（'=cmd → =cmd 按原文保存，导出时再次转义）。 */
export function unescapeCell(s: string): string {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}
