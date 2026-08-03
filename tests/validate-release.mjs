import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedVersion = "0.9.3";
const expectedPort = "18765";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const [manifestText, background, content, viewer, viewerHtml, server, start, stop, powerPointConverter] = await Promise.all([
  read("extension/manifest.json"),
  read("extension/background.js"),
  read("extension/content.js"),
  read("extension/viewer.js"),
  read("extension/viewer.html"),
  read("native/server.mjs"),
  read("native/Start-Reviewer.ps1"),
  read("native/Stop-Reviewer.ps1"),
  read("native/Convert-PowerPoint.ps1")
]);

const manifest = JSON.parse(manifestText);
assert.equal(manifest.version, expectedVersion);
assert(manifest.host_permissions.includes(`http://127.0.0.1:${expectedPort}/*`));
assert(background.includes(`const HELPER_BASE = "http://127.0.0.1:${expectedPort}";`));
assert(background.includes(`127\\.0\\.0\\.1:${expectedPort}`));
assert(background.includes("const PREPARED_MAXIMUM = 600;"));
assert(background.includes("chrome.storage.local"));
assert(!background.includes("getPreparedPdfByName"));
assert(background.includes("if (primary)"));
assert(background.includes("chrome.runtime.getManifest().version"));
assert(background.includes("buildGooglePdfExportUrl"));
assert(background.includes("/store-pdf-upload"));
assert(!background.includes("chrome.downloads"));
assert(!manifest.permissions.includes("downloads"));
assert.equal((background.match(/chrome\.tabs\.create/g) || []).length, 1);
assert(!background.includes("chrome.tabs.remove("));
assert(background.includes("const PREPARATION_TAB_KEY"));
assert(content.includes('id="cwr-prepare"'));
assert(content.includes('id="cwr-reconvert"'));
assert(content.includes('id="cwr-cache"'));
assert(content.includes('id="cwr-show-preparation"'));
assert(content.includes("function getCacheIdentity"));
assert(content.includes("function showPreparationPanel"));
assert(content.includes("preparationPanelHidden"));
assert(content.includes('openButton.textContent = "PDFで表示"'));
assert(content.includes('type: "cwr-cache-summary"'));
assert(content.includes('"cwr-prepare-one"'));
// 1人が複数ファイルを出した場合、2件目以降も準備する経路が要る。
assert(content.includes('"cwr-prepare-attachment"'));
assert(content.includes("function findSubmissionAttachments"));
assert(content.includes("function findSubmissionFileMenuItems"));
assert(content.includes("function selectedSubmissionAttachment"));
assert(content.includes("function selectSubmissionFile"));
assert(content.includes("state.fileSwitching"));
assert(content.includes("function listSubmissionFiles"));
// 準備済みPDFはファイル番号でも引けるようにして、二重変換を防ぐ。
assert(background.includes("async function getPreparedPdfById"));
assert(background.includes("const PREPARED_IDS_KEY"));
// Classroomの表示を正として番号を合わせる。
assert(content.includes("function findDisplayedFileId"));
assert(content.includes("async function openFileMenu"));
assert(background.includes("async function prepareAttachment"));
assert(background.includes('"cwr-open-attachment"'));
assert(content.includes("expectedGoogleType"));
assert(content.includes("sequence === 1 && initialFileInfo"));
assert(content.includes('googleType'));
assert(content.includes('次の(?:生徒|学生|ユーザー|提出者)'));
assert(content.includes("function isSubmissionView()"));
assert(content.includes("function waitForSubmissionView"));
assert(content.includes('id="cwr-preparation-compact"'));
assert(content.includes('id="cwr-preparation-focus"'));
// 準備専用タブが背面でも進み続けるための仕組みが外れていないか確かめる。
assert(background.includes('"cwr-sleep"'));
assert(content.includes('type: "cwr-sleep"'));
assert(background.includes("async function inspectPreparationTab"));
assert(background.includes("async function fetchWithTimeout"));
// 通信はすべて fetchWithTimeout 経由（素の fetch は helper 内の1か所だけ）。
assert.equal((background.match(/await fetch\(/g) || []).length, 1);
// 一括準備は前面、次の数件の先読みは背面で開く。
assert(background.includes("active: !prefetch"));
assert(background.includes('"cwr-prefetch-next"'));
assert(content.includes("function startStallWatchdog"));
assert(content.includes("const BACKGROUND_RETRY_MS = 10000;"));
assert(content.includes("const BACKGROUND_STALLED_RETRY_MS = 30000;"));
assert(content.includes("function waitForSubmissionFileWithRecovery"));
assert(content.includes("function currentDisplayedFileInfo"));
assert(content.includes("function logCurrentFileContext"));
assert(!content.includes("function waitForVisibleTab"));
assert(content.includes('id="cwr-controls-toggle"'));
assert(content.includes('id="cwr-controls-drag"'));
assert(viewerHtml.includes('id="reconvert"'));
assert(viewer.includes('type: "cwr-reconvert"'));
// `unload`はChromeで廃止予定。戻すと採点画面に警告が出続ける。
assert(content.includes('window.addEventListener("pagehide"'));
assert(!content.includes('addEventListener("unload"'));
// 学生切替は、表示中のファイル番号が入れ替わるまで完了と見なさない。
// ここを戻すと、前の提出物のまま同じPDFが再表示される。
assert(content.includes("async function waitForSubmissionChange(previousKey, timeoutMs = 20000, previousFileId"));
assert(content.includes("waitForSubmissionChange(before, 8000, beforeFileId)"));
assert(content.includes("waitForSubmissionChange(before, 20000, beforeFileId)"));
// 遅れて届いた前のファイルの変換結果で、新しい表示を上書きしない。
assert(content.includes("function matchesRequestedFile"));
assert(content.includes("if (!matchesRequestedFile(message))"));
// 設定の読み書きは必ず受け止める。直接呼ぶと、拡張機能の更新後に残った
// 古いタブで「Extension context invalidated.」がコンソールへ出る。
assert(content.includes("function saveSetting"));
assert(content.includes("function loadSettings"));
assert(content.includes("function extensionContextLost"));
assert(content.includes("function contextAvailable"));
assert(content.includes("state.mutationObserver?.disconnect()"));
assert.equal((content.match(/chrome\.storage\.local\.(?:get|set)\(/g) || []).length, 2);
assert(content.includes("function becomePreparationTab"));
assert(content.includes('findFileName("docx?|pptx?|pdf|'));
// PDFの提出物はOffice変換をせず、直接ダウンロードして表示・カウント対象にする。
assert(content.includes("function findPdfFileName"));
assert(content.includes('kind: "pdf"'));
assert(background.includes("function isPdfDescriptor"));
assert(background.includes("async function storeExistingPdf"));
assert(background.includes("if (isPdfDescriptor(descriptor)) return storeExistingPdf"));
assert(viewer.includes(`pdfUrl.startsWith("http://127.0.0.1:${expectedPort}/file/")`));
assert(viewerHtml.includes("前の提出物"));
assert(viewerHtml.includes('id="submission-search"'));
assert(viewerHtml.includes('id="submission-panel"'));
assert(viewer.includes("filterSubmissionEntries"));
assert(manifest.web_accessible_resources[0].resources.includes("submission-list.js"));
assert(viewer.includes('type: "cwr-select-submission"'));
assert(content.includes("submissionCatalog"));
assert(content.includes("SUBMISSION_CATALOG_STORAGE_KEY"));
assert(content.includes("loadSubmissionCatalog"));
assert(content.includes("cachedPdfUrl"));
assert(content.includes('event.data?.type === "cwr-select-submission"'));
assert(content.includes("function openExternalSubmission"));
assert(viewer.includes('loadPdf(pdfUrl, fileName, params.get("pages")).catch(showError);'));
assert(/\r?\n}\r?\nloadPdf\(pdfUrl, fileName, params\.get\("pages"\)\)/.test(viewer));
assert(server.includes(`const port = ${expectedPort};`));
assert(server.includes("version: appVersion"));
assert(server.includes('"ClassroomReviewer"'));
assert(server.includes("const cacheWarningBytes = 10 * 1024 * 1024 * 1024;"));
assert(server.includes('url.pathname === "/cache-lookup"'));
assert(server.includes('url.pathname === "/cache-summary"'));
assert(server.includes('url.pathname === "/cache-cleanup"'));
assert(!server.includes("await clearPdfCache();"));
assert(server.includes("await pruneTemporaryFiles();"));
assert(server.includes('url.pathname === "/store-pdf-upload"'));
// PowerPointが .pdf.part.pdf を作らず、補助アプリが確認する名前へ移す。
assert(powerPointConverter.includes("$powerPointTarget"));
assert(powerPointConverter.includes("$target.EndsWith('.pdf.part'"));
assert(powerPointConverter.includes("$presentation.SaveAs($powerPointTarget, 32)"));
assert(powerPointConverter.includes("Move-Item -LiteralPath $powerPointTarget -Destination $target -Force"));
assert(start.includes("-Encoding UTF8"));
assert(start.includes(`http://127.0.0.1:${expectedPort}/health`));
assert(start.includes("$health.version -eq $expectedVersion"));
assert(start.includes(`http://127.0.0.1:${expectedPort}/shutdown`));
assert(start.includes('-ArgumentList @("`"$serverPath`"")'));
assert(stop.includes(`http://127.0.0.1:${expectedPort}/health`));
assert(stop.includes(`http://127.0.0.1:${expectedPort}/shutdown`));

await import("./content-detection.mjs");
await import("./background-routing.mjs");

console.log(`Release settings are consistent for v${expectedVersion} on port ${expectedPort}.`);
