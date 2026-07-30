import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

const googleId = "1DU7iOdEq70uDVcuPWp-eD7wiBHbFlquiBeR9tPsZcG8";
const responses = new Map();
const event = { addListener() {} };
const storageArea = {
  async get() { return {}; },
  async remove() {},
  async set() {}
};
const hooks = {};
const chrome = {
  downloads: { onChanged: event, onErased: event },
  runtime: { getManifest: () => ({ version: "0.5.12" }), onMessage: event },
  storage: { local: storageArea, session: storageArea },
  tabs: {
    onRemoved: event,
    async sendMessage(_tabId, _message, { frameId }) { return responses.get(frameId) || null; }
  },
  webNavigation: {
    async getAllFrames() {
      return [
        { frameId: 0, url: "https://classroom.google.com/u/5/g/tg/course/work" },
        { frameId: 1, url: `https://docs.google.com/document/d/${googleId}/grading?authuser=5` }
      ];
    }
  }
};
const context = vm.createContext({
  __CWR_BACKGROUND_TEST_HOOKS__: hooks,
  URLSearchParams,
  chrome,
  console,
  fetch,
  globalThis: null,
  queueMicrotask,
  setTimeout,
  TextDecoder,
  Uint8Array
});
context.globalThis = context;
vm.runInContext(background, context);

responses.set(0, {
  fileName: "2610170400八木 近大ゼミ2026＿期末レポート.docx",
  fileId: googleId,
  googleType: "document",
  authuser: 5,
  frameUrl: "https://classroom.google.com/u/5/g/tg/course/work"
});
responses.set(1, {
  fileName: "Googleドキュメント",
  fileId: googleId,
  googleType: "document",
  authuser: null,
  frameUrl: `https://docs.google.com/document/d/${googleId}/grading?authuser=5`
});

const selectedGoogle = await hooks.findCurrentDocument(1);
assert.equal(selectedGoogle.googleType, "document");
assert.equal(hooks.isGoogleNative(selectedGoogle), true);
assert.equal(
  hooks.buildGooglePdfExportUrl(selectedGoogle),
  `https://docs.google.com/document/d/${googleId}/export?format=pdf&authuser=5`
);

responses.set(0, {
  fileName: "report.docx",
  fileId: "word-file-id-123456789012345",
  googleType: "",
  authuser: 5,
  frameUrl: "https://classroom.google.com/u/5/g/tg/course/work"
});
responses.set(1, {
  fileName: "report.docx",
  fileId: "word-file-id-123456789012345",
  googleType: "",
  authuser: null,
  frameUrl: "https://docs.google.com/file/d/word-file-id-123456789012345/grading"
});
const selectedWord = await hooks.findCurrentDocument(1);
assert.equal(hooks.isGoogleNative(selectedWord), false);

console.log("Background routing distinguishes native Google documents from Office files.");
