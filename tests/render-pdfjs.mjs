import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [pdfPath, outputPrefix, modulesDir] = process.argv.slice(2);
if (!pdfPath || !outputPrefix || !modulesDir) {
  throw new Error("Usage: node render-pdfjs.mjs <pdf> <output-prefix> <node-modules-dir>");
}

const require = createRequire(path.join(modulesDir, "package.json"));
const canvasLibrary = require("@napi-rs/canvas");
globalThis.DOMMatrix = canvasLibrary.DOMMatrix;
globalThis.ImageData = canvasLibrary.ImageData;
globalThis.Path2D = canvasLibrary.Path2D;

const pdfjsPath = path.join(modulesDir, "pdfjs-dist", "legacy", "build", "pdf.mjs");
const pdfjs = await import(pathToFileURL(pdfjsPath).href);
const data = new Uint8Array(await readFile(pdfPath));
const document = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;

for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.6 });
  const canvas = canvasLibrary.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  await writeFile(`${outputPrefix}-${pageNumber}.png`, canvas.toBuffer("image/png"));
}

process.stdout.write(`PDFJS_RENDER_OK pages=${document.numPages}\n`);
