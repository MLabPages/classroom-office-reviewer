import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { allowedOrigin as isAllowedOrigin, extensionIdFromManifestKey } from "./extension-origin.mjs";

const execFileAsync = promisify(execFile);
const nativeDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(nativeDir);
// 更新用のフォルダとは分ける。ここに置けば、補助アプリや拡張機能を入れ替えても
// 変換済みPDF・ログ・未完了キューは残る。
const dataDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || rootDir, "ClassroomReviewer");
const cacheDir = path.join(dataDir, "cache");
const temporaryDir = path.join(dataDir, "temporary");
const logsDir = path.join(dataDir, "logs");
const queuePath = path.join(dataDir, "settings", "conversion-queue.json");
const pidFile = path.join(logsDir, "reviewer.pid");
const wordConverterPath = path.join(nativeDir, "Convert-Word.ps1");
const powerPointConverterPath = path.join(nativeDir, "Convert-PowerPoint.ps1");
const wordWindowHostPath = path.join(nativeDir, "Word-Window-Host.ps1");
const powerPointWindowHostPath = path.join(nativeDir, "PowerPoint-Window-Host.ps1");
const host = "127.0.0.1";
const port = 18765;
const serviceSessionId = crypto.randomUUID();
const manifestPath = path.join(rootDir, "extension", "manifest.json");
let appVersion = "unknown";
let allowedExtensionId = "";
const cacheWarningBytes = 10 * 1024 * 1024 * 1024;
const staleTemporaryAgeMs = 24 * 60 * 60 * 1000;
let queue = Promise.resolve();
let officeWindowQueue = Promise.resolve();
let wordHost = null;
let wordHostSequence = 0;
let currentWordPath = "";
const wordHostRequests = new Map();
let powerPointHost = null;
let powerPointHostSequence = 0;
let currentPowerPointPath = "";
const powerPointHostRequests = new Map();
let shuttingDown = false;
const pdfIndex = new Map();

try {
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  appVersion = manifest.version || appVersion;
  allowedExtensionId = extensionIdFromManifestKey(manifest.key);
} catch {
  // Health still responds when the source manifest cannot be read.
}

await fsp.mkdir(cacheDir, { recursive: true });
await fsp.mkdir(temporaryDir, { recursive: true });
await fsp.mkdir(logsDir, { recursive: true });
await fsp.mkdir(path.dirname(queuePath), { recursive: true });
await fsp.writeFile(pidFile, String(process.pid), "utf8");
await loadPdfIndex();
await pruneTemporaryFiles();

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function allowedOrigin(origin) {
  return isAllowedOrigin(origin, allowedExtensionId);
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin && allowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-File-Name, X-CWR-Cache-Identity, X-CWR-Source-Metadata, X-CWR-Force");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("要求データが大きすぎます。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readBuffer(req, maximumSize) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximumSize) throw new Error("提出物が100MBを超えています。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function safeSegment(value, fallback) {
  const normalized = String(value || "").trim();
  if (/^[A-Za-z0-9_-]{1,160}$/.test(normalized)) return normalized;
  if (!normalized) return fallback;
  return `${fallback}-${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

function normalizeCacheIdentity(value, fallbackFileId = "") {
  const input = value && typeof value === "object" ? value : {};
  return {
    courseId: safeSegment(input.courseId, "unknown-course"),
    assignmentId: safeSegment(input.assignmentId, "unknown-assignment"),
    submissionId: safeSegment(input.submissionId, "unknown-submission"),
    fileId: safeSegment(input.fileId || fallbackFileId, "unknown-file")
  };
}

function cacheSlot(identity) {
  const normalized = normalizeCacheIdentity(identity);
  const directory = path.join(cacheDir, normalized.courseId, normalized.assignmentId, normalized.submissionId, normalized.fileId);
  return {
    identity: normalized,
    directory,
    pdfPath: path.join(directory, "current.pdf"),
    metaPath: path.join(directory, "metadata.json"),
    previousPdfPath: path.join(directory, "previous.pdf"),
    previousMetaPath: path.join(directory, "previous-metadata.json")
  };
}

function parseHeaderJson(value) {
  if (typeof value !== "string" || !value) return {};
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return {};
  }
}

async function isValidPdf(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) return false;
    const handle = await fsp.open(filePath, "r");
    try {
      const header = Buffer.alloc(5);
      await handle.read(header, 0, header.length, 0);
      return header.toString("latin1") === "%PDF-";
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function cacheResult(metadata, cached = true) {
  return {
    ...metadata,
    ok: true,
    pdfUrl: `/file/${metadata.pdfId}.pdf`,
    cached
  };
}

async function readCachedPdf(identity) {
  const slot = cacheSlot(identity);
  try {
    const metadata = JSON.parse(await fsp.readFile(slot.metaPath, "utf8"));
    if (!metadata?.pdfId || !await isValidPdf(slot.pdfPath)) return null;
    metadata.lastAccessedAt = new Date().toISOString();
    await fsp.writeFile(slot.metaPath, JSON.stringify(metadata, null, 2), "utf8");
    pdfIndex.set(metadata.pdfId, slot.pdfPath);
    return cacheResult(metadata, true);
  } catch {
    return null;
  }
}

async function writeCachedPdf(slot, generatedPdfPath, metadata) {
  if (!await isValidPdf(generatedPdfPath)) {
    throw new Error("PDF変換後のファイルが壊れているため保存しませんでした。");
  }
  await fsp.mkdir(slot.directory, { recursive: true });
  if (await isValidPdf(slot.pdfPath)) {
    await fsp.rm(slot.previousPdfPath, { force: true }).catch(() => undefined);
    await fsp.rm(slot.previousMetaPath, { force: true }).catch(() => undefined);
    await fsp.rename(slot.pdfPath, slot.previousPdfPath).catch(() => undefined);
    await fsp.rename(slot.metaPath, slot.previousMetaPath).catch(() => undefined);
  }
  await fsp.rename(generatedPdfPath, slot.pdfPath);
  await fsp.writeFile(slot.metaPath, JSON.stringify(metadata, null, 2), "utf8");
  pdfIndex.set(metadata.pdfId, slot.pdfPath);
}

async function walkMetadata(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const metadataPaths = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) metadataPaths.push(...await walkMetadata(entryPath));
    else if (entry.isFile() && entry.name === "metadata.json") metadataPaths.push(entryPath);
  }
  return metadataPaths;
}

async function loadPdfIndex() {
  for (const metaPath of await walkMetadata(cacheDir)) {
    try {
      const metadata = JSON.parse(await fsp.readFile(metaPath, "utf8"));
      const pdfPath = path.join(path.dirname(metaPath), "current.pdf");
      if (metadata?.pdfId && await isValidPdf(pdfPath)) pdfIndex.set(metadata.pdfId, pdfPath);
    } catch {
      // 壊れたメタデータは再利用せず、整理操作の対象にする。
    }
  }
}

async function pruneTemporaryFiles() {
  const cutoff = Date.now() - staleTemporaryAgeMs;
  const entries = await fsp.readdir(temporaryDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const target = path.join(temporaryDir, entry.name);
    const stat = await fsp.stat(target).catch(() => null);
    if (stat?.mtimeMs < cutoff || /\.part$/i.test(entry.name)) await fsp.rm(target, { force: true }).catch(() => undefined);
  }));
}

async function cacheSummary() {
  const items = [];
  let totalBytes = 0;
  for (const metaPath of await walkMetadata(cacheDir)) {
    try {
      const metadata = JSON.parse(await fsp.readFile(metaPath, "utf8"));
      const pdfPath = path.join(path.dirname(metaPath), "current.pdf");
      const stat = await fsp.stat(pdfPath);
      if (!metadata?.identity || !await isValidPdf(pdfPath)) continue;
      totalBytes += stat.size;
      items.push({ identity: metadata.identity, bytes: stat.size, lastAccessedAt: metadata.lastAccessedAt || metadata.convertedAt || "" });
    } catch {
      // 整理時に改めて扱う。
    }
  }
  const byAssignment = new Map();
  for (const item of items) {
    const key = `${item.identity.courseId}|${item.identity.assignmentId}`;
    const entry = byAssignment.get(key) || { courseId: item.identity.courseId, assignmentId: item.identity.assignmentId, bytes: 0, files: 0 };
    entry.bytes += item.bytes;
    entry.files += 1;
    byAssignment.set(key, entry);
  }
  return { ok: true, dataDir, totalBytes, files: items.length, warning: totalBytes >= cacheWarningBytes, assignments: [...byAssignment.values()] };
}

async function convertOffice(sourcePath, displayName = path.basename(sourcePath), options = {}) {
  const absolute = path.resolve(sourcePath);
  const extension = path.extname(absolute).toLowerCase();
  if (!new Set([".doc", ".docx", ".ppt", ".pptx"]).has(extension)) {
    throw new Error("Word／PowerPointファイルだけを処理できます。");
  }
  const stat = await fsp.stat(absolute);
  if (!stat.isFile()) throw new Error("提出物ファイルを読み込めません。");

  const sourceHash = await hashFile(absolute);
  const slot = cacheSlot(options.identity || { fileId: sourceHash.slice(0, 24) });
  const existing = await readCachedPdf(slot.identity);
  if (!options.force && existing?.sourceHash === sourceHash) return { ...existing, sourceName: displayName };

  const converterPath = new Set([".ppt", ".pptx"]).has(extension)
    ? powerPointConverterPath
    : wordConverterPath;
  const temporaryPdf = path.join(temporaryDir, `conversion-${crypto.randomUUID()}.pdf.part`);
  const startedAt = Date.now();
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", converterPath,
      "-SourcePath", absolute,
      "-TargetPath", temporaryPdf
    ], {
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8"
    }));
  } catch (error) {
    log(`conversion failed file=${displayName} code=${error.code ?? "unknown"} elapsedMs=${Date.now() - startedAt} stderr=${String(error.stderr || "").slice(-1000)}`);
    await fsp.rm(temporaryPdf, { force: true }).catch(() => undefined);
    throw new Error(`PDF変換に失敗しました。${error.killed ? "処理時間が2分を超えました。" : "Officeでこのファイルを開けるか確認してください。"}`);
  }

  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const conversion = JSON.parse(lines.at(-1) || "{}");
  if (!conversion.ok) {
    await fsp.rm(temporaryPdf, { force: true }).catch(() => undefined);
    throw new Error(conversion.error || "Office変換に失敗しました。");
  }

  const metadata = {
    ok: true,
    pdfId: crypto.createHash("sha256").update(`${JSON.stringify(slot.identity)}|${sourceHash}`).digest("hex").slice(0, 24),
    sourceName: displayName,
    sourceSize: stat.size,
    sourceHash,
    sourceModifiedTime: options.sourceMetadata?.lastModified || null,
    sourceETag: options.sourceMetadata?.etag || null,
    identity: slot.identity,
    pageCount: conversion.pageCount || null,
    convertedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString()
  };
  try {
    await writeCachedPdf(slot, temporaryPdf, metadata);
    log(`conversion complete file=${displayName} elapsedMs=${Date.now() - startedAt} cache=${metadata.pdfId}`);
    return cacheResult(metadata, false);
  } finally {
    await fsp.rm(temporaryPdf, { force: true }).catch(() => undefined);
  }
}

async function storePdfBuffer(body, displayName, options = {}) {
  if (!body.length) throw new Error("PDFのデータが空です。");
  if (body.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("PDF形式のデータではありません。");
  const sourceHash = options.sourceMetadata?.sourceHash || crypto.createHash("sha256").update(body).digest("hex");
  const slot = cacheSlot(options.identity || { fileId: sourceHash.slice(0, 24) });
  const existing = await readCachedPdf(slot.identity);
  if (!options.force && existing?.sourceHash === sourceHash) return { ...existing, sourceName: displayName };
  const temporaryPdf = path.join(temporaryDir, `pdf-${crypto.randomUUID()}.pdf.part`);
  await fsp.writeFile(temporaryPdf, body);
  const metadata = {
    ok: true,
    pdfId: crypto.createHash("sha256").update(`${JSON.stringify(slot.identity)}|${sourceHash}`).digest("hex").slice(0, 24),
    sourceName: displayName,
    sourceSize: options.sourceMetadata?.sourceSize || body.length,
    sourceHash,
    sourceModifiedTime: options.sourceMetadata?.lastModified || null,
    sourceETag: options.sourceMetadata?.etag || null,
    identity: slot.identity,
    pageCount: null,
    convertedAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString()
  };
  try {
    await writeCachedPdf(slot, temporaryPdf, metadata);
    return cacheResult(metadata, false);
  } finally {
    await fsp.rm(temporaryPdf, { force: true }).catch(() => undefined);
  }
}

async function cleanupCache({ mode, identity, olderThanDays } = {}) {
  if (mode === "temporary") {
    await pruneTemporaryFiles();
    return cacheSummary();
  }
  const normalized = identity ? normalizeCacheIdentity(identity) : null;
  const metadataPaths = await walkMetadata(cacheDir);
  for (const metaPath of metadataPaths) {
    const directory = path.dirname(metaPath);
    let metadata = null;
    try { metadata = JSON.parse(await fsp.readFile(metaPath, "utf8")); } catch {}
    const matchesAssignment = normalized && metadata?.identity
      && metadata.identity.courseId === normalized.courseId
      && metadata.identity.assignmentId === normalized.assignmentId;
    const unusedBefore = Number.isFinite(olderThanDays)
      && Date.parse(metadata?.lastAccessedAt || metadata?.convertedAt || "") < Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const broken = !metadata || !await isValidPdf(path.join(directory, "current.pdf"));
    if (mode === "all" || (mode === "assignment" && matchesAssignment) || (mode === "unused" && unusedBefore) || (mode === "broken" && broken)) {
      if (metadata?.pdfId) pdfIndex.delete(metadata.pdfId);
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }
  return cacheSummary();
}

function rejectWordHostRequests(error) {
  for (const pending of wordHostRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  wordHostRequests.clear();
}

function ensureWordHost() {
  if (wordHost && !wordHost.killed) return wordHost;

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", wordWindowHostPath
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  wordHost = child;
  child.stdin.setDefaultEncoding("utf8");

  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      log(`word host invalid response: ${line}`);
      return;
    }
    const pending = wordHostRequests.get(String(response.id || ""));
    if (!pending) return;
    clearTimeout(pending.timeout);
    wordHostRequests.delete(String(response.id));
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "Word別ウィンドウを開けませんでした。"));
  });
  child.stderr.on("data", (chunk) => log(`word host: ${String(chunk).trim()}`));
  child.on("error", (error) => rejectWordHostRequests(error));
  child.on("exit", () => {
    rejectWordHostRequests(new Error("Word別ウィンドウ用プロセスが終了しました。"));
    if (wordHost === child) wordHost = null;
    const stalePath = currentWordPath;
    currentWordPath = "";
    if (stalePath) fsp.rm(stalePath, { force: true }).catch(() => undefined);
  });
  return child;
}

function sendWordHostCommand(action, filePath = "") {
  const child = ensureWordHost();
  const id = String(++wordHostSequence);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wordHostRequests.delete(id);
      reject(new Error("Word別ウィンドウの応答がありません。"));
    }, 30000);
    wordHostRequests.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, action, path: filePath })}\n`, "utf8", (error) => {
      if (!error) return;
      clearTimeout(timeout);
      wordHostRequests.delete(id);
      reject(error);
    });
  });
}

async function openWordWindow(body, safeName) {
  await stopPowerPointHost();
  const extension = path.extname(safeName).toLowerCase();
  const temporaryPath = path.join(temporaryDir, `.word-window-${crypto.randomUUID()}${extension}`);
  await fsp.writeFile(temporaryPath, body);
  try {
    const response = await sendWordHostCommand("open", temporaryPath);
    if (response.closedPath && response.closedPath !== temporaryPath) {
      await fsp.rm(response.closedPath, { force: true }).catch(() => undefined);
    }
    currentWordPath = temporaryPath;
    return { ok: true, sourceName: safeName };
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function closeWordWindow() {
  if (!wordHost) {
    if (currentWordPath) await fsp.rm(currentWordPath, { force: true }).catch(() => undefined);
    currentWordPath = "";
    return { ok: true };
  }
  await stopWordHost();
  return { ok: true };
}

async function stopWordHost() {
  if (!wordHost) {
    if (currentWordPath) await fsp.rm(currentWordPath, { force: true }).catch(() => undefined);
    currentWordPath = "";
    return;
  }
  try {
    const response = await sendWordHostCommand("quit");
    const closedPath = response.closedPath || currentWordPath;
    if (closedPath) await fsp.rm(closedPath, { force: true }).catch(() => undefined);
  } catch {
    wordHost.kill();
  }
  currentWordPath = "";
  wordHost = null;
}

function rejectPowerPointHostRequests(error) {
  for (const pending of powerPointHostRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  powerPointHostRequests.clear();
}

function ensurePowerPointHost() {
  if (powerPointHost && !powerPointHost.killed) return powerPointHost;
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", powerPointWindowHostPath
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  powerPointHost = child;
  child.stdin.setDefaultEncoding("utf8");

  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      log(`powerpoint host invalid response: ${line}`);
      return;
    }
    const pending = powerPointHostRequests.get(String(response.id || ""));
    if (!pending) return;
    clearTimeout(pending.timeout);
    powerPointHostRequests.delete(String(response.id));
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error || "PowerPoint発表画面を開けませんでした。"));
  });
  child.stderr.on("data", (chunk) => log(`powerpoint host: ${String(chunk).trim()}`));
  child.on("error", (error) => rejectPowerPointHostRequests(error));
  child.on("exit", () => {
    rejectPowerPointHostRequests(new Error("PowerPoint発表用プロセスが終了しました。"));
    if (powerPointHost === child) powerPointHost = null;
    const stalePath = currentPowerPointPath;
    currentPowerPointPath = "";
    if (stalePath) fsp.rm(stalePath, { force: true }).catch(() => undefined);
  });
  return child;
}

function sendPowerPointHostCommand(action, filePath = "") {
  const child = ensurePowerPointHost();
  const id = String(++powerPointHostSequence);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      powerPointHostRequests.delete(id);
      reject(new Error("PowerPoint発表画面の応答がありません。"));
    }, 30000);
    powerPointHostRequests.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, action, path: filePath })}\n`, "utf8", (error) => {
      if (!error) return;
      clearTimeout(timeout);
      powerPointHostRequests.delete(id);
      reject(error);
    });
  });
}

async function openPowerPointWindow(body, safeName) {
  await stopWordHost();
  const extension = path.extname(safeName).toLowerCase();
  const temporaryPath = path.join(temporaryDir, `.powerpoint-window-${crypto.randomUUID()}${extension}`);
  await fsp.writeFile(temporaryPath, body);
  try {
    const response = await sendPowerPointHostCommand("open", temporaryPath);
    if (response.closedPath && response.closedPath !== temporaryPath) {
      await fsp.rm(response.closedPath, { force: true }).catch(() => undefined);
    }
    currentPowerPointPath = temporaryPath;
    return { ok: true, sourceName: safeName };
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function stopPowerPointHost() {
  if (!powerPointHost) {
    if (currentPowerPointPath) await fsp.rm(currentPowerPointPath, { force: true }).catch(() => undefined);
    currentPowerPointPath = "";
    return;
  }
  try {
    const response = await sendPowerPointHostCommand("quit");
    const closedPath = response.closedPath || currentPowerPointPath;
    if (closedPath) await fsp.rm(closedPath, { force: true }).catch(() => undefined);
  } catch {
    powerPointHost.kill();
  }
  currentPowerPointPath = "";
  powerPointHost = null;
}

async function closeOfficeWindows() {
  await Promise.all([stopWordHost(), stopPowerPointHost()]);
  return { ok: true };
}

async function releasePdf(pathname) {
  const match = pathname.match(/^\/release\/([a-f0-9]{24})\.pdf$/);
  if (!match) throw new Error("削除対象のPDFが正しくありません。");
  // 閉じた表示枠からの解放要求で、採点済みPDFを消してはいけない。
  // 削除はキャッシュ管理画面から明示的に行う。
  return { ok: true, retained: true };
}

function servePdf(res, pathname) {
  const match = pathname.match(/^\/file\/([a-f0-9]{24})\.pdf$/);
  if (!match) {
    sendJson(res, 404, { ok: false, error: "ファイルが見つかりません。" });
    return;
  }
  const filePath = pdfIndex.get(match[1]);
  if (!filePath) {
    sendJson(res, 404, { ok: false, error: "表示用PDFが見つかりません。" });
    return;
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile() || stat.size <= 0) {
      sendJson(res, 404, { ok: false, error: "表示用PDFが見つかりません。" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": stat.size,
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (!allowedOrigin(req.headers.origin || "")) {
    sendJson(res, 403, { ok: false, error: "この接続元からは利用できません。" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${host}:${port}`);
  if (req.method === "GET" && url.pathname === "/health") {
    const summary = await cacheSummary();
    sendJson(res, 200, { ok: true, service: "Classroom Office Reviewer", version: appVersion, sessionId: serviceSessionId, cachePath: cacheDir, cacheBytes: summary.totalBytes, cacheFiles: summary.files, cacheWarningBytes });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/file/")) {
    servePdf(res, url.pathname);
    return;
  }
  if (req.method === "POST" && url.pathname === "/convert") {
    try {
      const body = await readJson(req);
      if (typeof body.path !== "string" || !body.path) throw new Error("提出物の保存場所が不明です。");
      const job = queue.then(() => convertOffice(body.path, undefined, { identity: body.cacheIdentity, force: body.force === true }));
      queue = job.catch(() => undefined);
      sendJson(res, 200, await job);
    } catch (error) {
      log(`conversion error: ${error.message}`);
      sendJson(res, 500, { ok: false, error: error.message || "変換に失敗しました。" });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/convert-upload") {
    let temporaryPath = "";
    try {
      const encodedName = String(req.headers["x-file-name"] || "Office提出物.docx");
      let decodedName;
      try {
        decodedName = decodeURIComponent(encodedName);
      } catch {
        decodedName = "Office提出物.docx";
      }
      const safeName = path.basename(decodedName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
      const extension = path.extname(safeName).toLowerCase();
      if (!new Set([".doc", ".docx", ".ppt", ".pptx"]).has(extension)) {
        throw new Error("Word／PowerPointファイルではありません。");
      }

      const body = await readBuffer(req, 100 * 1024 * 1024);
      if (!body.length) throw new Error("提出物のデータが空です。");
      temporaryPath = path.join(temporaryDir, `.incoming-${crypto.randomUUID()}${extension}`);
      await fsp.writeFile(temporaryPath, body);

      const identity = parseHeaderJson(req.headers["x-cwr-cache-identity"]);
      const sourceMetadata = parseHeaderJson(req.headers["x-cwr-source-metadata"]);
      const force = req.headers["x-cwr-force"] === "1";
      const job = queue.then(() => convertOffice(temporaryPath, safeName, { identity, sourceMetadata, force }));
      queue = job.catch(() => undefined);
      sendJson(res, 200, await job);
    } catch (error) {
      log(`upload conversion error: ${error.message}`);
      sendJson(res, 500, { ok: false, error: error.message || "変換に失敗しました。" });
    } finally {
      if (temporaryPath) await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/store-pdf-upload") {
    try {
      const encodedName = String(req.headers["x-file-name"] || "Google提出物.pdf");
      let decodedName;
      try {
        decodedName = decodeURIComponent(encodedName);
      } catch {
        decodedName = "Google提出物.pdf";
      }
      let safeName = path.basename(decodedName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
      if (!/\.pdf$/i.test(safeName)) safeName += ".pdf";
      const body = await readBuffer(req, 100 * 1024 * 1024);
      const identity = parseHeaderJson(req.headers["x-cwr-cache-identity"]);
      const sourceMetadata = parseHeaderJson(req.headers["x-cwr-source-metadata"]);
      const force = req.headers["x-cwr-force"] === "1";
      sendJson(res, 200, await storePdfBuffer(body, safeName, { identity, sourceMetadata, force }));
    } catch (error) {
      log(`PDF storage error: ${error.message}`);
      sendJson(res, 500, { ok: false, error: error.message || "PDFを保存できませんでした。" });
    }
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/release/")) {
    try {
      sendJson(res, 200, await releasePdf(url.pathname));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/cache-lookup") {
    try {
      const body = await readJson(req);
      const cached = await readCachedPdf(body.identity);
      sendJson(res, 200, { ok: true, cached });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || "キャッシュを確認できませんでした。" });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/cache-summary") {
    sendJson(res, 200, await cacheSummary());
    return;
  }
  if (req.method === "POST" && url.pathname === "/cache-cleanup") {
    try {
      const body = await readJson(req);
      sendJson(res, 200, await cleanupCache(body));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || "キャッシュを整理できませんでした。" });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/open-word-upload") {
    try {
      const encodedName = String(req.headers["x-file-name"] || "Word提出物.docx");
      let decodedName;
      try {
        decodedName = decodeURIComponent(encodedName);
      } catch {
        decodedName = "Word提出物.docx";
      }
      const safeName = path.basename(decodedName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
      const extension = path.extname(safeName).toLowerCase();
      if (!new Set([".doc", ".docx"]).has(extension)) {
        throw new Error("Wordファイル（.doc / .docx）ではありません。");
      }
      const body = await readBuffer(req, 100 * 1024 * 1024);
      if (!body.length) throw new Error("提出物のデータが空です。");
      const job = officeWindowQueue.then(() => openWordWindow(body, safeName));
      officeWindowQueue = job.catch(() => undefined);
      sendJson(res, 200, await job);
    } catch (error) {
      log(`word window error: ${error.message}`);
      sendJson(res, 500, { ok: false, error: error.message || "Word別ウィンドウを開けませんでした。" });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/open-powerpoint-upload") {
    try {
      const encodedName = String(req.headers["x-file-name"] || "PowerPoint提出物.pptx");
      let decodedName;
      try {
        decodedName = decodeURIComponent(encodedName);
      } catch {
        decodedName = "PowerPoint提出物.pptx";
      }
      const safeName = path.basename(decodedName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
      const extension = path.extname(safeName).toLowerCase();
      if (!new Set([".ppt", ".pptx"]).has(extension)) {
        throw new Error("PowerPointファイル（.ppt / .pptx）ではありません。");
      }
      const body = await readBuffer(req, 100 * 1024 * 1024);
      if (!body.length) throw new Error("提出物のデータが空です。");
      const job = officeWindowQueue.then(() => openPowerPointWindow(body, safeName));
      officeWindowQueue = job.catch(() => undefined);
      sendJson(res, 200, await job);
    } catch (error) {
      log(`powerpoint window error: ${error.message}`);
      sendJson(res, 500, { ok: false, error: error.message || "PowerPoint発表画面を開けませんでした。" });
    }
    return;
  }
  if (req.method === "POST" && new Set(["/close-word-window", "/close-office-window"]).has(url.pathname)) {
    try {
      const job = officeWindowQueue.then(() => closeOfficeWindows());
      officeWindowQueue = job.catch(() => undefined);
      sendJson(res, 200, await job);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/shutdown") {
    sendJson(res, 200, { ok: true });
    setTimeout(() => shutdown("HTTP"), 0);
    return;
  }

  sendJson(res, 404, { ok: false, error: "要求された機能が見つかりません。" });
});

server.listen(port, host, () => log(`listening on http://${host}:${port}`));
server.on("error", async (error) => {
  log(`server error: ${error.message}`);
  await fsp.rm(pidFile, { force: true }).catch(() => undefined);
  process.exitCode = 1;
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`stopping (${signal})`);
  await closeOfficeWindows();
  await pruneTemporaryFiles();
  await fsp.rm(pidFile, { force: true }).catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
