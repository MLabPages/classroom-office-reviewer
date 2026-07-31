import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

class MockElement {
  constructor({ text = "", attributes = {}, src = "" } = {}) {
    this.textContent = text;
    this.attributes = attributes;
    this.src = src;
    this.href = "";
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  getBoundingClientRect() {
    return { width: 600, height: 60, top: 60 };
  }
}

function runDetection({ nodes = [], frames = [] }) {
  const hooks = {};
  const location = {
    hostname: "classroom.google.com",
    href: "https://classroom.google.com/u/5/g/tg/course/work#u=student&t=f"
  };
  const window = {};
  window.top = window;
  const document = {
    querySelectorAll(selector) {
      if (selector === "iframe[src]") return frames;
      if (selector === "a[href], iframe[src]") return frames;
      return nodes;
    }
  };
  const context = vm.createContext({
    __CWR_TEST_HOOKS__: hooks,
    Element: MockElement,
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    globalThis: null,
    location,
    window
  });
  context.globalThis = context;
  vm.runInContext(content, context);
  return hooks;
}

const duplicateWordName = "2610170399近大ゼミ2026＿期末レポート.docx";
const wordHooks = runDetection({
  nodes: [new MockElement({ text: `Microsoft Word: ${duplicateWordName}${duplicateWordName}` })]
});
assert.equal(wordHooks.findOfficeFileName(), duplicateWordName);
assert.equal(wordHooks.findSupportedFileInfo().kind, "office");

const googleFileId = "1DU7iOdEq70uDVcuPWp-eD7wiBHbFlquiBeR9tPsZcG8";
const googleTitle = "2610170400八木 近大ゼミ2026＿期末レポート.docx";
const googleHooks = runDetection({
  nodes: [new MockElement({ attributes: { "aria-label": `Google ドキュメント: ${googleTitle}` } })],
  frames: [new MockElement({ src: `https://docs.google.com/document/d/${googleFileId}/grading?authuser=5` })]
});
assert.deepEqual(
  JSON.parse(JSON.stringify(googleHooks.findSupportedFileInfo())),
  {
    kind: "google-document",
    fileName: googleTitle,
    expectedName: "",
    expectedFileId: googleFileId,
    expectedGoogleType: "document"
  }
);
assert.equal(googleHooks.describeDocument().googleType, "document");

const loadingGoogleHooks = runDetection({
  nodes: [new MockElement({ attributes: { "aria-label": `Google ドキュメント: ${googleTitle}` } })]
});
assert.equal(loadingGoogleHooks.findSupportedFileInfo().expectedGoogleType, "document");
assert.equal(loadingGoogleHooks.findSupportedFileInfo().expectedFileId, "");
assert.equal(loadingGoogleHooks.describeDocument().googleType, "");
assert.deepEqual(JSON.parse(JSON.stringify(loadingGoogleHooks.inspectSubmissionFile())), { waiting: true });

const pdfHooks = runDetection({
  nodes: [new MockElement({ attributes: { "aria-label": "PDF: submitted-report.pdf" } })]
});
assert.equal(pdfHooks.findSupportedFileInfo(), null);
assert.equal(pdfHooks.findAnyAttachmentFileName(), "submitted-report.pdf");
assert.deepEqual(JSON.parse(JSON.stringify(pdfHooks.inspectSubmissionFile())), { unsupported: true });

const slidesHooks = runDetection({
  nodes: [new MockElement({ attributes: { "aria-label": "Google スライド: presentation.pptx" } })],
  frames: [new MockElement({ src: `https://docs.google.com/presentation/u/5/d/${googleFileId}/edit` })]
});
assert.equal(slidesHooks.findSupportedFileInfo().kind, "google-presentation");
assert.equal(slidesHooks.findSupportedFileInfo().expectedGoogleType, "presentation");
assert.equal(slidesHooks.findSupportedFileInfo().expectedFileId, googleFileId);

console.log("Content detection handles Word duplicates, native Google documents, and PDF submissions.");
