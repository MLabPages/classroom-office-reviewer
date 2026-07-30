const HELPER_BASE = "http://127.0.0.1:18765";
const PENDING_KEY = "classroomWordReviewerPending";
const PREPARED_KEY = "classroomWordReviewerPrepared";
const PREPARED_SUBMISSIONS_KEY = "classroomWordReviewerPreparedSubmissions";
const HELPER_SESSION_KEY = "classroomWordReviewerHelperSession";
const PREPARED_MAXIMUM = 600;
const processingDownloads = new Set();
const preparedPdfs = new Map();
const preparedSubmissions = new Map();

async function helperHealth() {
  const response = await fetch(`${HELPER_BASE}/health`, { cache: "no-store" });
  if (!response.ok) throw new Error("補助アプリに接続できません。");
  const health = await response.json();
  const stored = await chrome.storage.session.get(HELPER_SESSION_KEY);
  if (health.sessionId && stored[HELPER_SESSION_KEY] !== health.sessionId) {
    preparedPdfs.clear();
    preparedSubmissions.clear();
    await chrome.storage.session.remove([PREPARED_KEY, PREPARED_SUBMISSIONS_KEY]);
    await chrome.storage.session.set({ [HELPER_SESSION_KEY]: health.sessionId });
  }
  return health;
}

async function getPending() {
  const stored = await chrome.storage.local.get(PENDING_KEY);
  return stored[PENDING_KEY] || null;
}

async function setPending(value) {
  if (value) {
    await chrome.storage.local.set({ [PENDING_KEY]: value });
  } else {
    await chrome.storage.local.remove(PENDING_KEY);
  }
}

async function sendToFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    return null;
  }
}

async function findCurrentDocument(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames?.length) return null;

  const ordered = [...frames].sort((a, b) => {
    const aDrive = /drive\.google\.com|docs\.google\.com/.test(a.url) ? 0 : 1;
    const bDrive = /drive\.google\.com|docs\.google\.com/.test(b.url) ? 0 : 1;
    return aDrive - bDrive;
  });

  const descriptors = [];
  let classroomAuthuser = null;
  for (const frame of ordered) {
    const descriptor = await sendToFrame(tabId, frame.frameId, { type: "cwr-describe-document" });
    if (!descriptor) continue;
    if (frame.frameId === 0 && Number.isInteger(descriptor.authuser)) {
      classroomAuthuser = descriptor.authuser;
    }
    descriptors.push(descriptor);
  }

  const downloadable = descriptors.filter((item) => item.downloadUrl || item.fileId);
  const selected = downloadable.find((item) => /\.(?:docx?|pptx?)$/i.test(item.fileName || "")) || downloadable[0] || null;
  if (selected && !Number.isInteger(selected.authuser) && Number.isInteger(classroomAuthuser)) {
    selected.authuser = classroomAuthuser;
  }
  return selected;
}

function buildDownloadUrl(descriptor) {
  if (descriptor.downloadUrl) return descriptor.downloadUrl;
  if (!descriptor.fileId) throw new Error("提出物ファイルの識別番号を取得できませんでした。");
  const authuser = Number.isInteger(descriptor.authuser) ? descriptor.authuser : 0;
  const params = new URLSearchParams({
    id: descriptor.fileId,
    export: "download",
    authuser: String(authuser)
  });
  return `https://drive.google.com/uc?${params.toString()}`;
}

function descriptorKey(descriptor) {
  return [descriptor.fileId || descriptor.downloadUrl || "", descriptor.fileName || ""].join("|");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getPreparedPdf(key) {
  const inMemory = preparedPdfs.get(key);
  if (inMemory) return inMemory;
  const stored = await chrome.storage.session.get(PREPARED_KEY);
  return stored[PREPARED_KEY]?.[key] || null;
}

async function getPreparedSubmission(submissionKey) {
  const inMemory = preparedSubmissions.get(submissionKey);
  if (inMemory) return inMemory;
  const stored = await chrome.storage.session.get(PREPARED_SUBMISSIONS_KEY);
  return stored[PREPARED_SUBMISSIONS_KEY]?.[submissionKey] || null;
}

async function rememberPreparedPdf(key, submissionKey, result) {
  preparedPdfs.set(key, result);
  preparedSubmissions.set(submissionKey, result);
  const stored = await chrome.storage.session.get(PREPARED_KEY);
  const entries = { ...(stored[PREPARED_KEY] || {}), [key]: result };
  const keep = Object.entries(entries).slice(-PREPARED_MAXIMUM);
  await chrome.storage.session.set({ [PREPARED_KEY]: Object.fromEntries(keep) });
  const submissionStored = await chrome.storage.session.get(PREPARED_SUBMISSIONS_KEY);
  const submissionEntries = { ...(submissionStored[PREPARED_SUBMISSIONS_KEY] || {}), [submissionKey]: result };
  const submissionKeep = Object.entries(submissionEntries).slice(-PREPARED_MAXIMUM);
  await chrome.storage.session.set({ [PREPARED_SUBMISSIONS_KEY]: Object.fromEntries(submissionKeep) });
  while (preparedPdfs.size > PREPARED_MAXIMUM) {
    preparedPdfs.delete(preparedPdfs.keys().next().value);
  }
  while (preparedSubmissions.size > PREPARED_MAXIMUM) {
    preparedSubmissions.delete(preparedSubmissions.keys().next().value);
  }
}

async function startTemporaryDownload(tabId, submissionKey, descriptor) {
  const url = buildDownloadUrl(descriptor);
  const downloadId = await chrome.downloads.download({
    url,
    conflictAction: "uniquify",
    saveAs: false
  });

  await setPending({
    tabId,
    downloadId,
    submissionKey,
    expectedName: descriptor.fileName || "Office提出物",
    startedAt: Date.now()
  });
  queueMicrotask(() => processCompletedDownload(downloadId));
  return { ok: true, fileName: descriptor.fileName || "Office提出物", mode: "temporary-download" };
}

async function notifyTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // The Classroom tab may have been closed or reloaded.
  }
}

function temporaryDownloadFallback(message) {
  const error = new Error(message);
  error.allowTemporaryDownload = true;
  return error;
}

function detectOfficeFormat(buffer, expectedName = "") {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8));
  const expected = expectedName.match(/\.(docx?|pptx?)$/i)?.[0].toLowerCase() || "";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if ([".docx", ".pptx"].includes(expected)) return expected;
    const tailStart = Math.max(0, buffer.byteLength - 128 * 1024);
    const tail = new TextDecoder("latin1").decode(buffer.slice(tailStart));
    return tail.includes("ppt/") ? ".pptx" : ".docx";
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return [".doc", ".ppt"].includes(expected) ? expected : ".doc";
  }
  return "";
}

async function fetchOfficeBuffer(descriptor) {
  const expectedName = descriptor.fileName || "Office提出物";
  let driveResponse;
  try {
    driveResponse = await fetch(buildDownloadUrl(descriptor), {
      credentials: "include",
      redirect: "follow",
      cache: "no-store"
    });
  } catch {
    throw temporaryDownloadFallback("Google Driveから直接取得できませんでした。");
  }

  const contentType = (driveResponse.headers.get("content-type") || "").toLowerCase();
  if (!driveResponse.ok || contentType.includes("text/html")) {
    throw temporaryDownloadFallback("Google Driveが直接取得を許可しませんでした。");
  }

  let buffer;
  try {
    buffer = await driveResponse.arrayBuffer();
  } catch {
    throw temporaryDownloadFallback("提出物ファイルをメモリに読み込めませんでした。");
  }
  if (buffer.byteLength > 100 * 1024 * 1024) {
    throw new Error("提出物が100MBを超えているため、メモリ内変換を中止しました。");
  }

  const extension = detectOfficeFormat(buffer, expectedName);
  if (!extension) {
    throw temporaryDownloadFallback("取得結果がWord／PowerPointファイルではありませんでした。");
  }
  const fileName = /\.(?:docx?|pptx?)$/i.test(expectedName) ? expectedName : `${expectedName}${extension}`;
  return { buffer, fileName };
}

async function convertInMemory(tabId, submissionKey, descriptor, { reportStatus = true, showPdf = true } = {}) {
  if (reportStatus) await notifyTab(tabId, {
    type: "cwr-status",
    state: "working",
    text: "提出物をメモリ内で取得中…",
    submissionKey
  });
  const { buffer, fileName } = await fetchOfficeBuffer(descriptor);

  if (reportStatus) await notifyTab(tabId, {
    type: "cwr-status",
    state: "converting",
    text: "Officeで表示用PDFを作成中…",
    submissionKey
  });

  const response = await fetch(`${HELPER_BASE}/convert-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(fileName)
    },
    body: buffer
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "OfficeからPDFへの変換に失敗しました。");
  }

  const converted = {
    ok: true,
    fileName: result.sourceName || fileName,
    pdfUrl: `${HELPER_BASE}${result.pdfUrl}`,
    pageCount: result.pageCount || null,
    mode: "memory",
    completed: true
  };
  if (showPdf) await notifyTab(tabId, { type: "cwr-show-pdf", submissionKey, ...converted });
  return converted;
}

async function prepareCurrentSubmission(tabId, submissionKey, expectedName) {
  await helperHealth();
  let descriptor = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = await findCurrentDocument(tabId);
    if (candidate && (!expectedName || candidate.fileName === expectedName)) {
      descriptor = candidate;
      break;
    }
    await wait(300);
  }
  if (!descriptor) throw new Error("この提出者のWord／PowerPointファイルを見つけられませんでした。");
  const key = descriptorKey(descriptor);
  const prepared = await getPreparedPdf(key);
  if (prepared) {
    await rememberPreparedPdf(key, submissionKey, prepared);
    return { ...prepared, documentKey: key, mode: "prepared", cached: true };
  }

  const result = await convertInMemory(tabId, submissionKey, descriptor, { reportStatus: true, showPdf: false });
  await rememberPreparedPdf(key, submissionKey, result);
  return { ...result, documentKey: key, mode: "prepared", cached: false };
}

async function startOfficeWindow(tabId, submissionKey) {
  await helperHealth();
  const descriptor = await findCurrentDocument(tabId);
  if (!descriptor) {
    throw new Error("表示中のWord／PowerPointファイルを見つけられませんでした。Classroomを再読み込みしてください。");
  }
  await notifyTab(tabId, {
    type: "cwr-status",
    state: "working",
    text: "別ウィンドウを準備中…",
    submissionKey
  });

  let documentData;
  try {
    documentData = await fetchOfficeBuffer(descriptor);
  } catch (error) {
    if (error.allowTemporaryDownload) {
      throw new Error("Google Driveから直接取得できないため、別ウィンドウを開けませんでした。");
    }
    throw error;
  }

  const powerpoint = /\.pptx?$/i.test(documentData.fileName);
  const endpoint = powerpoint ? "/open-powerpoint-upload" : "/open-word-upload";
  const response = await fetch(`${HELPER_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(documentData.fileName)
    },
    body: documentData.buffer
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "別ウィンドウを開けませんでした。");
  }
  return { ok: true, fileName: result.sourceName || documentData.fileName, mode: powerpoint ? "powerpoint-show" : "word-window", completed: true };
}

async function closeOfficeWindow() {
  const response = await fetch(`${HELPER_BASE}/close-office-window`, { method: "POST" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "別ウィンドウを閉じられませんでした。");
  return { ok: true };
}

async function releasePdf(pdfUrl) {
  if (typeof pdfUrl !== "string" || !/^http:\/\/127\.0\.0\.1:18765\/file\/[a-f0-9]{24}\.pdf$/.test(pdfUrl)) {
    throw new Error("削除対象の表示用PDFが正しくありません。");
  }
  const stored = await chrome.storage.session.get(PREPARED_KEY);
  if (Object.values(stored[PREPARED_KEY] || {}).some((item) => item.pdfUrl === pdfUrl)) {
    return { ok: true, retained: true };
  }
  const response = await fetch(pdfUrl.replace("/file/", "/release/"), { method: "POST" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "表示用PDFを削除できませんでした。");
  return { ok: true };
}

async function startConversion(tabId, submissionKey) {
  await helperHealth();
  const preparedSubmission = await getPreparedSubmission(submissionKey);
  if (preparedSubmission) {
    await notifyTab(tabId, {
      type: "cwr-show-pdf",
      pdfUrl: preparedSubmission.pdfUrl,
      fileName: preparedSubmission.fileName,
      pageCount: preparedSubmission.pageCount,
      submissionKey
    });
    return { ...preparedSubmission, mode: "prepared" };
  }
  const descriptor = await findCurrentDocument(tabId);
  if (!descriptor) {
    throw new Error("表示中のWord／PowerPointファイルを見つけられませんでした。Classroomを再読み込みしてください。");
  }

  const key = descriptorKey(descriptor);
  const prepared = await getPreparedPdf(key);
  if (prepared) {
    await notifyTab(tabId, {
      type: "cwr-show-pdf",
      pdfUrl: prepared.pdfUrl,
      fileName: prepared.fileName,
      pageCount: prepared.pageCount,
      submissionKey
    });
    return { ...prepared, mode: "prepared" };
  }

  try {
    return await convertInMemory(tabId, submissionKey, descriptor);
  } catch (error) {
    if (!error.allowTemporaryDownload) throw error;
    await notifyTab(tabId, {
      type: "cwr-status",
      state: "working",
      text: "一時取得に切り替えます。変換後に自動削除します…",
      submissionKey
    });
    return startTemporaryDownload(tabId, submissionKey, descriptor);
  }
}

async function convertCompletedDownload(item, pending) {
  await notifyTab(pending.tabId, {
    type: "cwr-status",
    state: "converting",
    text: "Officeで表示用PDFを作成中…",
    submissionKey: pending.submissionKey
  });

  const response = await fetch(`${HELPER_BASE}/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: item.filename })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "OfficeからPDFへの変換に失敗しました。");
  }

  await notifyTab(pending.tabId, {
    type: "cwr-show-pdf",
    pdfUrl: `${HELPER_BASE}${result.pdfUrl}`,
    fileName: result.sourceName || pending.expectedName,
    pageCount: result.pageCount || null,
    submissionKey: pending.submissionKey
  });
}

async function processCompletedDownload(downloadId) {
  if (processingDownloads.has(downloadId)) return;
  const pending = await getPending();
  if (!pending || pending.downloadId !== downloadId) return;
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item || item.state !== "complete") return;

  processingDownloads.add(downloadId);
  try {
    if (!/\.(?:docx?|pptx?)$/i.test(item.filename || "")) {
      throw new Error("ダウンロード結果がWord／PowerPointファイルではありません。Googleへのログイン状態を確認してください。");
    }
    await convertCompletedDownload(item, pending);
  } catch (error) {
    await notifyTab(pending.tabId, {
      type: "cwr-status",
      state: "error",
      text: error.message || "変換に失敗しました。",
      submissionKey: pending.submissionKey
    });
  } finally {
    await chrome.downloads.removeFile(downloadId).catch(() => undefined);
    await chrome.downloads.erase({ id: downloadId }).catch(() => undefined);
    processingDownloads.delete(downloadId);
    const latest = await getPending();
    if (latest?.downloadId === downloadId) await setPending(null);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!new Set(["cwr-start", "cwr-prepare-one", "cwr-open-office", "cwr-close-office", "cwr-release-pdf"]).has(message?.type)) return false;

  (async () => {
    try {
      const tabId = sender.tab?.id;
      if (typeof tabId !== "number") throw new Error("Classroomのタブを特定できませんでした。");
      const result = message.type === "cwr-prepare-one"
        ? await prepareCurrentSubmission(tabId, message.submissionKey || "", message.expectedName || "")
        : message.type === "cwr-open-office"
        ? await startOfficeWindow(tabId, message.submissionKey || "")
        : message.type === "cwr-close-office"
          ? await closeOfficeWindow()
          : message.type === "cwr-release-pdf"
            ? await releasePdf(message.pdfUrl)
            : await startConversion(tabId, message.submissionKey || "");
      sendResponse(result);
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof TypeError
          ? "補助アプリが起動していません。Start-Reviewer.cmd をダブルクリックしてください。"
          : error.message
      });
    }
  })();
  return true;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;
  const pending = await getPending();
  if (!pending || pending.downloadId !== delta.id) return;

  if (delta.state.current === "interrupted") {
    await chrome.downloads.removeFile(delta.id).catch(() => undefined);
    await chrome.downloads.erase({ id: delta.id }).catch(() => undefined);
    await setPending(null);
    await notifyTab(pending.tabId, {
      type: "cwr-status",
      state: "error",
      text: "提出物ファイルのダウンロードが中断されました。",
      submissionKey: pending.submissionKey
    });
    return;
  }
  if (delta.state.current !== "complete") return;
  await processCompletedDownload(delta.id);
});

chrome.downloads.onErased.addListener(async (downloadId) => {
  const pending = await getPending();
  if (pending?.downloadId === downloadId) await setPending(null);
});
