import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const nativeDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(nativeDir);
const cacheDir = path.join(rootDir, "cache");
const logsDir = path.join(rootDir, "logs");
const pidFile = path.join(logsDir, "reviewer.pid");
const wordConverterPath = path.join(nativeDir, "Convert-Word.ps1");
const powerPointConverterPath = path.join(nativeDir, "Convert-PowerPoint.ps1");
const wordWindowHostPath = path.join(nativeDir, "Word-Window-Host.ps1");
const powerPointWindowHostPath = path.join(nativeDir, "PowerPoint-Window-Host.ps1");
const host = "127.0.0.1";
const port = 18765;
const cacheMaximumAgeMs = 8 * 60 * 60 * 1000;
const cacheMaximumPdfs = 30;
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

await fsp.mkdir(cacheDir, { recursive: true });
await fsp.mkdir(logsDir, { recursive: true });
await fsp.writeFile(pidFile, String(process.pid), "utf8");
await prunePdfCache();

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function allowedOrigin(origin) {
  return !origin || origin.startsWith("chrome-extension://");
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-File-Name");
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

async function convertOffice(sourcePath, displayName = path.basename(sourcePath)) {
  const absolute = path.resolve(sourcePath);
  const extension = path.extname(absolute).toLowerCase();
  if (!new Set([".doc", ".docx", ".ppt", ".pptx"]).has(extension)) {
    throw new Error("Word／PowerPointファイルだけを処理できます。");
  }
  const stat = await fsp.stat(absolute);
  if (!stat.isFile()) throw new Error("提出物ファイルを読み込めません。");

  const id = (await hashFile(absolute)).slice(0, 24);
  const target = path.join(cacheDir, `${id}.pdf`);
  const metaPath = path.join(cacheDir, `${id}.json`);

  try {
    const [targetStat, metaText] = await Promise.all([
      fsp.stat(target),
      fsp.readFile(metaPath, "utf8")
    ]);
    if (targetStat.size > 0) {
      const metadata = JSON.parse(metaText);
      const now = new Date();
      await Promise.all([
        fsp.utimes(target, now, now),
        fsp.utimes(metaPath, now, now)
      ]).catch(() => undefined);
      return { ...metadata, sourceName: displayName, cached: true };
    }
  } catch {
    // Not cached yet.
  }

  const converterPath = new Set([".ppt", ".pptx"]).has(extension)
    ? powerPointConverterPath
    : wordConverterPath;
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", converterPath,
    "-SourcePath", absolute,
    "-TargetPath", target
  ], {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });

  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const conversion = JSON.parse(lines.at(-1) || "{}");
  if (!conversion.ok) throw new Error(conversion.error || "Office変換に失敗しました。");

  const metadata = {
    ok: true,
    pdfUrl: `/file/${id}.pdf`,
    sourceName: displayName,
    pageCount: conversion.pageCount || null,
    cached: false
  };
  await fsp.writeFile(metaPath, JSON.stringify(metadata), "utf8");
  await prunePdfCache();
  return metadata;
}

async function prunePdfCache() {
  const cutoff = Date.now() - cacheMaximumAgeMs;
  const pdfs = [];
  for (const entry of await fsp.readdir(cacheDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^([a-f0-9]{24})\.pdf$/);
    if (!match) continue;
    try {
      const stat = await fsp.stat(path.join(cacheDir, entry.name));
      pdfs.push({ id: match[1], mtimeMs: stat.mtimeMs });
    } catch {
      // Cleanup is best-effort.
    }
  }
  pdfs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const expired = pdfs.filter((item, index) => item.mtimeMs < cutoff || index >= cacheMaximumPdfs);
  await Promise.all(expired.flatMap((item) => [
    fsp.rm(path.join(cacheDir, `${item.id}.pdf`), { force: true }),
    fsp.rm(path.join(cacheDir, `${item.id}.json`), { force: true })
  ])).catch(() => undefined);
}

async function clearPdfCache() {
  const entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^[a-f0-9]{24}\.(?:pdf|json)$/.test(entry.name))
    .map((entry) => fsp.rm(path.join(cacheDir, entry.name), { force: true })));
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
  const temporaryPath = path.join(cacheDir, `.word-window-${crypto.randomUUID()}${extension}`);
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
  const temporaryPath = path.join(cacheDir, `.powerpoint-window-${crypto.randomUUID()}${extension}`);
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
  await Promise.all([
    fsp.rm(path.join(cacheDir, `${match[1]}.pdf`), { force: true }),
    fsp.rm(path.join(cacheDir, `${match[1]}.json`), { force: true })
  ]);
  return { ok: true };
}

function servePdf(res, pathname) {
  const match = pathname.match(/^\/file\/([a-f0-9]{24})\.pdf$/);
  if (!match) {
    sendJson(res, 404, { ok: false, error: "ファイルが見つかりません。" });
    return;
  }
  const filePath = path.join(cacheDir, `${match[1]}.pdf`);
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
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
    sendJson(res, 200, { ok: true, service: "Classroom Office Reviewer", version: "0.5.3", cacheHours: 8, cacheLimit: 30 });
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
      const job = queue.then(() => convertOffice(body.path));
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
      temporaryPath = path.join(cacheDir, `.incoming-${crypto.randomUUID()}${extension}`);
      await fsp.writeFile(temporaryPath, body);

      const job = queue.then(() => convertOffice(temporaryPath, safeName));
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
  if (req.method === "POST" && url.pathname.startsWith("/release/")) {
    try {
      sendJson(res, 200, await releasePdf(url.pathname));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
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
  await clearPdfCache();
  await fsp.rm(pidFile, { force: true }).catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
