import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedVersion = "0.5.9";
const expectedPort = "18765";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const [manifestText, background, content, viewer, server, start, stop] = await Promise.all([
  read("extension/manifest.json"),
  read("extension/background.js"),
  read("extension/content.js"),
  read("extension/viewer.js"),
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
assert.equal((background.match(/chrome\.tabs\.create/g) || []).length, 1);
assert(!background.includes("chrome.tabs.remove("));
assert(background.includes("const PREPARATION_TAB_KEY"));
assert(content.includes('id="cwr-prepare"'));
assert(content.includes('type: "cwr-prepare-one"'));
assert(viewer.includes(`pdfUrl.startsWith("http://127.0.0.1:${expectedPort}/file/")`));
assert(server.includes(`const port = ${expectedPort};`));
assert(server.includes(`version: "${expectedVersion}"`));
assert(server.includes("const cacheMaximumPdfs = 600;"));
assert(start.includes(`http://127.0.0.1:${expectedPort}/health`));
assert(start.includes('-ArgumentList @("`"$serverPath`"")'));
assert(stop.includes(`http://127.0.0.1:${expectedPort}/health`));
assert(stop.includes(`http://127.0.0.1:${expectedPort}/shutdown`));

console.log(`Release settings are consistent for v${expectedVersion} on port ${expectedPort}.`);
