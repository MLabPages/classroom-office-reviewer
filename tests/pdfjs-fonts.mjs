import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vendorRoot = path.join(root, "extension", "vendor");
const viewer = await readFile(path.join(root, "extension", "viewer.js"), "utf8");
const manifest = JSON.parse(await readFile(path.join(root, "extension", "manifest.json"), "utf8"));

assert(viewer.includes('cMapUrl: chrome.runtime.getURL("vendor/cmaps/")')
  || viewer.includes("cMapUrl,"));
assert(viewer.includes("cMapPacked: true"));
assert(viewer.includes('standardFontDataUrl: chrome.runtime.getURL("vendor/standard_fonts/")')
  || viewer.includes("standardFontDataUrl"));
assert(manifest.web_accessible_resources.some((entry) => entry.resources.includes("vendor/cmaps/*")));
assert(manifest.web_accessible_resources.some((entry) => entry.resources.includes("vendor/standard_fonts/*")));

const cMapPath = path.join(vendorRoot, "cmaps", "UniJIS-UCS2-H.bcmap");
const standardFontPath = path.join(vendorRoot, "standard_fonts", "FoxitSerif.pfb");
await readFile(cMapPath);
await readFile(standardFontPath);

// PDF.jsのブラウザ用ビルドをNodeで解析テストするための最小DOMMatrix。
// 実際の拡張機能ではChromeが提供するDOMMatrixを使う。
globalThis.DOMMatrix = class DOMMatrix {
  constructor() {
    this.a = 1;
    this.b = 0;
    this.c = 0;
    this.d = 1;
    this.e = 0;
    this.f = 0;
  }
};
if (!Uint8Array.prototype.toHex) {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value() { return [...this].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
  });
}
if (!Uint8Array.prototype.toBase64) {
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value() { return Buffer.from(this).toString("base64"); }
  });
}
if (!Uint8Array.fromBase64) {
  Uint8Array.fromBase64 = (value) => new Uint8Array(Buffer.from(value, "base64"));
}
if (!Map.prototype.getOrInsertComputed) {
  Map.prototype.getOrInsertComputed = function getOrInsertComputed(key, callback) {
    if (!this.has(key)) this.set(key, callback(key));
    return this.get(key);
  };
}

function buildJapaneseCidPdf() {
  const encoder = new TextEncoder();
  const content = "BT /F1 28 Tf 30 120 Td <65E5672C8A9E> Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>",
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /DW 1000 /W [1 [1000 1000 1000]] >>"
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(encoder.encode(source).length);
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(source).length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(source);
}

const pdfjs = await import(pathToFileURL(path.join(vendorRoot, "pdf.mjs")).href);
const document = await pdfjs.getDocument({
  data: buildJapaneseCidPdf(),
  cMapUrl: pathToFileURL(`${path.join(vendorRoot, "cmaps")}${path.sep}`).href,
  cMapPacked: true,
  standardFontDataUrl: pathToFileURL(`${path.join(vendorRoot, "standard_fonts")}${path.sep}`).href,
  isEvalSupported: false,
  useSystemFonts: false
}).promise;
const page = await document.getPage(1);
await page.getOperatorList();
const textContent = await page.getTextContent();
assert(textContent.items.length > 0, "日本語CIDフォントPDFのテキストを読み取れませんでした。");

console.log("PDF.js Japanese CID font resource and rendering test passed.");
