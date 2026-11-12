import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCollectionFont } from './ttc.ts';

/** 系统已安装的 Noto Sans CJK，SC Regular 在集合中的索引为 2（见 fc-list / fontTools）。 */
const FONT_CANDIDATES = [
  process.env['WMS_LABEL_FONT'],
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
].filter((p): p is string => !!p);

const SC_FACE_INDEX = 2;
const FONT_NAME = 'NotoSansSC';
/** 抽出的 SC Regular 约 16MB；过小说明写入被截断。 */
const MIN_FONT_BYTES = 1_000_000;

export class LabelFontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelFontError';
  }
}

let cachedPath: string | undefined;

function cachePathFor(src: string): string {
  const st = statSync(src);
  const id = createHash('sha1')
    .update(`${src}:${st.size}:${st.mtimeMs}:${SC_FACE_INDEX}`)
    .digest('hex')
    .slice(0, 16);
  return join(tmpdir(), 'wms3d-labels-fonts', `NotoSansSC-Regular-${id}.otf`);
}

function isUsableFont(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).size >= MIN_FONT_BYTES;
  } catch {
    return false;
  }
}

/** 返回可供 pdfkit 注册的 Noto Sans SC Regular 文件路径（必要时从 TTC 抽出并缓存）。 */
export function resolveLabelFontPath(): string {
  if (cachedPath && isUsableFont(cachedPath)) return cachedPath;
  const src = FONT_CANDIDATES.find((p) => existsSync(p));
  if (!src) {
    throw new LabelFontError(
      '找不到开源中文字体 Noto Sans CJK SC。请在系统安装 fonts-noto-cjk，或设置环境变量 WMS_LABEL_FONT 指向 OTF/TTF/TTC。',
    );
  }
  const dest = cachePathFor(src);
  if (!isUsableFont(dest)) {
    const data = readFileSync(src);
    const face = extractCollectionFont(
      data,
      src.toLowerCase().endsWith('.ttc') ? SC_FACE_INDEX : 0,
    );
    mkdirSync(join(tmpdir(), 'wms3d-labels-fonts'), { recursive: true });
    const tmp = `${dest}.${process.pid}-${Date.now().toString(36)}.tmp`;
    writeFileSync(tmp, face);
    try {
      renameSync(tmp, dest);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* 另一进程已就位 */
      }
      if (!isUsableFont(dest)) {
        throw new LabelFontError('写入中文字体缓存失败');
      }
    }
  }
  cachedPath = dest;
  return dest;
}

export const LABEL_FONT_NAME = FONT_NAME;

/** 在测试中重置缓存（不删除文件）。 */
export function resetFontCache(): void {
  cachedPath = undefined;
}
