// 追加ライブラリを使わずにZIPを作る。ブラウザ標準の CompressionStream と
// Blob だけを使い、1件ずつ書き出してメモリの山を作らない。
//
// 対応範囲: 通常のZIP（ZIP64なし）。1ファイル4GB未満・合計4GB未満・
// 65535件未満。これを超える場合は呼び出し側でエラーとして記録する。

const ZIP_LIMIT = 0xffffffff;
const ENTRY_LIMIT = 0xffff;
// 生データをためすぎないよう、この大きさごとにBlobへ移す。
const FLUSH_BYTES = 4 * 1024 * 1024;
// すでに圧縮済みの形式は、もう一度縮めても効果がなく時間だけ増える。
const ALREADY_COMPRESSED = /\.(?:zip|docx|xlsx|pptx|pdf|jpg|jpeg|png|gif|webp|mp4|mov|m4v|mp3|m4a|7z|rar|heic|avi|wmv)$/i;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(chunk, seed = 0) {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let index = 0; index < chunk.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function shouldStore(fileName) {
  return ALREADY_COMPRESSED.test(String(fileName || ""));
}

function dosDateTime(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, value.getFullYear());
  return {
    time: ((value.getHours() & 0x1f) << 11) | ((value.getMinutes() & 0x3f) << 5) | ((value.getSeconds() / 2) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((value.getMonth() + 1) & 0x0f) << 5) | (value.getDate() & 0x1f)
  };
}

// たまったデータを一定量ごとにBlobへ移す入れ物。JS側の使用量を抑える。
class ChunkSink {
  constructor() {
    this.blobs = [];
    this.pending = [];
    this.pendingBytes = 0;
    this.size = 0;
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    // 元の配列を保持し続けないよう、必要な範囲だけを写して持つ。
    this.pending.push(chunk.slice());
    this.pendingBytes += chunk.length;
    this.size += chunk.length;
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    this.blobs.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  finish() {
    this.flush();
    return this.blobs;
  }
}

async function* iterateChunks(source) {
  if (!source) return;
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (typeof source.getReader === "function") {
    const reader = source.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  if (typeof source.stream === "function") {
    yield* iterateChunks(source.stream());
    return;
  }
  if (source instanceof ArrayBuffer) {
    yield new Uint8Array(source);
    return;
  }
  throw new TypeError("ZIPへ追加できない形式のデータです。");
}

// 入力を読みながらCRCを計算し、必要なら deflate して受け皿へ流す。
async function consume(source, { compress }) {
  const sink = new ChunkSink();
  let crc = 0;
  let rawSize = 0;
  if (!compress) {
    for await (const chunk of iterateChunks(source)) {
      crc = crc32(chunk, crc);
      rawSize += chunk.length;
      sink.push(chunk);
    }
    return { crc, rawSize, blobs: sink.finish(), storedSize: sink.size };
  }

  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // 書き込みと読み出しを同時に動かす。片方だけ進めると詰まって止まる。
  let pumpError = null;
  const pump = (async () => {
    try {
      for await (const chunk of iterateChunks(source)) {
        crc = crc32(chunk, crc);
        rawSize += chunk.length;
        await writer.ready;
        await writer.write(chunk);
      }
      await writer.close();
    } catch (error) {
      // 取り込み側が失敗したまま閉じないと、読み出し側が永久に待ってしまう。
      pumpError = error;
      await writer.abort(error).catch(() => undefined);
    }
  })();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sink.push(value instanceof Uint8Array ? value : new Uint8Array(value));
    }
  } catch (error) {
    await pump;
    throw pumpError || error;
  }
  await pump;
  if (pumpError) throw pumpError;
  return { crc, rawSize, blobs: sink.finish(), storedSize: sink.size };
}

export class ZipBuilder {
  constructor() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
  }

  get size() {
    return this.offset;
  }

  // path はZIP内のパス（例: 課題名_提出物/1234567_課題名_レポート.docx）
  async addFile(path, source, { date = new Date(), compress = null } = {}) {
    if (this.entries.length >= ENTRY_LIMIT) {
      throw new Error("ZIPへ入れられる件数の上限（65535件）を超えました。");
    }
    const nameBytes = new TextEncoder().encode(path);
    const useCompression = compress === null ? !shouldStore(path) : compress === true;
    const { crc, rawSize, blobs, storedSize } = await consume(source, { compress: useCompression });
    if (rawSize > ZIP_LIMIT || storedSize > ZIP_LIMIT) {
      throw new Error("1ファイルが4GBを超えるため、ZIPへ入れられませんでした。");
    }
    if (this.offset + storedSize + nameBytes.length + 30 > ZIP_LIMIT) {
      throw new Error("ZIP全体が4GBに達したため、これ以上追加できません。");
    }

    const stamp = dosDateTime(date);
    const method = useCompression ? 8 : 0;
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    // ビット11＝ファイル名がUTF-8であることの合図。日本語名が化けない。
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, method, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, storedSize, true);
    view.setUint32(22, rawSize, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    this.parts.push(header);
    for (const blob of blobs) this.parts.push(blob);
    this.entries.push({
      nameBytes,
      crc,
      rawSize,
      storedSize,
      method,
      time: stamp.time,
      date: stamp.date,
      offset: this.offset
    });
    this.offset += header.length + storedSize;
    return { path, rawSize, storedSize, compressed: useCompression };
  }

  // 文字列はそのままUTF-8で入れる。CSVなどのBOMは呼び出し側で付ける。
  addText(path, text, options = {}) {
    return this.addFile(path, new TextEncoder().encode(String(text ?? "")), options);
  }

  finish(mimeType = "application/zip") {
    const centralParts = [];
    let centralSize = 0;
    for (const entry of this.entries) {
      const record = new Uint8Array(46 + entry.nameBytes.length);
      const view = new DataView(record.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0x0800, true);
      view.setUint16(10, entry.method, true);
      view.setUint16(12, entry.time, true);
      view.setUint16(14, entry.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.storedSize, true);
      view.setUint32(24, entry.rawSize, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, entry.offset, true);
      record.set(entry.nameBytes, 46);
      centralParts.push(record);
      centralSize += record.length;
    }
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, this.entries.length, true);
    endView.setUint16(10, this.entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, this.offset, true);
    endView.setUint16(20, 0, true);
    return new Blob([...this.parts, ...centralParts, end], { type: mimeType });
  }
}
