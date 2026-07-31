import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedVersion = "0.7.7";
const expectedPort = "18765";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const [manifestText, background, content, viewer, viewerHtml, server, start, stop] = await Promise.all([
  read("extension/manifest.json"),
  read("extension/background.js"),
  read("extension/content.js"),
  read("extension/viewer.js"),
  read("extension/viewer.html"),
  read("native/server.mjs"),
  read("native/Start-Reviewer.ps1"),
  read("native/Stop-Reviewer.ps1")
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
assert(content.includes('"cwr-prepare-one"'));
// 1人が複数ファイルを出した場合、2件目以降も準備する経路が要る。
assert(content.includes('"cwr-prepare-attachment"'));
assert(content.includes("function findSubmissionAttachments"));
assert(content.includes("function findSubmissionFileMenuItems"));
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
assert(content.includes('次の(?:生徒|学生)を選択'));
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
// 準備専用タブは前面で開く。背面だとChromeが処理を止める。
// 改行コードに左右されないよう、行をまたいだ正規表現で確かめる。
assert(/chrome\.tabs\.create\(\{[^}]*active: true/.test(background));
assert(content.includes("function startStallWatchdog"));
assert(content.includes("function becomePreparationTab"));
assert(content.includes('findFileName("docx?|pptx?|pdf|'));
assert(viewer.includes(`pdfUrl.startsWith("http://127.0.0.1:${expectedPort}/file/")`));
assert(viewerHtml.includes("前の提出物"));
assert(viewer.includes('loadPdf(pdfUrl, fileName, params.get("pages")).catch(showError);'));
assert(/\r?\n}\r?\nloadPdf\(pdfUrl, fileName, params\.get\("pages"\)\)/.test(viewer));
assert(server.includes(`const port = ${expectedPort};`));
assert(server.includes("version: appVersion"));
assert(server.includes("const cacheMaximumPdfs = 600;"));
assert(server.includes('url.pathname === "/store-pdf-upload"'));
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
