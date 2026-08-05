import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedVersion = "0.9.6";
const expectedPort = "18765";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const [manifestText, background, content, viewer, viewerHtml, server, start, stop, powerPointConverter, bulkZip, bulkZipCore, bulkZipHtml, zipWriter] = await Promise.all([
  read("extension/manifest.json"),
  read("extension/background.js"),
  read("extension/content.js"),
  read("extension/viewer.js"),
  read("extension/viewer.html"),
  read("native/server.mjs"),
  read("native/Start-Reviewer.ps1"),
  read("native/Stop-Reviewer.ps1"),
  read("native/Convert-PowerPoint.ps1"),
  read("extension/bulk-zip.js"),
  read("extension/bulk-zip-core.js"),
  read("extension/bulk-zip.html"),
  read("extension/zip-writer.js")
]);

const manifest = JSON.parse(manifestText);
assert.equal(manifest.version, expectedVersion);
assert.equal(typeof manifest.key, "string");
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
assert(content.includes('SUBMISSION_CATALOG_STORAGE_KEY = "classroomWordReviewerSubmissionCatalogV2"'));
assert(content.includes("function insideReviewerUi"));
assert(content.includes("function visibleSubmissionAttachmentHints"));
assert(content.includes("allowUnscopedHiddenDriveLinks"));
assert(content.includes("allowUnscopedHiddenDriveLinks && isDriveUrl(fileUrlOf(node))"));
assert(content.includes("!visible(node) && !allowUnscopedHiddenDriveLinks"));
assert(content.includes("function logCurrentFileContext"));
assert(!content.includes("function waitForVisibleTab"));
assert(content.includes('id="cwr-controls-toggle"'));
assert(content.includes('id="cwr-controls-drag"'));
assert(viewerHtml.includes('id="reconvert"'));
assert(viewer.includes('type: "cwr-reconvert"'));
// `unload`はChromeで廃止予定。戻すと採点画面に警告が出続ける。
assert(content.includes('window.addEventListener("pagehide"'));
assert(!content.includes('addEventListener("unload"'));
// 学生切替はURLの学生ID変化だけで確認し、ファイル表示は次のループで別に待つ。
// 前のPDFが残っている間はsubmissionFileStillPreviousで受理しない。
assert(content.includes("async function waitForStudentNavigation(previousKey, timeoutMs = 10000)"));
assert(content.includes("waitForStudentNavigation(before, 10000)"));
assert(content.includes("function submissionFileStillPrevious"));
assert(content.includes("waitForSubmissionFileWithRecovery(15000, previousDisplayedFileId, studentKey)"));
assert(content.includes('status: "pdf-direct"'));
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
assert(server.includes('allowedExtensionId = extensionIdFromManifestKey(manifest.key)'));
assert(server.includes('return isAllowedOrigin(origin, allowedExtensionId);'));
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

// 提出物のZIP一括ダウンロード。追加の権限を使わず、取得とZIP作成は
// 拡張機能のオリジンのページ（bulk-zip.html）だけで行う。
assert(content.includes('id="cwr-zip"'));
assert(content.includes("function showZipDialog"));
assert(content.includes("function collectZipSubmissions"));
assert(content.includes("function readClassroomRoster"));
assert(content.includes("function downloadZipBlob"));
assert(content.includes('chrome.runtime.getURL("bulk-zip.html")'));
// ZIP作成中は一括準備と同時に走らせない。多重実行も防ぐ。
assert(content.includes("if (zipRun.running) return;"));
assert(content.includes("if (zipRun.collecting) return;"));
// 未提出の提出者では提出物の表示を待たずに次へ進む。
assert(content.includes("ZIP_SUBMITTED_STATUS"));
assert(manifest.web_accessible_resources[0].resources.includes("bulk-zip.html"));
assert(manifest.web_accessible_resources[0].resources.includes("bulk-zip.js"));
assert(manifest.web_accessible_resources[0].resources.includes("bulk-zip-core.js"));
assert(manifest.web_accessible_resources[0].resources.includes("zip-writer.js"));
// 追加の権限は使わない。保存はページ側のリンク操作で行う。
assert(!content.includes("chrome.downloads"));
assert(!bulkZip.includes("chrome.downloads"));
assert.deepEqual(manifest.permissions, ["storage", "tabs", "webNavigation", "nativeMessaging"]);
// 取得先はDriveとGoogleドキュメントだけ。外部のCDNやライブラリは読み込まない。
assert(bulkZipHtml.includes('<script type="module" src="bulk-zip.js"></script>'));
assert(!/https?:\/\/(?!drive|docs|classroom)/.test(bulkZipHtml));
assert(bulkZip.includes('const PARENT_ORIGIN = "https://classroom.google.com";'));
assert(bulkZip.includes("event.origin !== PARENT_ORIGIN"));
assert(bulkZip.includes("credentials: \"include\""));
// Google形式は変換ファイルと原本リンクの両方を残す。
assert(bulkZipCore.includes('role: "google-original"'));
assert(bulkZipCore.includes("[InternetShortcut]"));
assert(bulkZipCore.includes("function extractStudentNumber"));
assert(bulkZipCore.includes("function uniqueEntryPath"));
assert(bulkZipCore.includes("提出物一覧") === false, "CSVの名前はbulk-zip.js側で決める");
assert(bulkZip.includes("提出物一覧.csv"));
assert(bulkZip.includes("提出物一覧.json"));
// ZIPはブラウザ標準の機能だけで作る（外部ライブラリを増やさない）。
assert(zipWriter.includes('new CompressionStream("deflate-raw")'));
assert(zipWriter.includes("0x0800"));

await import("./content-detection.mjs");
await import("./background-routing.mjs");
await import("./native-origin.mjs");
await import("./submission-list.mjs");
await import("./bulk-zip.mjs");

console.log(`Release settings are consistent for v${expectedVersion} on port ${expectedPort}.`);
