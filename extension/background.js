const HELPER_BASE = "http://127.0.0.1:18765";
const PREPARED_KEY = "classroomWordReviewerPrepared";
const PREPARED_SUBMISSIONS_KEY = "classroomWordReviewerPreparedSubmissions";
const PREPARED_IDS_KEY = "classroomWordReviewerPreparedIds";
const HELPER_SESSION_KEY = "classroomWordReviewerHelperSession";
const PREPARATION_TAB_KEY = "classroomWordReviewerPreparationTab";
const PREPARED_MAXIMUM = 600;
const preparedPdfs = new Map();
const preparedSubmissions = new Map();
const preparedPdfsById = new Map();

// Office が壊れたファイルで固まっても、一括準備の行列ごと止まらないように
// すべての通信に上限時間を設ける。
async function fetchWithTimeout(url, init, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

let nativePort = null;
let nativePortConnecting = false;

function ensureNativeHost() {
  if (nativePort || nativePortConnecting) return;
  nativePortConnecting = true;
  try {
    nativePort = chrome.runtime.connectNative("com.mlabpages.classroom_reviewer");
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      nativePortConnecting = false;
    });
    nativePort.onMessage.addListener(() => {});
  } catch (e) {
    nativePort = null;
  } finally {
    nativePortConnecting = false;
  }
}

async function helperHealth() {
  ensureNativeHost();
  const response = await fetchWithTimeout(
    `${HELPER_BASE}/health`,
    { cache: "no-store" },
    15000,
    "補助アプリが応答しません。Start-Reviewer.cmd を起動し直してください。"
  );
  if (!response.ok) throw new Error("補助アプリに接続できません。");
  const health = await response.json();
  const expectedVersion = chrome.runtime.getManifest().version;
  if (health.version !== expectedVersion) {
    throw new Error(`補助アプリが古い版（v${health.version || "不明"}）です。最新版のStart-Reviewer.cmdを起動してください。`);
  }
  const stored = await chrome.storage.local.get(HELPER_SESSION_KEY);
  if (health.sessionId && stored[HELPER_SESSION_KEY] !== health.sessionId) {
    preparedPdfs.clear();
    preparedSubmissions.clear();
    preparedPdfsById.clear();
    await chrome.storage.local.remove([PREPARED_KEY, PREPARED_SUBMISSIONS_KEY, PREPARED_IDS_KEY]);
    await chrome.storage.local.set({ [HELPER_SESSION_KEY]: health.sessionId });
  }
  return health;
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
  let submissionView = false;
  for (const frame of ordered) {
    const descriptor = await sendToFrame(tabId, frame.frameId, { type: "cwr-describe-document" });
    if (!descriptor) continue;
    if (frame.frameId === 0 && Number.isInteger(descriptor.authuser)) {
      classroomAuthuser = descriptor.authuser;
    }
    if (frame.frameId === 0) submissionView = descriptor.submissionView === true;
    descriptors.push(descriptor);
  }

  // A grading overview has many attachment cards, but no individual
  // submission is open. Never fetch a file from that page.
  if (!submissionView) return null;

  const downloadable = descriptors.filter((item) => item.downloadUrl || item.fileId);
  const selected = downloadable.find((item) => ["document", "presentation"].includes(item.googleType))
    || downloadable.find((item) => /\.(?:docx?|pptx?)$/i.test(item.fileName || ""))
    || downloadable[0]
    || null;
  if (selected && isGoogleNative(selected)) {
    const friendly = descriptors.find((item) => item.fileId === selected.fileId
      && item.fileName
      && !/^Google(?:ドキュメント|スライド)$/i.test(item.fileName));
    if (friendly) selected.fileName = friendly.fileName;
  }
  if (selected && !Number.isInteger(selected.authuser) && Number.isInteger(classroomAuthuser)) {
    selected.authuser = classroomAuthuser;
  }
  return selected;
}

async function waitForCurrentDocument(tabId, expectedName = "", expectedFileId = "", expectedGoogleType = "") {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = await findCurrentDocument(tabId);
    const idMatches = !expectedFileId || candidate?.fileId === expectedFileId;
    // ファイル番号が一致していれば、それが同じファイルである決定的な証拠。
    // 画面に出る名前は省略・重複・記号付きなど表示のたびに揺れるため、
    // ここで名前の完全一致まで求めると、正しいファイルを取り逃して
    // 待ち時間切れになり「準備できず」と表示されてしまう。
    const confirmedById = Boolean(expectedFileId) && idMatches;
    const nameMatches = confirmedById || !expectedName || candidate?.fileName === expectedName;
    const typeMatches = !expectedGoogleType || candidate?.googleType === expectedGoogleType;
    if (candidate && nameMatches && idMatches && typeMatches) return candidate;
    await wait(300);
  }
  return null;
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

function isGoogleNative(descriptor) {
  return ["document", "presentation"].includes(descriptor?.googleType);
}

// 提出物がすでにPDFなら、Officeでの変換もGoogleのPDF書き出しも不要。
// Driveから直接ダウンロードして、そのまま表示用として保存する。
function isPdfDescriptor(descriptor) {
  return !isGoogleNative(descriptor) && /\.pdf$/i.test(descriptor?.fileName || "");
}

function buildGooglePdfExportUrl(descriptor) {
  if (!descriptor.fileId) throw new Error("Google形式の提出物を識別できませんでした。");
  const authuser = Number.isInteger(descriptor.authuser) ? descriptor.authuser : 0;
  const suffix = descriptor.googleType === "presentation" ? "export/pdf" : "export?format=pdf";
  const separator = suffix.includes("?") ? "&" : "?";
  return `https://docs.google.com/${descriptor.googleType}/d/${descriptor.fileId}/${suffix}${separator}authuser=${authuser}`;
}

function descriptorKey(descriptor) {
  return [descriptor.fileId || descriptor.downloadUrl || "", descriptor.fileName || ""].join("|");
}

function cacheIdentityFor(cacheIdentity, descriptor) {
  const value = cacheIdentity && typeof cacheIdentity === "object" ? cacheIdentity : {};
  return {
    courseId: String(value.courseId || ""),
    assignmentId: String(value.assignmentId || ""),
    submissionId: String(value.submissionId || ""),
    fileId: String(descriptor?.fileId || value.fileId || "")
  };
}

function cacheHeaders(identity, sourceMetadata = {}, force = false) {
  return {
    "X-CWR-Cache-Identity": encodeURIComponent(JSON.stringify(identity)),
    "X-CWR-Source-Metadata": encodeURIComponent(JSON.stringify(sourceMetadata)),
    ...(force ? { "X-CWR-Force": "1" } : {})
  };
}

function helperResultToConverted(result, fallbackName, mode) {
  return {
    ok: true,
    fileName: result.sourceName || fallbackName,
    pdfUrl: `${HELPER_BASE}${result.pdfUrl}`,
    pageCount: result.pageCount || null,
    mode,
    cached: result.cached === true,
    sourceETag: result.sourceETag || "",
    sourceModifiedTime: result.sourceModifiedTime || "",
    sourceSize: result.sourceSize || 0,
    completed: true
  };
}

async function probeSourceMetadata(descriptor) {
  const url = isGoogleNative(descriptor) ? buildGooglePdfExportUrl(descriptor) : buildDownloadUrl(descriptor);
  try {
    const response = await fetchWithTimeout(
      url,
      { method: "HEAD", credentials: "include", redirect: "follow", cache: "no-store" },
      30000,
      "更新日時の確認に時間がかかっています。"
    );
    if (!response.ok) return null;
    const etag = response.headers.get("etag") || "";
    const lastModified = response.headers.get("last-modified") || "";
    const sourceSize = Number(response.headers.get("content-length") || 0);
    return etag || lastModified || sourceSize ? { etag, lastModified, sourceSize } : null;
  } catch {
    // DriveがHEADを返さない場合は、既に確認済みのPDFを優先する。
    return null;
  }
}

function cachedPdfMatchesProbe(cached, probe) {
  if (!probe) return true;
  if (cached.sourceETag && probe.etag) return cached.sourceETag === probe.etag;
  if (cached.sourceModifiedTime && probe.lastModified) return cached.sourceModifiedTime === probe.lastModified;
  if (cached.sourceSize && probe.sourceSize) return cached.sourceSize === probe.sourceSize;
  return true;
}

async function findPersistentCachedPdf(identity, descriptor, fallbackName, mode) {
  const response = await fetchWithTimeout(
    `${HELPER_BASE}/cache-lookup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity })
    },
    30000,
    "保存済みPDFの確認に時間がかかっています。"
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok || !result.cached) return null;
  const cached = helperResultToConverted(result.cached, fallbackName, mode);
  const probe = await probeSourceMetadata(descriptor);
  return cachedPdfMatchesProbe(cached, probe) ? cached : null;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getPreparationState() {
  const stored = await chrome.storage.session.get(PREPARATION_TAB_KEY);
  return stored[PREPARATION_TAB_KEY] || null;
}

async function setPreparationState(value) {
  if (value) await chrome.storage.session.set({ [PREPARATION_TAB_KEY]: value });
  else await chrome.storage.session.remove(PREPARATION_TAB_KEY);
}

async function patchPreparationState(patch) {
  const current = await getPreparationState();
  if (!current) return null;
  const next = { ...current, ...patch };
  await setPreparationState(next);
  return next;
}

// 準備専用タブがまだ生きていて、実際に処理中かどうかを確かめる。
// 生きていない状態を「実行中」と信じ続けると、採点タブの案内が永久に止まる。
async function inspectPreparationTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  const response = await sendToFrame(tabId, 0, { type: "cwr-preparation-ping" });
  return { tab, preparing: response?.preparing === true, responded: Boolean(response) };
}

async function focusTab(tabId, windowId) {
  if (!Number.isInteger(tabId)) return false;
  const updated = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (!updated) return false;
  const targetWindow = Number.isInteger(windowId) ? windowId : updated.windowId;
  if (Number.isInteger(targetWindow)) {
    await chrome.windows.update(targetWindow, { focused: true }).catch(() => undefined);
  }
  return true;
}

async function sendWhenReady(tabId, message) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await sendToFrame(tabId, 0, message);
    if (response?.ok) return response;
    if (response?.error) throw new Error(response.error);
    await wait(500);
  }
  throw new Error("準備専用タブが応答しませんでした。Classroomを再読み込みしてからお試しください。");
}

async function waitForClassroomTab(tabId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("準備専用タブが閉じられました。");
    if (tab.status === "complete" && tab.url?.startsWith("https://classroom.google.com/")) return tab;
    await wait(500);
  }
  throw new Error("準備専用タブの読み込みが完了しませんでした。通信状況を確認してからお試しください。");
}

async function startBulkPreparation(sourceTabId, { prefetch = false } = {}) {
  const sourceTab = await chrome.tabs.get(sourceTabId);
  if (!sourceTab.url?.startsWith("https://classroom.google.com/")) {
    throw new Error("Classroomの採点画面で実行してください。");
  }

  let preparationState = await getPreparationState();
  let preparationTab = null;
  if (preparationState?.tabId) {
    const inspection = await inspectPreparationTab(preparationState.tabId);
    preparationTab = inspection?.tab || null;
    // 実行中と記録されていても、タブが応答しない、または処理が終わっている
    // 場合は作り直す。そうしないと「実行中」のまま二度と進まなくなる。
    if (inspection?.preparing && preparationState.status === "running") {
      await patchPreparationState({ sourceTabId, sourceWindowId: sourceTab.windowId });
      return { ok: true, alreadyRunning: true, tabId: preparationState.tabId };
    }
  }

  const reused = Boolean(preparationTab);
  if (!preparationTab) {
    preparationTab = await chrome.tabs.create({
      url: sourceTab.url,
      active: !prefetch,
      index: sourceTab.index + 1,
      windowId: sourceTab.windowId
    });
  } else {
    preparationTab = await chrome.tabs.update(preparationTab.id, { url: sourceTab.url, active: !prefetch });
    if (!prefetch) await chrome.windows.update(preparationTab.windowId, { focused: true }).catch(() => undefined);
  }

  preparationState = {
    tabId: preparationTab.id,
    windowId: preparationTab.windowId,
    sourceTabId,
    sourceWindowId: sourceTab.windowId,
    status: "running",
    acknowledged: false,
    prefetch,
    startedAt: Date.now(),
    lastProgressAt: Date.now()
  };
  await setPreparationState(preparationState);
  try {
    await waitForClassroomTab(preparationTab.id);
    await sendWhenReady(preparationTab.id, { type: "cwr-run-preparation", prefetch });
  } catch (error) {
    await patchPreparationState({ status: "error" });
    await focusTab(sourceTabId, sourceTab.windowId);
    throw error;
  }
  await patchPreparationState({ acknowledged: true });
  return { ok: true, reused, tabId: preparationTab.id };
}

async function relayPreparationProgress(senderTabId, progress) {
  const preparationState = await getPreparationState();
  if (!preparationState || preparationState.tabId !== senderTabId) return { ok: false };
  if (!preparationState.prefetch) {
    await notifyTab(preparationState.sourceTabId, { type: "cwr-prepare-remote-progress", ...progress });
  }
  const finished = progress.status && progress.status !== "running";
  await patchPreparationState({
    lastProgressAt: Date.now(),
    lastProgress: progress,
    ...(finished ? { status: progress.status } : {})
  });
  // 終わったら採点タブへ自動で戻す。準備専用タブを探す手間をなくす。
  if (finished && !preparationState.prefetch) await focusTab(preparationState.sourceTabId, preparationState.sourceWindowId);
  return { ok: true };
}

async function cancelBulkPreparation() {
  const preparationState = await getPreparationState();
  if (!preparationState || preparationState.status !== "running") {
    return { ok: false, error: "実行中の一括準備が見つかりませんでした。" };
  }
  const delivered = await sendToFrame(preparationState.tabId, 0, { type: "cwr-cancel-preparation" });
  if (!delivered) {
    await patchPreparationState({ status: "error" });
    await notifyTab(preparationState.sourceTabId, {
      type: "cwr-prepare-remote-progress",
      status: "error",
      title: "一括準備を続けられません",
      countText: "準備専用タブが応答しません",
      detailText: "もう一度「全員分を一括準備」を押すと、新しい準備専用タブでやり直します。"
    });
    return { ok: false, error: "準備専用タブが応答しませんでした。" };
  }
  return { ok: true };
}

async function focusPreparationTab() {
  const preparationState = await getPreparationState();
  if (!preparationState?.tabId) return { ok: false, error: "準備専用タブが見つかりませんでした。" };
  const focused = await focusTab(preparationState.tabId, preparationState.windowId);
  return focused ? { ok: true } : { ok: false, error: "準備専用タブが見つかりませんでした。" };
}

async function focusSourceTab() {
  const preparationState = await getPreparationState();
  if (!preparationState?.sourceTabId) return { ok: false, error: "採点タブが見つかりませんでした。" };
  const focused = await focusTab(preparationState.sourceTabId, preparationState.sourceWindowId);
  return focused ? { ok: true } : { ok: false, error: "採点タブが見つかりませんでした。" };
}

// 内容スクリプトが読み込み直されたとき、自分の役割と最新の進捗を取り戻す。
async function describePreparationRole(tabId) {
  const preparationState = await getPreparationState();
  if (!preparationState) return { role: "none" };
  if (preparationState.tabId === tabId) {
    if (preparationState.status === "running" && preparationState.acknowledged) {
      // 準備中のタブが再読み込みされた＝処理は失われている。
      await patchPreparationState({ status: "error" });
      await notifyTab(preparationState.sourceTabId, {
        type: "cwr-prepare-remote-progress",
        status: "error",
        title: "一括準備が中断されました",
        countText: "準備専用タブが再読み込みされました",
        detailText: "もう一度「全員分を一括準備」を押すと、変換済みの提出物はやり直さずに続きを準備します。"
      });
      return { role: "preparation", interrupted: true };
    }
    return { role: "preparation" };
  }
  if (preparationState.sourceTabId === tabId && preparationState.status === "running" && !preparationState.prefetch) {
    return { role: "source", progress: preparationState.lastProgress || null };
  }
  return { role: "none" };
}

function sleep(milliseconds) {
  const safe = Math.min(Math.max(Number(milliseconds) || 0, 0), 5000);
  return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), safe));
}

async function getPreparedPdf(key) {
  const inMemory = preparedPdfs.get(key);
  if (inMemory) return inMemory;
  const stored = await chrome.storage.local.get(PREPARED_KEY);
  return stored[PREPARED_KEY]?.[key] || null;
}

async function getPreparedSubmission(submissionKey) {
  const inMemory = preparedSubmissions.get(submissionKey);
  if (inMemory) return inMemory;
  const stored = await chrome.storage.local.get(PREPARED_SUBMISSIONS_KEY);
  return stored[PREPARED_SUBMISSIONS_KEY]?.[submissionKey] || null;
}

// Drive上のファイル番号は、画面に出る名前が省略されても変わらない。
// 準備済みPDFはまずこの番号で引き当て、二重変換を防ぐ。
async function getPreparedPdfById(fileId) {
  if (!fileId) return null;
  const inMemory = preparedPdfsById.get(fileId);
  if (inMemory) return inMemory;
  const stored = await chrome.storage.local.get(PREPARED_IDS_KEY);
  return stored[PREPARED_IDS_KEY]?.[fileId] || null;
}

// primary=false は「その提出者の2件目以降」。提出者から引く索引は1件目のまま
// 残し、2件目以降はファイル単位の索引（key）からだけ取り出せるようにする。
async function rememberPreparedPdf(key, submissionKey, result, { primary = true, fileId = "" } = {}) {
  preparedPdfs.set(key, result);
  if (primary) preparedSubmissions.set(submissionKey, result);
  const documentId = fileId || String(key).split("|")[0] || "";
  if (documentId) preparedPdfsById.set(documentId, result);

  const stored = await chrome.storage.local.get(PREPARED_KEY);
  const entries = { ...(stored[PREPARED_KEY] || {}), [key]: result };
  const keep = Object.entries(entries).slice(-PREPARED_MAXIMUM);
  await chrome.storage.local.set({ [PREPARED_KEY]: Object.fromEntries(keep) });

  if (primary) {
    const submissionStored = await chrome.storage.local.get(PREPARED_SUBMISSIONS_KEY);
    const submissionEntries = { ...(submissionStored[PREPARED_SUBMISSIONS_KEY] || {}), [submissionKey]: result };
    const submissionKeep = Object.entries(submissionEntries).slice(-PREPARED_MAXIMUM);
    await chrome.storage.local.set({ [PREPARED_SUBMISSIONS_KEY]: Object.fromEntries(submissionKeep) });
  }

  if (documentId) {
    const idStored = await chrome.storage.local.get(PREPARED_IDS_KEY);
    const idEntries = { ...(idStored[PREPARED_IDS_KEY] || {}), [documentId]: result };
    const idKeep = Object.entries(idEntries).slice(-PREPARED_MAXIMUM);
    await chrome.storage.local.set({ [PREPARED_IDS_KEY]: Object.fromEntries(idKeep) });
  }

  while (preparedPdfs.size > PREPARED_MAXIMUM) {
    preparedPdfs.delete(preparedPdfs.keys().next().value);
  }
  while (preparedSubmissions.size > PREPARED_MAXIMUM) {
    preparedSubmissions.delete(preparedSubmissions.keys().next().value);
  }
  while (preparedPdfsById.size > PREPARED_MAXIMUM) {
    preparedPdfsById.delete(preparedPdfsById.keys().next().value);
  }
}

async function notifyTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // The Classroom tab may have been closed or reloaded.
  }
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

function isPdfBuffer(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 5));
  return bytes.length === 5
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
    && bytes[4] === 0x2d;
}

function pdfFileName(fileName = "") {
  const trimmed = fileName.trim();
  if (/\.pdf$/i.test(trimmed)) return trimmed;
  const withoutOfficeExtension = trimmed.replace(/\.(?:docx?|pptx?)$/i, "");
  return `${withoutOfficeExtension || "提出物"}.pdf`;
}

async function fetchOfficeBuffer(descriptor) {
  const expectedName = descriptor.fileName || "Office提出物";
  let driveResponse;
  try {
    driveResponse = await fetchWithTimeout(
      buildDownloadUrl(descriptor),
      { credentials: "include", redirect: "follow", cache: "no-store" },
      120000,
      "Google Driveからの取得に2分以上かかったため中止しました。"
    );
  } catch (error) {
    if (/2分以上/.test(error.message)) throw error;
    throw new Error("Google Driveから提出物をメモリ内で取得できませんでした。Chromeの保存画面は開きません。");
  }

  const contentType = (driveResponse.headers.get("content-type") || "").toLowerCase();
  if (!driveResponse.ok || contentType.includes("text/html")) {
    throw new Error("Google DriveからOfficeファイルを取得できませんでした。Chromeの保存画面は開きません。");
  }

  let buffer;
  try {
    buffer = await driveResponse.arrayBuffer();
  } catch {
    throw new Error("提出物ファイルをメモリ内で読み込めませんでした。");
  }
  if (buffer.byteLength > 100 * 1024 * 1024) {
    throw new Error("提出物が100MBを超えているため、メモリ内変換を中止しました。");
  }

  const sourceMetadata = {
    sourceHash: [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    sourceSize: buffer.byteLength,
    etag: driveResponse.headers.get("etag") || "",
    lastModified: driveResponse.headers.get("last-modified") || ""
  };
  // Classroomの選択表示が一瞬遅れて、PDFなのにWordの名前が背景側へ届くことがある。
  // 実データがPDFなら変換を試みず、そのままPDF表示の経路へ渡す。
  if (isPdfBuffer(buffer)) {
    return { buffer, fileName: pdfFileName(expectedName), sourceMetadata, isPdf: true };
  }
  const extension = detectOfficeFormat(buffer, expectedName);
  if (!extension) {
    throw new Error("取得結果がWord／PowerPointファイルではありませんでした。");
  }
  const fileName = /\.(?:docx?|pptx?)$/i.test(expectedName) ? expectedName : `${expectedName}${extension}`;
  return {
    buffer,
    fileName,
    sourceMetadata
  };
}

async function convertInMemory(tabId, submissionKey, descriptor, { reportStatus = true, showPdf = true, cacheIdentity, force = false } = {}) {
  if (reportStatus) await notifyTab(tabId, {
    type: "cwr-status",
    state: "working",
    text: "提出物をメモリ内で取得中…",
    submissionKey
  });
  const documentData = await fetchOfficeBuffer(descriptor);
  if (documentData.isPdf) {
    return storeExistingPdf(tabId, submissionKey, {
      ...descriptor,
      fileName: documentData.fileName
    }, { reportStatus, showPdf, cacheIdentity, force, sourceData: documentData });
  }
  const { buffer, fileName, sourceMetadata } = documentData;

  if (reportStatus) await notifyTab(tabId, {
    type: "cwr-status",
    state: "converting",
    text: "Officeで表示用PDFを作成中…",
    submissionKey
  });

  const response = await fetchWithTimeout(
    `${HELPER_BASE}/convert-upload`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(fileName),
        ...cacheHeaders(cacheIdentity, sourceMetadata, force)
      },
      body: buffer
    },
    300000,
    `${fileName} の変換に5分以上かかったため中止しました。パスワード付きや破損したファイルの可能性があります。`
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "OfficeからPDFへの変換に失敗しました。");
  }
  if (reportStatus && result.cached) await notifyTab(tabId, {
    type: "cwr-status",
    state: "ready",
    text: "準備済みPDFを再利用しています。",
    submissionKey
  });

  const converted = helperResultToConverted(result, fileName, "memory");
  if (showPdf) await notifyTab(tabId, { type: "cwr-show-pdf", submissionKey, ...converted });
  return converted;
}

async function convertGoogleToPdf(tabId, submissionKey, descriptor, { reportStatus = true, showPdf = true, cacheIdentity, force = false } = {}) {
  const baseName = descriptor.fileName || (descriptor.googleType === "presentation" ? "Googleスライド" : "Googleドキュメント");
  const displayName = /\.pdf$/i.test(baseName) ? baseName : `${baseName}.pdf`;
  if (reportStatus) await notifyTab(tabId, {
    type: "cwr-status",
    state: "working",
    text: "Googleから表示用PDFを取得中…",
    submissionKey
  });

  let response;
  try {
    response = await fetchWithTimeout(
      buildGooglePdfExportUrl(descriptor),
      { credentials: "include", redirect: "follow", cache: "no-store", headers: { Accept: "application/pdf" } },
      120000,
      "GoogleからのPDF取得に2分以上かかったため中止しました。"
    );
  } catch (error) {
    if (/2分以上/.test(error.message)) throw error;
    throw new Error("GoogleからPDFを取得できませんでした。Googleへのログイン状態を確認してください。");
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok || contentType.includes("text/html")) {
    throw new Error("Google形式のPDF書き出しに失敗しました。Google上でファイルを開けるか確認してください。");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 100 * 1024 * 1024) throw new Error("PDFが100MBを超えているため、表示を中止しました。");
  const signature = new TextDecoder("latin1").decode(buffer.slice(0, 5));
  if (signature !== "%PDF-") throw new Error("GoogleからPDF形式で取得できませんでした。");
  const sourceHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

  let storeResponse;
  try {
    storeResponse = await fetchWithTimeout(
      `${HELPER_BASE}/store-pdf-upload`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "X-File-Name": encodeURIComponent(displayName),
          ...cacheHeaders(cacheIdentity, {
            sourceHash,
            sourceSize: buffer.byteLength,
            etag: response.headers.get("etag") || "",
            lastModified: response.headers.get("last-modified") || ""
          }, force)
        },
        body: buffer
      },
      120000,
      "表示用PDFの保存に2分以上かかったため中止しました。"
    );
  } catch {
    throw new Error("表示用PDFを保存できませんでした。補助アプリが起動しているか確認してください。");
  }
  const result = await storeResponse.json().catch(() => ({}));
  if (!storeResponse.ok || !result.ok) throw new Error(result.error || "表示用PDFを保存できませんでした。");
  if (reportStatus && result.cached) await notifyTab(tabId, {
    type: "cwr-status",
    state: "ready",
    text: "準備済みPDFを再利用しています。",
    submissionKey
  });
  const converted = helperResultToConverted(result, displayName, "google-pdf");
  if (showPdf) await notifyTab(tabId, { type: "cwr-show-pdf", submissionKey, ...converted });
  return converted;
}

// 提出物がすでにPDFの場合は、Officeでの変換や書き出しをせず、
// Driveからそのままダウンロードして表示用として保存するだけにする。
async function storeExistingPdf(tabId, submissionKey, descriptor, { reportStatus = true, showPdf = true, cacheIdentity, force = false, sourceData = null } = {}) {
  const displayName = /\.pdf$/i.test(descriptor.fileName || "") ? descriptor.fileName : `${descriptor.fileName || "提出物"}.pdf`;
  if (reportStatus) await notifyTab(tabId, {
    type: "cwr-status",
    state: "working",
    text: "PDFの提出物を取得中…",
    submissionKey
  });

  let buffer = sourceData?.buffer || null;
  let sourceMetadata = sourceData?.sourceMetadata || null;
  let driveResponse = null;
  if (!buffer) {
    try {
      driveResponse = await fetchWithTimeout(
        buildDownloadUrl(descriptor),
        { credentials: "include", redirect: "follow", cache: "no-store" },
        120000,
        "Google Driveからの取得に2分以上かかったため中止しました。"
      );
    } catch (error) {
      if (/2分以上/.test(error.message)) throw error;
      throw new Error("Google DriveからPDFを取得できませんでした。");
    }
    const contentType = (driveResponse.headers.get("content-type") || "").toLowerCase();
    if (!driveResponse.ok || contentType.includes("text/html")) {
      throw new Error("Google DriveからPDFを取得できませんでした。");
    }
    buffer = await driveResponse.arrayBuffer();
  }
  if (buffer.byteLength > 100 * 1024 * 1024) throw new Error("PDFが100MBを超えているため、表示を中止しました。");
  if (!isPdfBuffer(buffer)) throw new Error("取得結果がPDF形式ではありませんでした。");
  if (!sourceMetadata) {
    sourceMetadata = {
      sourceHash: [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      sourceSize: buffer.byteLength,
      etag: driveResponse?.headers.get("etag") || "",
      lastModified: driveResponse?.headers.get("last-modified") || ""
    };
  }

  let storeResponse;
  try {
    storeResponse = await fetchWithTimeout(
      `${HELPER_BASE}/store-pdf-upload`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "X-File-Name": encodeURIComponent(displayName),
          ...cacheHeaders(cacheIdentity, {
          ...sourceMetadata
        }, force)
        },
        body: buffer
      },
      120000,
      "PDFの保存に2分以上かかったため中止しました。"
    );
  } catch {
    throw new Error("PDFを保存できませんでした。補助アプリが起動しているか確認してください。");
  }
  const result = await storeResponse.json().catch(() => ({}));
  if (!storeResponse.ok || !result.ok) throw new Error(result.error || "PDFを保存できませんでした。");
  if (reportStatus && result.cached) await notifyTab(tabId, {
    type: "cwr-status", state: "ready", text: "この提出物はもともとPDFです。変換不要で表示します。", submissionKey
  });
  const converted = helperResultToConverted(result, displayName, "pdf-passthrough");
  if (showPdf) await notifyTab(tabId, { type: "cwr-show-pdf", submissionKey, ...converted });
  return converted;
}

async function convertDescriptor(tabId, submissionKey, descriptor, options = {}) {
  const cacheIdentity = cacheIdentityFor(options.cacheIdentity, descriptor);
  const mode = isGoogleNative(descriptor) ? "google-pdf" : (isPdfDescriptor(descriptor) ? "pdf-passthrough" : "memory");
  const fallbackName = descriptor.fileName || "提出物";
  if (!options.force) {
    const cached = await findPersistentCachedPdf(cacheIdentity, descriptor, fallbackName, mode);
    if (cached) {
      if (options.reportStatus) await notifyTab(tabId, {
        type: "cwr-status", state: "ready", text: "保存済みPDFを再利用しています。", submissionKey
      });
      if (options.showPdf !== false) await notifyTab(tabId, { type: "cwr-show-pdf", submissionKey, ...cached });
      return cached;
    }
  }
  const conversionOptions = { ...options, cacheIdentity };
  if (isGoogleNative(descriptor)) return convertGoogleToPdf(tabId, submissionKey, descriptor, conversionOptions);
  if (isPdfDescriptor(descriptor)) return storeExistingPdf(tabId, submissionKey, descriptor, conversionOptions);
  return convertInMemory(tabId, submissionKey, descriptor, conversionOptions);
}

async function prepareCurrentSubmission(tabId, submissionKey, expectedName, expectedFileId, expectedGoogleType, cacheIdentity) {
  await helperHealth();
  const descriptor = await waitForCurrentDocument(tabId, expectedName, expectedFileId, expectedGoogleType);
  if (!descriptor) throw new Error("この提出者のWord／PowerPoint／PDF／Google形式のファイルを見つけられませんでした。");
  const key = descriptorKey(descriptor);
  const prepared = !cacheIdentity && (await getPreparedPdf(key) || await getPreparedPdfById(descriptor.fileId));
  if (prepared) {
    await rememberPreparedPdf(key, submissionKey, prepared, { fileId: descriptor.fileId });
    return { ...prepared, documentKey: key, mode: "prepared", cached: true };
  }

  const result = await convertDescriptor(tabId, submissionKey, descriptor, { reportStatus: true, showPdf: false, cacheIdentity });
  await rememberPreparedPdf(key, submissionKey, result, { fileId: descriptor.fileId });
  return { ...result, documentKey: key, mode: "prepared", cached: false };
}

// 画面に出ていない2件目以降の添付は、Drive上のファイル番号から直接取得する。
// Classroomの表示を切り替える必要がないので、提出者ごとの往復が増えない。
async function prepareAttachment(tabId, message, { showPdf = false } = {}) {
  await helperHealth();
  const fileId = message.expectedFileId || "";
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(fileId)) {
    throw new Error("添付ファイルの識別番号を取得できませんでした。");
  }
  const googleType = ["document", "presentation"].includes(message.expectedGoogleType) ? message.expectedGoogleType : "";
  const page = await sendToFrame(tabId, 0, { type: "cwr-describe-document" });
  const descriptor = {
    fileId,
    fileName: message.fileName || message.expectedName || "",
    googleType,
    downloadUrl: "",
    authuser: Number.isInteger(page?.authuser) ? page.authuser : 0
  };

  const submissionKey = message.submissionKey || "";
  const primary = message.primary === true;
  const key = descriptorKey(descriptor);
  const prepared = !message.cacheIdentity && (await getPreparedPdf(key) || await getPreparedPdfById(fileId));
  if (prepared) {
    await rememberPreparedPdf(key, submissionKey, prepared, { primary, fileId });
    if (showPdf) await notifyTab(tabId, { type: "cwr-show-pdf", submissionKey, ...prepared });
    return { ...prepared, documentKey: key, mode: "prepared", cached: true };
  }

  const result = await convertDescriptor(tabId, submissionKey, descriptor, { reportStatus: true, showPdf, cacheIdentity: message.cacheIdentity });
  await rememberPreparedPdf(key, submissionKey, result, { primary, fileId });
  return { ...result, documentKey: key, mode: "prepared", cached: false };
}

async function startOfficeWindow(tabId, submissionKey, expectedName = "", expectedFileId = "") {
  await helperHealth();
  const descriptor = await waitForCurrentDocument(tabId, expectedName, expectedFileId);
  if (!descriptor || isGoogleNative(descriptor)) {
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
  const response = await fetchWithTimeout(
    `${HELPER_BASE}${endpoint}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(documentData.fileName)
      },
      body: documentData.buffer
    },
    180000,
    "別ウィンドウの準備に3分以上かかったため中止しました。"
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || "別ウィンドウを開けませんでした。");
  }
  return { ok: true, fileName: result.sourceName || documentData.fileName, mode: powerpoint ? "powerpoint-show" : "word-window", completed: true };
}

async function closeOfficeWindow() {
  const response = await fetchWithTimeout(
    `${HELPER_BASE}/close-office-window`,
    { method: "POST" },
    60000,
    "別ウィンドウを閉じる処理が終わりませんでした。"
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "別ウィンドウを閉じられませんでした。");
  return { ok: true };
}

async function releasePdf(pdfUrl) {
  if (typeof pdfUrl !== "string" || !/^http:\/\/127\.0\.0\.1:18765\/file\/[a-f0-9]{24}\.pdf$/.test(pdfUrl)) {
    throw new Error("削除対象の表示用PDFが正しくありません。");
  }
  const stored = await chrome.storage.local.get(PREPARED_KEY);
  if (Object.values(stored[PREPARED_KEY] || {}).some((item) => item.pdfUrl === pdfUrl)) {
    return { ok: true, retained: true };
  }
  const response = await fetchWithTimeout(
    pdfUrl.replace("/file/", "/release/"),
    { method: "POST" },
    30000,
    "表示用PDFの削除が終わりませんでした。"
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "表示用PDFを削除できませんでした。");
  return { ok: true };
}

async function cacheSummary() {
  await helperHealth();
  const response = await fetchWithTimeout(
    `${HELPER_BASE}/cache-summary`,
    { cache: "no-store" },
    30000,
    "キャッシュ使用量の確認に時間がかかっています。"
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "キャッシュ使用量を確認できませんでした。");
  return result;
}

async function cleanupCache(message) {
  await helperHealth();
  const response = await fetchWithTimeout(
    `${HELPER_BASE}/cache-cleanup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: message.mode, identity: message.cacheIdentity, olderThanDays: message.olderThanDays })
    },
    60000,
    "キャッシュ整理に時間がかかっています。"
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || "キャッシュを整理できませんでした。");
  preparedPdfs.clear();
  preparedSubmissions.clear();
  preparedPdfsById.clear();
  await chrome.storage.local.remove([PREPARED_KEY, PREPARED_SUBMISSIONS_KEY, PREPARED_IDS_KEY]);
  return result;
}

async function startConversion(tabId, submissionKey, expectedName = "", expectedFileId = "", expectedGoogleType = "", cacheIdentity = null, force = false) {
  await helperHealth();
  // ファイル番号が分かっているときは、その番号で引いた準備済みPDFを最優先する。
  // 提出者単位の索引を先に見ると、2件目を選んでいるのに1件目が出てしまう。
  if (!force && !cacheIdentity && (expectedFileId || expectedName)) {
    const directKey = descriptorKey({ fileId: expectedFileId, fileName: expectedName });
    // ファイル番号が分からないときに名前だけで代替検索すると、同じファイル名で
    // 提出する別の学生の準備済みPDFを取り違える恐れがあるため、ここでは
    // ファイル番号（Drive上のID）が確認できた場合しか再利用しない。
    const preparedByFile = await getPreparedPdf(directKey)
      || await getPreparedPdfById(expectedFileId);
    if (preparedByFile) {
      await rememberPreparedPdf(directKey, submissionKey, preparedByFile, { fileId: expectedFileId });
      await notifyTab(tabId, {
        type: "cwr-show-pdf",
        pdfUrl: preparedByFile.pdfUrl,
        fileName: preparedByFile.fileName,
        pageCount: preparedByFile.pageCount,
        submissionKey
      });
      return { ...preparedByFile, mode: "prepared" };
    }
  }

  // ファイル番号が取れない場合だけ、提出者単位の索引にたよる。
  if (!force && !cacheIdentity && !expectedFileId) {
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
  }

  const descriptor = await waitForCurrentDocument(tabId, expectedName, expectedFileId, expectedGoogleType);
  if (!descriptor) {
    throw new Error("表示中のWord／PowerPoint／PDF／Google形式のファイルを見つけられませんでした。Classroomを再読み込みしてください。");
  }

  const key = descriptorKey(descriptor);
  const prepared = !force && !cacheIdentity && (await getPreparedPdf(key) || await getPreparedPdfById(descriptor.fileId));
  if (prepared) {
    await rememberPreparedPdf(key, submissionKey, prepared, { fileId: descriptor.fileId });
    await notifyTab(tabId, {
      type: "cwr-show-pdf",
      pdfUrl: prepared.pdfUrl,
      fileName: prepared.fileName,
      pageCount: prepared.pageCount,
      submissionKey
    });
    return { ...prepared, mode: "prepared" };
  }

  const converted = await convertDescriptor(tabId, submissionKey, descriptor, { cacheIdentity, force });
  // 採点画面で変換したPDFも索引に残す。次に同じファイルを開いたとき、
  // 変換をやり直さずそのまま再利用できる。
  await rememberPreparedPdf(key, submissionKey, converted, { fileId: descriptor.fileId });
  return converted;
}

if (globalThis.__CWR_BACKGROUND_TEST_HOOKS__) {
  Object.assign(globalThis.__CWR_BACKGROUND_TEST_HOOKS__, {
    buildGooglePdfExportUrl,
    findCurrentDocument,
    isGoogleNative,
    isPdfBuffer,
    pdfFileName,
    getPreparedPdf,
    getPreparedPdfById,
    getPreparedSubmission,
    rememberPreparedPdf
  });
}

const messageHandlers = {
  "cwr-start": (tabId, message) => startConversion(tabId, message.submissionKey || "", message.expectedName || "", message.expectedFileId || "", message.expectedGoogleType || "", message.cacheIdentity, message.force === true),
  "cwr-prepare-one": (tabId, message) => prepareCurrentSubmission(tabId, message.submissionKey || "", message.expectedName || "", message.expectedFileId || "", message.expectedGoogleType || "", message.cacheIdentity),
  "cwr-prepare-attachment": (tabId, message) => prepareAttachment(tabId, message),
  "cwr-open-attachment": (tabId, message) => prepareAttachment(tabId, message, { showPdf: true }),
  "cwr-start-bulk-preparation": (tabId) => startBulkPreparation(tabId),
  "cwr-prefetch-next": (tabId) => startBulkPreparation(tabId, { prefetch: true }),
  "cwr-prepare-progress": (tabId, message) => relayPreparationProgress(tabId, message.progress || {}),
  "cwr-cancel-bulk-preparation": () => cancelBulkPreparation(),
  "cwr-focus-preparation-tab": () => focusPreparationTab(),
  "cwr-focus-source-tab": () => focusSourceTab(),
  "cwr-preparation-role": (tabId) => describePreparationRole(tabId),
  // 背面タブではsetTimeoutが最大1分まで遅れるため、待ち時間をここで計る。
  "cwr-sleep": (_tabId, message) => sleep(message.ms),
  "cwr-open-office": (tabId, message) => startOfficeWindow(tabId, message.submissionKey || "", message.expectedName || "", message.expectedFileId || ""),
  "cwr-close-office": () => closeOfficeWindow(),
  "cwr-release-pdf": (_tabId, message) => releasePdf(message.pdfUrl)
  ,"cwr-cache-summary": () => cacheSummary()
  ,"cwr-cache-cleanup": (_tabId, message) => cleanupCache(message)
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message?.type];
  if (!handler) return false;

  (async () => {
    try {
      const tabId = sender.tab?.id;
      if (typeof tabId !== "number") throw new Error("Classroomのタブを特定できませんでした。");
      sendResponse(await handler(tabId, message));
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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const preparationState = await getPreparationState();
  if (!preparationState) return;
  if (preparationState.sourceTabId === tabId) {
    // 採点タブが閉じられても準備は続ける。進捗の送り先だけ空にする。
    await patchPreparationState({ sourceTabId: null, sourceWindowId: null });
    return;
  }
  if (preparationState.tabId !== tabId) return;
  if (preparationState.status === "running") {
    await notifyTab(preparationState.sourceTabId, {
      type: "cwr-prepare-remote-progress",
      status: "error",
      title: "一括準備を中断しました",
      countText: "準備専用タブが閉じられました",
      detailText: "もう一度「全員分を一括準備」を押すと、変換済みの提出物はやり直さずに続きを準備します。"
    });
    await focusTab(preparationState.sourceTabId, preparationState.sourceWindowId);
  }
  await setPreparationState(null);
});
