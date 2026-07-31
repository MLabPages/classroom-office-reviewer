import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

class MockElement {
  constructor({ text = "", attributes = {}, src = "", href = "", rect = { width: 600, height: 60, top: 60 } } = {}) {
    this.textContent = text;
    this.attributes = attributes;
    this.src = src;
    this.href = href;
    this.rect = rect;
    this.parentElement = null;
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  getBoundingClientRect() {
    return this.rect;
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
const nextStudentButton = new MockElement({
  attributes: { "aria-label": "次の学生を選択" },
  rect: { width: 44, height: 44, top: 100 }
});
const wordHooks = runDetection({
  nodes: [new MockElement({ text: `Microsoft Word: ${duplicateWordName}${duplicateWordName}` }), nextStudentButton]
});
assert.equal(wordHooks.findOfficeFileName(), duplicateWordName);
assert.equal(wordHooks.findSupportedFileInfo().kind, "office");
assert.equal(wordHooks.isSubmissionView(), true);
assert.equal(wordHooks.describeDocument().submissionView, true);

const overviewHooks = runDetection({
  nodes: [new MockElement({ text: `添付済み ${duplicateWordName}` })]
});
assert.equal(overviewHooks.isSubmissionView(), false);
assert.equal(overviewHooks.describeDocument().submissionView, false);

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

// vm内で作られた配列は素の配列へ直してから比べる。
const plain = (value) => JSON.parse(JSON.stringify(value));

// 1人が複数ファイルを提出した場合、2件目以降も拾えること。
const firstFile = "26_0249 西山 期末レポート.docx";
const secondFile = "26_0249 西山 発表資料.pptx";
const multiHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft Word: ${firstFile}` }),
    new MockElement({ text: firstFile, href: "https://drive.google.com/file/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/view" }),
    new MockElement({ text: secondFile, href: "https://drive.google.com/file/d/1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/view" }),
    new MockElement({ text: "提出済みの記録.pdf", href: "https://drive.google.com/file/d/1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC/view" }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ],
  frames: [new MockElement({ src: "https://docs.google.com/file/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/view" })]
});
const attachments = multiHooks.findSubmissionAttachments();
assert.deepEqual(plain(attachments.map((item) => item.fileName)), [firstFile, secondFile]);
assert.equal(attachments[1].expectedFileId, "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
assert.equal(attachments[1].kind, "office");
// 表示中の1件は先頭のまま、重複させずに続きを並べる。
const files = multiHooks.listSubmissionFiles();
assert.deepEqual(plain(files.map((item) => item.fileName)), [firstFile, secondFile]);

// Classroomがリンクを出さず、role=menuitemだけでファイルを並べる場合も拾う。
const menuOnlyHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft Word: ${firstFile}`, attributes: { role: "menuitem" } }),
    new MockElement({ text: `Microsoft PowerPoint: ${secondFile}`, attributes: { role: "menuitem" } }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.deepEqual(plain(menuOnlyHooks.listSubmissionFiles().map((item) => item.fileName)), [firstFile, secondFile]);

// 添付リンクを1件も拾えなくても、従来どおり表示中の1件は準備できる。
const singleHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft Word: ${firstFile}` }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.deepEqual(plain(singleHooks.findSubmissionAttachments()), []);
assert.deepEqual(plain(singleHooks.listSubmissionFiles().map((item) => item.fileName)), [firstFile]);

const textHooks = runDetection({ nodes: [] });
assert.equal(textHooks.formatDuration(45000), "45秒");
assert.equal(textHooks.formatDuration(125000), "2分5秒");
assert.equal(textHooks.preparationCountText(0, 0, 1), "準備中…（1人目を処理中）");
assert.equal(textHooks.preparationCountText(3, 2, 6), "3件を準備しました・未準備 2件（6人目を処理中）");
assert.equal(textHooks.preparationCountText(4, 0, 0), "4件を準備しました");

console.log("Content detection handles Word duplicates, native Google documents, PDF submissions, multiple attachments, and progress wording.");
