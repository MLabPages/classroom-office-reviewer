// Classroomの採点画面に隠しフレームとして読み込まれ、提出物の取得とZIP作成
// だけを担当する。拡張機能のオリジンで動くので、Drive／Googleドキュメントへ
// ログイン済みのまま取得できる。Classroom側のスクリプトからは中身を触れない。

import {
  buildCsv,
  buildJson,
  internetShortcut,
  planJob,
  summarizeRows,
  uniqueEntryPath
} from "./bulk-zip-core.js";
import { ZipBuilder } from "./zip-writer.js";

const PARENT_ORIGIN = "https://classroom.google.com";
// 同時取得数。増やすと速いが、Driveの制限とメモリ使用量が上がる。
const CONCURRENCY = 3;
// 1ファイルとZIP全体の上限。超えた分は記録して次へ進む。
const FILE_LIMIT_BYTES = 200 * 1024 * 1024;
const TOTAL_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 180000;
// 受信データは一定量ごとにBlobへ移し、JS側にため込まない。
const FLUSH_BYTES = 4 * 1024 * 1024;

const state = { jobId: "", cancelled: false, aborted: false, running: false, controllers: new Set() };

// 進捗の送り先と通信手段は差し替えられるようにしておく。実際の画面では
// 親フレームとfetchを使い、テストでは呼び出し内容を確認する。
const channel = {
  send: (message) => parent.postMessage(message, PARENT_ORIGIN),
  fetch: (...args) => fetch(...args)
};

export function __setChannel(overrides = {}) {
  Object.assign(channel, overrides);
}

function post(message) {
  channel.send({ ...message, jobId: state.jobId });
}

function limitMessage() {
  return `ファイルサイズが上限（${Math.round(FILE_LIMIT_BYTES / 1024 / 1024)}MB）を超えています。`;
}

function isHtmlResponse(response) {
  return (response.headers.get("content-type") || "").toLowerCase().includes("text/html");
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  state.controllers.add(controller);
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await channel.fetch(url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    state.controllers.delete(controller);
  }
}

// 取得したデータをBlobにまとめる。読みながら上限を確認し、大きすぎるものは
// 途中で打ち切ってメモリを守る。
async function readLimitedBlob(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared > FILE_LIMIT_BYTES) throw new Error(limitMessage());
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > FILE_LIMIT_BYTES) throw new Error(limitMessage());
    return blob;
  }
  const reader = response.body.getReader();
  const blobs = [];
  let pending = [];
  let pendingBytes = 0;
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      size += value.length;
      if (size > FILE_LIMIT_BYTES) throw new Error(limitMessage());
      pending.push(value);
      pendingBytes += value.length;
      if (pendingBytes >= FLUSH_BYTES) {
        blobs.push(new Blob(pending));
        pending = [];
        pendingBytes = 0;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (pending.length) blobs.push(new Blob(pending));
  return new Blob(blobs);
}

// Googleへログインできていないと、すべての取得がHTMLの案内ページになる。
// 最初の数件で必ず起きるので、100人分を試し続けずに理由を出して止める。
const AUTH_FAILURE_LIMIT = 3;

// 1件分の取得。Driveは大きいファイルで確認画面（HTML）を返すため、
// 予備のURLまで順に試す。
async function downloadPart(part) {
  let lastError = "";
  let authLike = false;
  for (const url of part.urls || []) {
    if (!url || state.cancelled) continue;
    try {
      const response = await fetchWithTimeout(url);
      if (response.status === 403 || response.status === 401) {
        lastError = "権限不足のため取得できませんでした。";
        authLike = true;
        continue;
      }
      if (response.status === 404) {
        lastError = "提出物が見つかりませんでした（削除または共有解除の可能性）。";
        continue;
      }
      if (!response.ok) {
        lastError = `取得に失敗しました（HTTP ${response.status}）。`;
        continue;
      }
      if (isHtmlResponse(response)) {
        lastError = "Googleがファイルではなく確認画面を返しました（権限不足や容量制限の可能性）。";
        authLike = true;
        continue;
      }
      const blob = await readLimitedBlob(response);
      if (blob.size === 0) {
        lastError = "取得できた内容が空でした。";
        continue;
      }
      return { ok: true, blob };
    } catch (error) {
      lastError = error?.name === "AbortError"
        ? "取得に時間がかかりすぎたか、中止されました。"
        : (error?.message || "取得に失敗しました。");
    }
  }
  return { ok: false, error: lastError || "取得に失敗しました。", authLike };
}

export async function runJob(job) {
  const { rootFolder, tasks, rows, used } = planJob(job);
  const retryKeys = Array.isArray(job.onlyKeys) && job.onlyKeys.length ? new Set(job.onlyKeys) : null;
  const active = retryKeys ? tasks.filter((task) => retryKeys.has(task.key)) : tasks;
  for (const task of tasks) {
    if (retryKeys && !retryKeys.has(task.key)) {
      task.row.result = "スキップ";
      task.row.note = [task.row.note, "今回の再取得の対象外です。"].filter(Boolean).join(" ");
    }
  }

  const zip = new ZipBuilder();
  // 進捗の「◯名中◯名」は、その提出者の全ファイルが終わったときに数える。
  const remaining = new Map();
  for (const task of active) remaining.set(task.row.studentKey, (remaining.get(task.row.studentKey) || 0) + 1);
  const studentsTotal = new Set(rows.map((row) => row.studentKey)).size;
  let studentsDone = studentsTotal - remaining.size;
  let filesDone = 0;
  let filesFailed = 0;
  let totalBytes = 0;
  let authFailures = 0;
  let downloaded = 0;

  const report = (currentLabel) => post({
    type: "cwr-zip-progress",
    phase: "download",
    studentsDone,
    studentsTotal,
    filesDone,
    filesFailed,
    filesTotal: active.length,
    currentLabel
  });
  const finishTask = (studentKey) => {
    const left = (remaining.get(studentKey) || 1) - 1;
    if (left <= 0) {
      remaining.delete(studentKey);
      studentsDone += 1;
    } else {
      remaining.set(studentKey, left);
    }
  };
  report("提出物の取得を開始しています…");

  // 取得は同時に数件、ZIPへの書き込みは1件ずつ。書き込みを並べるとZIPの
  // 構造が壊れるため、ここは必ず順番に行う。
  let cursor = 0;
  let writing = Promise.resolve();
  const writeEntry = (job2) => {
    writing = writing.then(job2).catch(() => undefined);
    return writing;
  };

  const workers = [];
  for (let worker = 0; worker < Math.min(CONCURRENCY, Math.max(1, active.length)); worker += 1) {
    workers.push((async () => {
      while (!state.cancelled) {
        const index = cursor;
        cursor += 1;
        if (index >= active.length) return;
        const task = active[index];
        const { part, row } = task;

        if (part.kind === "shortcut") {
          if (!part.url) {
            row.result = "失敗";
            row.note = [row.note, "リンクのURLを取得できませんでした。"].filter(Boolean).join(" ");
            filesFailed += 1;
          } else {
            await writeEntry(async () => {
              try {
                await zip.addText(task.zipPath, internetShortcut(part.url));
                row.result = "URLのみ保存";
                filesDone += 1;
              } catch (error) {
                row.result = "失敗";
                row.note = [row.note, error?.message || "ZIPへ追加できませんでした。"].filter(Boolean).join(" ");
                filesFailed += 1;
              }
            });
          }
          finishTask(row.studentKey);
          report(`${row.studentName || "提出者"}：${part.fileName}`);
          continue;
        }

        report(`${row.studentName || "提出者"}：${part.fileName} を取得中`);
        const result = await downloadPart(part);
        if (state.cancelled) return;
        if (result.ok) {
          downloaded += 1;
          authFailures = 0;
        } else if (result.authLike) {
          authFailures += 1;
        }
        // 1件も取得できないまま権限エラーが続く場合は、全員分を試す前に止める。
        if (!downloaded && authFailures >= AUTH_FAILURE_LIMIT) {
          state.cancelled = true;
          state.aborted = true;
          post({
            type: "cwr-zip-error",
            message: "Google Driveから提出物を取得できませんでした。Chromeで採点に使っているGoogleアカウントにログインしているか確認してから、もう一度お試しください。"
          });
          return;
        }

        if (!result.ok) {
          // 取得できなくても、開くためのURLが分かるなら .url だけ残す。
          // ただし提出物そのものは取れていないので、失敗として数える。
          if (part.sourceUrl) {
            await writeEntry(async () => {
              const shortcutPath = uniqueEntryPath(used, `${task.zipPath.replace(/\.[^./]+$/, "")}_リンクのみ.url`);
              try {
                await zip.addText(shortcutPath, internetShortcut(part.sourceUrl));
                row.zipPath = shortcutPath;
                row.result = "失敗（URLのみ保存）";
              } catch {
                row.result = "失敗";
              }
              filesFailed += 1;
              row.note = [row.note, part.failureNote || "", result.error].filter(Boolean).join(" ");
            });
          } else {
            row.result = "失敗";
            row.note = [row.note, part.failureNote || "", result.error].filter(Boolean).join(" ");
            filesFailed += 1;
          }
          finishTask(row.studentKey);
          report(`${row.studentName || "提出者"}：${part.fileName} を取得できませんでした`);
          continue;
        }

        if (totalBytes + result.blob.size > TOTAL_LIMIT_BYTES) {
          row.result = "失敗";
          row.note = [row.note, "ZIP全体の上限に達したため、この提出物は入れられませんでした。"].filter(Boolean).join(" ");
          filesFailed += 1;
          finishTask(row.studentKey);
          report(`${row.studentName || "提出者"}：容量の上限に達しました`);
          continue;
        }

        await writeEntry(async () => {
          try {
            await zip.addFile(task.zipPath, result.blob);
            totalBytes += result.blob.size;
            row.result = "成功";
            filesDone += 1;
          } catch (error) {
            row.result = "失敗";
            row.note = [row.note, error?.message || "ZIPへ追加できませんでした。"].filter(Boolean).join(" ");
            filesFailed += 1;
          }
        });
        finishTask(row.studentKey);
        report(`${row.studentName || "提出者"}：${part.fileName}`);
      }
    })());
  }
  await Promise.all(workers);
  await writing;

  if (state.cancelled) {
    // 取得できない理由を出して止めたときは、そちらの案内を残す。
    if (!state.aborted) post({ type: "cwr-zip-cancelled" });
    return;
  }

  for (const row of rows) {
    if (row.result === "未処理") {
      row.result = "失敗";
      row.note = [row.note, "処理が最後まで進みませんでした。"].filter(Boolean).join(" ");
    }
  }

  post({
    type: "cwr-zip-progress",
    phase: "packing",
    studentsDone,
    studentsTotal,
    filesDone,
    filesFailed,
    filesTotal: active.length,
    currentLabel: "提出物一覧を作成しています…"
  });
  await zip.addText(`${rootFolder}/提出物一覧.csv`, buildCsv(rows));
  await zip.addText(`${rootFolder}/提出物一覧.json`, buildJson(rows, {
    assignmentName: job.assignmentName,
    createdAt: new Date().toISOString(),
    layout: job.layout,
    tokenRule: job.tokenRule
  }));

  const blob = zip.finish();
  const summary = summarizeRows(rows);
  const failures = tasks
    .filter((task) => String(task.row.result || "").startsWith("失敗"))
    .map((task) => ({
      key: task.key,
      studentName: task.row.studentName,
      fileName: task.row.originalName || task.part.fileName,
      note: task.row.note || "取得に失敗しました。"
    }));
  post({
    type: "cwr-zip-done",
    blob,
    fileName: `${rootFolder}.zip`,
    summary,
    failures,
    retried: Boolean(retryKeys)
  });
}

export async function handleZipMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "cwr-zip-cancel") {
    state.cancelled = true;
    for (const controller of state.controllers) controller.abort();
    state.controllers.clear();
    return;
  }
  if (message.type !== "cwr-zip-run") return;
  if (state.running) {
    channel.send({ type: "cwr-zip-error", jobId: message.jobId, message: "すでにZIPを作成中です。" });
    return;
  }

  state.jobId = message.jobId || "";
  state.cancelled = false;
  state.aborted = false;
  state.running = true;
  try {
    await runJob(message);
  } catch (error) {
    post({ type: "cwr-zip-error", message: error?.message || "ZIPを作成できませんでした。" });
  } finally {
    state.running = false;
  }
}

// 画面で動いているときだけ、親フレームとのやり取りを始める。
// Nodeでのテストでは読み込むだけで副作用を起こさない。
if (typeof window !== "undefined" && typeof parent !== "undefined" && parent !== window) {
  window.addEventListener("message", (event) => {
    if (event.origin !== PARENT_ORIGIN) return;
    handleZipMessage(event.data);
  });
  // 読み込みが終わったことを親へ伝える。ここが届く前に指示を送ると取りこぼす。
  parent.postMessage({ type: "cwr-zip-ready" }, PARENT_ORIGIN);
}
