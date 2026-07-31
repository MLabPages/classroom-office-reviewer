import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

const googleId = "1DU7iOdEq70uDVcuPWp-eD7wiBHbFlquiBeR9tPsZcG8";
const responses = new Map();
const storageData = {};
const event = { addListener() {} };
const storageArea = {
  async get(keys) {
    if (!keys) return { ...storageData };
    const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    return Object.fromEntries(names.filter((name) => Object.prototype.hasOwnProperty.call(storageData, name))
      .map((name) => [name, storageData[name]]));
  },
  async remove(keys) {
    const names = typeof keys === "string" ? [keys] : keys;
    for (const name of names) delete storageData[name];
  },
  async set(values) { Object.assign(storageData, values); }
};
const hooks = {};
const chrome = {
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
  submissionView: true,
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
assert.equal(selectedGoogle.fileName, "2610170400八木 近大ゼミ2026＿期末レポート.docx");
assert.equal(hooks.isGoogleNative(selectedGoogle), true);
assert.equal(
  hooks.buildGooglePdfExportUrl(selectedGoogle),
  `https://docs.google.com/document/d/${googleId}/export?format=pdf&authuser=5`
);

assert.equal(
  hooks.buildGooglePdfExportUrl({ fileId: googleId, googleType: "presentation", authuser: 5 }),
  `https://docs.google.com/presentation/d/${googleId}/export/pdf?authuser=5`
);

responses.set(0, {
  fileName: "report.docx",
  fileId: "word-file-id-123456789012345",
  googleType: "",
  submissionView: true,
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

responses.set(0, {
  fileName: "overview-card.docx",
  fileId: "overview-file-id-1234567890123",
  googleType: "",
  submissionView: false,
  authuser: 5,
  frameUrl: "https://classroom.google.com/u/5/g/tg/course/work"
});
assert.equal(await hooks.findCurrentDocument(1), null);

// 2件目以降を保存しても、学生単位で最初に表示するPDFを上書きしない。
const primaryPdf = { ok: true, fileName: "first.docx", pdfUrl: "http://127.0.0.1:18765/file/aaaaaaaaaaaaaaaaaaaaaaaa.pdf" };
const secondaryPdf = { ok: true, fileName: "second.pptx", pdfUrl: "http://127.0.0.1:18765/file/bbbbbbbbbbbbbbbbbbbbbbbb.pdf" };
await hooks.rememberPreparedPdf("first-id|first.docx", "student-key", primaryPdf, { primary: true });
await hooks.rememberPreparedPdf("second-id|second.pptx", "student-key", secondaryPdf, { primary: false });
assert.equal(storageData.classroomWordReviewerPreparedSubmissions["student-key"].fileName, "first.docx");
assert.equal((await hooks.getPreparedPdf("second-id|second.pptx")).fileName, "second.pptx");

console.log("Background routing only accepts an open submission, then distinguishes native Google documents from Office files.");
