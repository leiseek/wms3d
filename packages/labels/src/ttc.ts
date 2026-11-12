import { Buffer } from 'node:buffer';

/**
 * 从 TrueType/OpenType Collection（.ttc / .otc）中抽出第 `index` 个独立字体。
 * 会把可能共享的表复制进新文件，得到可被 pdfkit/fontkit 打开的 OTF/TTF。
 */
export function extractCollectionFont(data: Uint8Array, index: number): Uint8Array {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 16) throw new Error('字体文件过短');
  const tag = buf.subarray(0, 4).toString('ascii');
  if (tag !== 'ttcf') {
    // 已经是单字体，直接返回
    return data;
  }
  const numFonts = buf.readUInt32BE(8);
  if (!Number.isInteger(index) || index < 0 || index >= numFonts) {
    throw new Error(`字体集合共 ${numFonts} 个面孔，无效索引 ${index}`);
  }
  const fontOffset = buf.readUInt32BE(12 + index * 4);
  if (fontOffset + 12 > buf.length) throw new Error('字体表目录越界');
  const numTables = buf.readUInt16BE(fontOffset + 4);
  const recordsStart = fontOffset + 12;
  type Rec = { tag: Buffer; checksum: number; offset: number; length: number };
  const tables: Rec[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = recordsStart + i * 16;
    tables.push({
      tag: buf.subarray(o, o + 4),
      checksum: buf.readUInt32BE(o + 4),
      offset: buf.readUInt32BE(o + 8),
      length: buf.readUInt32BE(o + 12),
    });
  }

  const headerSize = 12 + 16 * numTables;
  let cursor = headerSize;
  const placements = tables.map((t) => {
    const offset = cursor;
    cursor += (t.length + 3) & ~3;
    return { ...t, newOffset: offset };
  });

  const out = Buffer.alloc(cursor);
  buf.copy(out, 0, fontOffset, fontOffset + 12);
  for (let i = 0; i < placements.length; i++) {
    const t = placements[i]!;
    const o = 12 + i * 16;
    t.tag.copy(out, o);
    out.writeUInt32BE(t.checksum, o + 4);
    out.writeUInt32BE(t.newOffset, o + 8);
    out.writeUInt32BE(t.length, o + 12);
    if (t.offset + t.length > buf.length) throw new Error(`表 ${t.tag.toString()} 越界`);
    buf.copy(out, t.newOffset, t.offset, t.offset + t.length);
  }
  return new Uint8Array(out);
}
