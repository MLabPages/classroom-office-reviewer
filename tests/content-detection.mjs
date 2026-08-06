import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

class MockElement {
  constructor({ text = "", attributes = {}, src = "", href = "", rect = { width: 600, height: 60, top: 60 }, hidden = false, children = [] } = {}) {
    this.textContent = text;
    this.attributes = attributes;
    this.src = src;
    this.href = href;
    this.rect = rect;
    this.hidden = hidden;
    this.parentElement = null;
    this.children = children;
    for (const child of children) {
      if (!child.parentElement) child.parentElement = this;
    }
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (value === "a[href]") return Boolean(this.href);
      if (value === "iframe[src]") return Boolean(this.src);
      if (/^(?:a|iframe|button|div|span|p)$/.test(value)) return value === (this.src ? "iframe" : this.href ? "a" : "div");
      if (value === "#cwr-overlay") return this.getAttribute("id") === "cwr-overlay";
      const attributeMatch = value.match(/^\[([\w-]+)(?:([*^$|~]?=)['"]?([^\]'"]+)['"]?)?\]$/);
      if (attributeMatch) {
        const actual = this.getAttribute(attributeMatch[1]);
        if (actual === null) return false;
        if (!attributeMatch[2]) return true;
        const expected = attributeMatch[3];
        if (attributeMatch[2] === "*=") return actual.includes(expected);
        if (attributeMatch[2] === "=") return actual === expected;
        if (attributeMatch[2] === "^=") return actual.startsWith(expected);
        return false;
      }
      return false;
    });
  }

  querySelectorAll(selector) {
    const descendants = [];
    for (const child of this.children || []) {
      descendants.push(child, ...child.querySelectorAll(selector));
    }
    return descendants.filter((node) => node.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
}

function runDetection({ nodes = [], frames = [], href, runtimeId = "test-extension-id", storageBroken = false, visibilityState = "visible", hidden = false, hasFocus = true } = {}) {
  const hooks = {};
  const location = {
    hostname: "classroom.google.com",
    href: href || "https://classroom.google.com/u/5/g/tg/course/work#u=student&t=f"
  };
  const fileRegion = new MockElement({
    attributes: { "data-testid": "submission-files", role: "region" },
    children: [...nodes, ...frames]
  });
  const body = new MockElement({ children: [fileRegion] });
  fileRegion.parentElement = body;
  const window = {};
  window.top = window;
  const document = {
    visibilityState,
    hidden,
    body,
    hasFocus: () => hasFocus,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "iframe[src]") return frames;
      if (selector === "a[href], iframe[src]") return frames;
      if (selector.includes("data-testid") || selector.includes("role='region'") || selector.includes("aria-label*='提出'")) return [fileRegion];
      return nodes;
    }
  };
  // 拡張機能を更新した直後の古いタブでは、chrome.storage の呼び出しが
  // Promiseではなく同期的な例外になる。その状態を再現する。
  const storage = storageBroken
    ? {
      local: {
        get() { throw new Error("Extension context invalidated."); },
        set() { throw new Error("Extension context invalidated."); }
      }
    }
    : {
      local: {
        get: async () => ({}),
        set: async () => undefined
      }
    };
  const context = vm.createContext({
    __CWR_TEST_HOOKS__: hooks,
    chrome: { runtime: runtimeId ? { id: runtimeId } : {}, storage },
    Element: MockElement,
    // ClassroomはURLで提出者を base64 で表す。ブラウザと同じ変換を用意する。
    atob,
    document,
    getComputedStyle: (element) => (element?.hidden
      ? { display: "none", visibility: "hidden" }
      : { display: "block", visibility: "visible" }),
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

// Googleドキュメントの提出は、Classroomが埋め込み枠ではなく編集画面をそのまま
// 開くことがある。この画面には提出物領域と呼べる区画が無く、以前は提出物を
// 見つけられずに一括準備がその学生で止まっていた。枠だけは画面全体から探す。
const googleEditorFrame = new MockElement({
  src: `https://docs.google.com/document/d/${googleFileId}/edit`
});
const googleEditorHooks = (() => {
  const hooks = {};
  const body = new MockElement({ children: [googleEditorFrame] });
  googleEditorFrame.parentElement = body;
  const window = {};
  window.top = window;
  const document = {
    visibilityState: "visible",
    hidden: false,
    body,
    hasFocus: () => true,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "iframe[src]") return [googleEditorFrame];
      return [];
    }
  };
  const context = vm.createContext({
    __CWR_TEST_HOOKS__: hooks,
    chrome: { runtime: { id: "test-extension-id" }, storage: { local: { get: async () => ({}), set: async () => undefined } } },
    Element: MockElement,
    atob,
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    globalThis: null,
    location: {
      hostname: "classroom.google.com",
      href: "https://classroom.google.com/u/5/g/tg/course/work#u=student&t=f"
    },
    window
  });
  context.globalThis = context;
  vm.runInContext(content, context);
  return hooks;
})();
assert.equal(googleEditorHooks.submissionFileRegion(), null, "編集画面には提出物領域が無い状態を再現する");
assert.equal(
  googleEditorHooks.findGoogleFileInfo()?.expectedFileId,
  googleFileId,
  "提出物領域を特定できない編集画面でも、Googleドキュメントの提出物を見つける"
);
assert.equal(googleEditorHooks.findGoogleFileInfo()?.kind, "google-document");

// 編集画面でも右側には「ファイル」見出しの欄が出る。属性の手掛かりが無くても、
// この見出しから提出物領域を見つけられることを確認する。
const fileHeadingPanel = (() => {
  const heading = new MockElement({ text: "ファイル" });
  const attachmentLink = new MockElement({ href: `https://drive.google.com/file/d/${googleFileId}/view` });
  const panel = new MockElement({ children: [heading, attachmentLink] });
  heading.parentElement = panel;
  attachmentLink.parentElement = panel;
  return { panel, heading };
})();
const fileHeadingHooks = (() => {
  const hooks = {};
  const { panel: filePanel, heading } = fileHeadingPanel;
  heading.parentElement = filePanel;
  const body = new MockElement({ children: [filePanel] });
  filePanel.parentElement = body;
  const window = {};
  window.top = window;
  const document = {
    visibilityState: "visible",
    hidden: false,
    body,
    hasFocus: () => true,
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "iframe[src]") return [];
      if (selector === "div, span, h1, h2, h3") return [heading];
      return [];
    }
  };
  const context = vm.createContext({
    __CWR_TEST_HOOKS__: hooks,
    chrome: { runtime: { id: "test-extension-id" }, storage: { local: { get: async () => ({}), set: async () => undefined } } },
    Element: MockElement,
    atob,
    document,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    globalThis: null,
    location: {
      hostname: "classroom.google.com",
      href: "https://classroom.google.com/u/5/g/tg/course/work#u=student&t=f"
    },
    window
  });
  context.globalThis = context;
  vm.runInContext(content, context);
  return hooks;
})();
assert.equal(
  fileHeadingHooks.submissionFileRegion(),
  fileHeadingPanel.panel,
  "「ファイル」見出しを持つ欄を提出物領域として見つける"
);

const hiddenPreparationHooks = runDetection({ visibilityState: "hidden", hidden: true, hasFocus: false });
assert.deepEqual(JSON.parse(JSON.stringify(hiddenPreparationHooks.preparationDocumentState())), {
  visibilityState: "hidden",
  hidden: true,
  hasFocus: false
});
assert.equal(hiddenPreparationHooks.preparationDocumentVisible(), false);
// 別ウィンドウを前面にしただけの hasFocus() false は、タブの背景化とは
// 異なるため、Classroomタブ自体がvisibleなら待機させない。
const visibleUnfocusedPreparationHooks = runDetection({ visibilityState: "visible", hidden: false, hasFocus: false });
assert.equal(visibleUnfocusedPreparationHooks.preparationDocumentVisible(), true);

// Googleドキュメントのラベルは、アイコン用の見えない文字が前に付くことや、
// 名前が2回続けて出ることがある（Officeのdocxdocxと同様の重複表示）。
// 拡張子がなく境界を作れないため、前半だけを取り出せているか確認する。
const doubledGoogleTitle = "近大ゼミ2026_期末レポート";
const iconPrefixedDoubledHooks = runDetection({
  nodes: [new MockElement({
    attributes: { "aria-label": `￼Google ドキュメント: ${doubledGoogleTitle}${doubledGoogleTitle}` }
  })],
  frames: [new MockElement({ src: `https://docs.google.com/document/d/${googleFileId}/grading?authuser=5` })]
});
assert.equal(iconPrefixedDoubledHooks.findSupportedFileInfo().fileName, doubledGoogleTitle);
assert.equal(iconPrefixedDoubledHooks.findSupportedFileInfo().expectedFileId, googleFileId);

const loadingGoogleHooks = runDetection({
  nodes: [new MockElement({ attributes: { "aria-label": `Google ドキュメント: ${googleTitle}` } })]
});
assert.equal(loadingGoogleHooks.findSupportedFileInfo().expectedGoogleType, "document");
assert.equal(loadingGoogleHooks.findSupportedFileInfo().expectedFileId, "");
assert.equal(loadingGoogleHooks.describeDocument().googleType, "");
assert.deepEqual(JSON.parse(JSON.stringify(loadingGoogleHooks.inspectSubmissionFile())), { waiting: true });

// PDFの提出物はOffice変換が不要なので、そのままsupportedとして扱う。
const pdfHooks = runDetection({
  nodes: [new MockElement({ attributes: { "aria-label": "PDF: submitted-report.pdf" } })]
});
assert.equal(pdfHooks.findSupportedFileInfo().kind, "pdf");
assert.equal(pdfHooks.findSupportedFileInfo().fileName, "submitted-report.pdf");
assert.equal(pdfHooks.findAnyAttachmentFileName(), "submitted-report.pdf");
assert.deepEqual(JSON.parse(JSON.stringify(pdfHooks.inspectSubmissionFile())).kind, "pdf");

// WordとPDFを同じ提出物に添付し、PDFのmenuitemを選択中にしても、
// メニュー先頭のWordへ誤って切り替えない。実際のClassroomでは選択中の
// menuitemが tabindex="0" になり、表示中iframeのIDを現在ファイルへ結び付ける。
const selectedPdfId = "1PDFPDFPDFPDFPDFPDFPDFPDFPDFPDF";
const selectedPdfWithWordHooks = runDetection({
  nodes: [
    new MockElement({
      text: "Microsoft Word: report.docx",
      attributes: { role: "menuitem", tabindex: "-1" }
    }),
    new MockElement({
      text: "PDF: submitted-report.pdf",
      attributes: { role: "menuitem", tabindex: "0" }
    })
  ],
  frames: [new MockElement({ src: `https://docs.google.com/file/d/${selectedPdfId}/grading` })]
});
assert.equal(selectedPdfWithWordHooks.findSupportedFileInfo().kind, "pdf");
assert.equal(selectedPdfWithWordHooks.findSupportedFileInfo().fileName, "submitted-report.pdf");
assert.equal(selectedPdfWithWordHooks.findSupportedFileInfo().expectedFileId, selectedPdfId);
assert.equal(selectedPdfWithWordHooks.describeDocument().fileName, "submitted-report.pdf");

// Wordを選択中の場合は、同じ添付欄にPDFがあってもWordの処理を維持する。
const selectedWordId = "1WORDWORDWORDWORDWORDWORDWORDWORDWORD";
const selectedWordWithPdfHooks = runDetection({
  nodes: [
    new MockElement({
      text: "Microsoft Word: report.docx",
      attributes: { role: "menuitem", tabindex: "0" }
    }),
    new MockElement({
      text: "PDF: submitted-report.pdf",
      attributes: { role: "menuitem", tabindex: "-1" }
    })
  ],
  frames: [new MockElement({ src: `https://docs.google.com/file/d/${selectedWordId}/grading` })]
});
assert.equal(selectedWordWithPdfHooks.findSupportedFileInfo().kind, "office");
assert.equal(selectedWordWithPdfHooks.findSupportedFileInfo().fileName, "report.docx");

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
const pdfRecordFile = "提出済みの記録.pdf";
// PDFはOffice変換が不要なので、そのまま添付一覧・カウント対象に含める。
assert.deepEqual(plain(attachments.map((item) => item.fileName)), [firstFile, secondFile, pdfRecordFile]);
assert.equal(attachments[1].expectedFileId, "1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
assert.equal(attachments[1].kind, "office");
assert.equal(attachments[2].kind, "pdf");
assert.equal(attachments[2].expectedFileId, "1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
// 表示中の1件は先頭のまま、重複させずに続きを並べる。
const files = multiHooks.listSubmissionFiles();
assert.deepEqual(plain(files.map((item) => item.fileName)), [firstFile, secondFile, pdfRecordFile]);

// 既存の添付データにGoogleドキュメント／スライドや未知の形式が混ざっても、
// 判定できた項目を一覧用データとして保持し、1件の未知形式で止まらない。
const mixedDocumentId = "1DOCGGGGGGGGGGGGGGGGGGGGGGGGGGGG";
const mixedSlidesId = "1SLIDEGGGGGGGGGGGGGGGGGGGGGGGGG";
const mixedHooks = runDetection({
  nodes: [
    new MockElement({ text: "Google ドキュメント: 研究レポート" }),
    new MockElement({ text: "研究レポート", href: `https://docs.google.com/document/d/${mixedDocumentId}/edit` }),
    new MockElement({ text: "発表スライド", href: `https://docs.google.com/presentation/d/${mixedSlidesId}/edit` }),
    new MockElement({ text: "集計表.xlsx", href: "https://drive.google.com/file/d/1XLSXGGGGGGGGGGGGGGGGGGGGGGGGGG/view" }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ],
  frames: [new MockElement({ src: `https://docs.google.com/document/d/${mixedDocumentId}/grading` })]
});
const mixedAttachments = mixedHooks.findSubmissionAttachments();
assert.deepEqual(plain(mixedAttachments.map((item) => item.kind)), ["google-document", "google-presentation", "unknown"]);
assert.deepEqual(plain(mixedHooks.listSubmissionFiles().map((item) => item.fileName)), ["研究レポート", "発表スライド", "集計表.xlsx"]);
assert.equal(mixedAttachments[0].sourceUrl, `https://docs.google.com/document/d/${mixedDocumentId}/edit`);
assert.equal(mixedAttachments[1].sourceUrl, `https://docs.google.com/presentation/d/${mixedSlidesId}/edit`);
assert.equal(mixedHooks.fileTypeLabel({ kind: "office", fileName: "report.docx" }), "Word");
assert.equal(mixedHooks.fileTypeLabel({ kind: "google-presentation", fileName: "slides" }), "Googleスライド");
assert.equal(mixedHooks.fileTypeLabel({ kind: "unknown", fileName: "集計表.xlsx" }), "XLSX");
assert.equal(mixedHooks.submissionCatalogKey({ studentKey: "u:student", expectedFileId: mixedDocumentId }), `https://classroom.google.com/u/*/g/tg/course/work|u:student|${mixedDocumentId}`);
const longRunKeys = Array.from({ length: 200 }, (_, index) => mixedHooks.submissionCatalogKey({
  studentKey: `u:student-${index}`,
  expectedFileId: `1FILE${String(index).padStart(34, "0")}`
}));
assert.equal(new Set(longRunKeys).size, 200, "200人巡回でも学生ごとの一覧キーが重複しない");

// Classroomがリンクを出さず、role=menuitemだけでファイルを並べる場合も拾う。
const menuOnlyHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft Word: ${firstFile}`, attributes: { role: "menuitem" } }),
    new MockElement({ text: `Microsoft PowerPoint: ${secondFile}`, attributes: { role: "menuitem" } }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.deepEqual(plain(menuOnlyHooks.listSubmissionFiles().map((item) => item.fileName)), [firstFile, secondFile]);

// 現行Classroomは、選択用の menuitem と同じ data-selection-id を持つ
// 別要素にだけDrive URLを置く。ここからファイルIDを結び付けられないと、
// 左右ボタンで同名の複数提出を選んでも対象を確認できない。
const currentClassroomSameFile = "26_0250 胡井 期末レポート.docx";
const currentClassroomMenu = new MockElement({ attributes: { role: "menu" } });
const currentClassroomFirstItem = new MockElement({
  text: `Microsoft Word: ${currentClassroomSameFile}`,
  attributes: { role: "menuitem", "data-cursor-id": "i:m:first" }
});
const currentClassroomSecondItem = new MockElement({
  text: `Microsoft Word: ${currentClassroomSameFile}`,
  attributes: { role: "menuitem", "data-cursor-id": "i:m:second" }
});
const currentClassroomFirstUrl = new MockElement({
  attributes: {
    "data-selection-id": "m:first",
    "data-url": "https://drive.google.com/file/d/1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD/view"
  }
});
// 2件目は実画面と同じく、選択項目の内側にDriveリンクを持つ。
const currentClassroomSecondLink = new MockElement({
  href: "https://drive.google.com/file/d/1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE/view"
});
currentClassroomSecondItem.querySelector = (selector) => selector.includes("a[href]")
  ? currentClassroomSecondLink
  : null;
currentClassroomSecondLink.parentElement = currentClassroomSecondItem;
for (const item of [
  currentClassroomFirstItem,
  currentClassroomSecondItem,
  currentClassroomFirstUrl
]) item.parentElement = currentClassroomMenu;
const currentClassroomMenuHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft Word: ${currentClassroomSameFile}` }),
    currentClassroomFirstItem,
    currentClassroomSecondItem,
    currentClassroomFirstUrl,
    currentClassroomSecondLink,
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ],
  frames: [new MockElement({ src: "https://docs.google.com/file/d/1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD/grading" })]
});
assert.deepEqual(
  plain(currentClassroomMenuHooks.findSubmissionAttachments().map((item) => item.expectedFileId)),
  ["1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"]
);
assert.equal(
  currentClassroomMenuHooks.findSubmissionFileMenuItem({
    fileName: currentClassroomSameFile,
    expectedFileId: "1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"
  }),
  currentClassroomSecondItem
);

// 選択欄が閉じていて項目が隠れていても、2件目を見落とさない。
const hiddenMenuHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft Word: ${firstFile}` }),
    new MockElement({
      text: `Microsoft Word: ${firstFile}`,
      attributes: { role: "menuitem" },
      rect: { width: 0, height: 0, top: 0 }
    }),
    new MockElement({
      text: `Microsoft PowerPoint: ${secondFile}`,
      attributes: { role: "menuitem" },
      rect: { width: 0, height: 0, top: 0 }
    }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.deepEqual(
  plain(hiddenMenuHooks.listSubmissionFiles().map((item) => item.fileName)),
  [firstFile, secondFile]
);

// 2件目を表示中でも、Classroomの選択欄と同じ並び順を保つ。
const secondActiveHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft PowerPoint: ${secondFile}` }),
    new MockElement({ text: `Microsoft Word: ${firstFile}`, attributes: { role: "menuitem" } }),
    new MockElement({ text: `Microsoft PowerPoint: ${secondFile}`, attributes: { role: "menuitem" } }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.deepEqual(
  plain(secondActiveHooks.listSubmissionFiles().map((item) => item.fileName)),
  [firstFile, secondFile]
);

// 前の提出者の選択欄がDOMに残っていて、かつ選択欄の表示名が途中で切られていても、
// 表示中の提出者のメニューだけを拾い、前の提出者のファイルを混ぜない。
// （これを混ぜると件数が増え、複数ファイルの最後まで見ても「次の学生」へ進めなくなる）
const staleMenu = new MockElement({ attributes: { role: "menu" } });
const staleItem1 = new MockElement({
  text: "Microsoft Word: 25_9999 田中 期末レポート.docx",
  attributes: { role: "menuitem" }
});
staleItem1.parentElement = staleMenu;
const staleItem2 = new MockElement({
  text: "Microsoft PowerPoint: 25_9999 田中 発表資料.pptx",
  attributes: { role: "menuitem" }
});
staleItem2.parentElement = staleMenu;

const currentMenu = new MockElement({ attributes: { role: "menu" } });
// 選択欄では学籍番号の接頭辞が切られて表示される想定。
const truncatedFirstFile = "西山 期末レポート.docx";
const currentItem1 = new MockElement({ text: `Microsoft Word: ${truncatedFirstFile}`, attributes: { role: "menuitem" } });
currentItem1.parentElement = currentMenu;
const currentItem2 = new MockElement({ text: `Microsoft PowerPoint: ${secondFile}`, attributes: { role: "menuitem" } });
currentItem2.parentElement = currentMenu;

const staleGroupHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft Word: ${firstFile}` }),
    staleItem1,
    staleItem2,
    currentItem1,
    currentItem2,
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.deepEqual(
  plain(staleGroupHooks.listSubmissionFiles().map((item) => item.fileName)),
  [firstFile, secondFile]
);

// 添付リンクを1件も拾えなくても、従来どおり表示中の1件は準備できる。
const singleHooks = runDetection({
  nodes: [
    new MockElement({ text: `Microsoft Word: ${firstFile}` }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.deepEqual(plain(singleHooks.findSubmissionAttachments()), []);
assert.deepEqual(plain(singleHooks.listSubmissionFiles().map((item) => item.fileName)), [firstFile]);

// CRW自身のビューアー／一覧に残るリンクは、提出物として数えない。
const cwrOwnedLink = new MockElement({
  text: "過去学生の表示.pdf",
  href: "https://drive.google.com/file/d/1CWRVIEWER000000000000000000000000/view"
});
const cwrOverlay = new MockElement({ attributes: { id: "cwr-overlay" }, children: [cwrOwnedLink] });
const cwrOwnedHooks = runDetection({ nodes: [cwrOverlay] });
assert.deepEqual(plain(cwrOwnedHooks.findSubmissionAttachments()), []);

// 提出者の見分けは、描画待ちで揺れる画面上の名前ではなくURLの #u= を使う。
// これがずれると、変換したPDFが「別の提出者のもの」と誤判定されて捨てられる。
const realGradingUrl = "https://classroom.google.com/u/5/g/tg/ODQ3OTQ5MDU1MDA1/ODY4NDQ5MDU0MzMz#u=Nzk3MDYyNjExODcy&t=f";
assert.equal(runDetection({ href: realGradingUrl }).getStudentIdFromUrl(), "Nzk3MDYyNjExODcy");
// 提出者がURLに出ていない画面では、空を返して従来の判定に任せる。
assert.equal(
  runDetection({ href: "https://classroom.google.com/u/5/g/tg/course/work" }).getStudentIdFromUrl(),
  ""
);

// 同名の複数提出でも、表示中フレームのファイルIDが変われば別の提出物として扱う。
const sameNameFile = "26_0273 清水 期末レポート.docx";
const sameNameFrames = [new MockElement({
  src: "https://docs.google.com/file/d/1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF/grading"
})];
const sameNameKeyHooks = runDetection({
  href: realGradingUrl,
  nodes: [
    new MockElement({ text: `Microsoft Word: ${sameNameFile}` }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ],
  frames: sameNameFrames
});
assert.equal(
  sameNameKeyHooks.getSubmissionKey(),
  "u:Nzk3MDYyNjExODcy|1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
);
sameNameFrames[0].src = "https://docs.google.com/file/d/1GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG/grading";
assert.equal(
  sameNameKeyHooks.getSubmissionKey(),
  "u:Nzk3MDYyNjExODcy|1GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG"
);
// Classroomで2件目を直接選んだとき、前回のactiveFileを残していても
// iframeの現在ファイル番号を優先する。ここが逆だと2件目で1件目のPDFを使う。
sameNameKeyHooks.setActiveFile({ expectedFileId: "1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", fileName: sameNameFile });
assert.equal(
  sameNameKeyHooks.currentDisplayedFileInfo().expectedFileId,
  "1GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG"
);
assert.equal(
  sameNameKeyHooks.getSubmissionKey(),
  "u:Nzk3MDYyNjExODcy|1GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG"
);

// Google形式の名前は拡張子が無く、重複表示を境界で切り分けられない。
// ちょうど半分の繰り返しのときだけ前半を採用し、それ以外は触らない。
const labelHooks = runDetection({});
assert.equal(labelHooks.dedupeDoubledLabel("期末レポート期末レポート"), "期末レポート");
assert.equal(labelHooks.dedupeDoubledLabel("期末レポート"), "期末レポート");
// 偶然おなじ長さで前後が違う名前を、誤って半分に切らない。
assert.equal(labelHooks.dedupeDoubledLabel("前期レポート後期レポート"), "前期レポート後期レポート");

// 実際のClassroom画面で確認した構造の回帰確認。
// 表示中の提出者は aria-checked="true" の項目に入っているが、同じ条件に
// 一致する「名」だけの見えない要素も同居している。見えない要素を拾うと
// 一覧が「□□名」になり、提出者名が分からなくなる。
const hiddenNameFragment = new MockElement({
  text: "名",
  attributes: { "aria-checked": "true", "data-value": "858586088821" },
  hidden: true
});
const shownStudentEntry = new MockElement({
  text: "26_0259 森本（Morimoto）提出済み",
  attributes: { "aria-checked": "true", "data-value": "858671205828" }
});
const studentLabelHooks = runDetection({ nodes: [hiddenNameFragment, shownStudentEntry] });
assert.equal(studentLabelHooks.getStudentLabel(), "26_0259 森本（Morimoto）提出済み");
assert.equal(
  studentLabelHooks.studentDisplayName(studentLabelHooks.getStudentLabel()),
  "26_0259 森本（Morimoto）"
);

// 新しいClassroomでは、提出ファイルのDriveリンクが画面に出ない状態で
// 描画されることがある。見えないという理由だけで捨てると添付が0件になり、
// 提出者を切り替えてもビューアが前のPDFのまま固まる。
const hiddenDriveLink = new MockElement({
  text: "26_0259 森本（Morimoto） - マーケティング＿期末レポート.docx",
  href: "https://drive.google.com/file/d/1TM9BwPn-wzKdt76NQXLpJW3Hjskz1Sdk/view?usp=drive_web",
  hidden: true
});
const hiddenLinkHooks = runDetection({ nodes: [hiddenDriveLink] });
assert.equal(hiddenLinkHooks.findSubmissionAttachments().length, 1);
assert.equal(
  hiddenLinkHooks.findSubmissionAttachments()[0].expectedFileId,
  "1TM9BwPn-wzKdt76NQXLpJW3Hjskz1Sdk"
);

// 拡張機能を更新すると、開いたままのタブに残ったスクリプトは本体から
// 切り離され、chrome.runtime.id が消える。ボタンは画面に残るのに操作が
// 届かなくなるため、この状態を確実に見分けられる必要がある。
assert.equal(runDetection({}).extensionContextLost(), false);
assert.equal(runDetection({ runtimeId: "" }).extensionContextLost(), true);

// 変換済みPDFが届いたとき、捨てる判断は「提出者が変わったか」だけで行う。
// Classroomはファイル名を二重に連結して描くことがあり、要求時と受信時で
// 名前が食い違う。名前まで突き合わせると正しいPDFまで破棄され、
// 左右の切り替えを押しても画面が真っ黒のまま止まってしまう。
const keyHooks = runDetection({
  href: "https://classroom.google.com/u/5/g/tg/course/work#u=ODU4NjY4MDY5MDE0&t=f",
  nodes: [new MockElement({
    attributes: { "aria-label": "次の生徒を選択: 26_0265 山田さん" },
    rect: { width: 44, height: 44, top: 100 }
  })]
});
// 同じ提出者なら、ファイル名部分が違っても受け入れる。
assert.equal(keyHooks.sameSubmissionStudent("u:ODU4NjY4MDY5MDE0|レポート.docx"), true);
assert.equal(keyHooks.sameSubmissionStudent("u:ODU4NjY4MDY5MDE0|レポート.docxレポート.docx"), true);
assert.equal(keyHooks.sameSubmissionStudent("u:ODU4NjY4MDY5MDE0|"), true);
// 別の提出者のPDFは、これまでどおり確実に捨てる。
assert.equal(keyHooks.sameSubmissionStudent("u:OTHERSTUDENT9999|レポート.docx"), false);

const textHooks = runDetection({ nodes: [] });

// 拡張機能を更新した直後の古いタブでは chrome.storage が切り離される。
// 設定の保存・読み出しは補助的な処理なので、ここで例外を投げて
// コンソールに赤いエラーを残さず、操作は続けられる状態を保つ。
const brokenStorageHooks = runDetection({ storageBroken: true });
assert.doesNotThrow(() => brokenStorageHooks.saveSetting({ cwrAuto: true }));
await assert.rejects(brokenStorageHooks.loadSettings(["cwrAuto"]));
// 正常なタブでは、これまでどおり設定を読み書きできる。
const workingStorageHooks = runDetection({ nodes: [] });
assert.doesNotThrow(() => workingStorageHooks.saveSetting({ cwrAuto: true }));
assert.deepEqual(await workingStorageHooks.loadSettings(["cwrAuto"]), {});


// 学生を切り替えた直後は、Classroomがまだ前の提出物を表示している。
// 前のファイル番号のまま変換結果が届いたら受け取らない。これを許すと
// ビューアが一瞬点滅して、同じファイルが再表示されたように見える。
const staleDeliveryHooks = runDetection({
  href: "https://classroom.google.com/u/5/g/tg/course/work#u=ODU4NjY4MDY5MDE0&t=f",
  nodes: [new MockElement({
    attributes: { "aria-label": "次の生徒を選択: 26_0265 山田さん" },
    rect: { width: 44, height: 44, top: 100 }
  })],
  frames: [new MockElement({
    src: "https://docs.google.com/file/d/1NEWNEWNEWNEWNEWNEWNEWNEWNEWNEW/grading"
  })]
});
// 表示要求前は判断材料がないので、これまでどおり受け入れる。
assert.equal(staleDeliveryHooks.matchesRequestedFile({ submissionKey: "u:ODU4NjY4MDY5MDE0|1OLDOLDOLDOLDOLDOLDOLDOLDOLDOLD" }), true);
staleDeliveryHooks.setActiveFile({ expectedFileId: "1NEWNEWNEWNEWNEWNEWNEWNEWNEWNEW", fileName: "新しい提出.docx" });
// 今開いているファイルの結果だけを表示する。
assert.equal(staleDeliveryHooks.matchesRequestedFile({ submissionKey: "u:ODU4NjY4MDY5MDE0|1NEWNEWNEWNEWNEWNEWNEWNEWNEWNEW" }), true);
assert.equal(staleDeliveryHooks.matchesRequestedFile({ submissionKey: "u:ODU4NjY4MDY5MDE0|1OLDOLDOLDOLDOLDOLDOLDOLDOLDOLD" }), false);
// ファイル番号を読めない画面では、従来どおり受け入れて表示を止めない。
assert.equal(staleDeliveryHooks.matchesRequestedFile({ submissionKey: "u:ODU4NjY4MDY5MDE0|" }), true);

// 提出物が最初からPDFの場合も、Wordファイルと同様にPDFで表示・別窓表示の
// 有効/無効判定に使うため kind: "pdf" を返す。
const solePdfHooks = runDetection({
  nodes: [
    new MockElement({ text: "26_0300 山口 レポート.pdf" }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.equal(solePdfHooks.findSupportedFileInfo().kind, "pdf");
assert.equal(solePdfHooks.inspectSubmissionFile().kind, "pdf");

assert.equal(textHooks.formatDuration(45000), "45秒");
assert.equal(textHooks.formatDuration(125000), "2分5秒");
assert.equal(textHooks.preparationCountText(0, 0, 1), "準備中…（1人目を処理中）");
assert.equal(textHooks.preparationCountText(3, 2, 6), "3件を準備しました・未準備 2件（6人目を処理中）");
assert.equal(textHooks.preparationCountText(4, 0, 0), "4件を準備しました");

// 添付が1件も無い提出者では、Classroomが「添付ファイルはありません」を
// 確定表示する。これを読み取れないと、出てこないファイルを待ち続けて
// 一括準備がその提出者で止まってしまう。
const noAttachmentHooks = runDetection({
  nodes: [
    new MockElement({ text: "添付ファイルはありません" }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
assert.equal(noAttachmentHooks.findNoAttachmentMessage(), true);
assert.deepEqual(plain(noAttachmentHooks.inspectSubmissionFile()), { noAttachment: true });
// 断定を避けた表現を使う。「未提出」とは言い切らない。
assert.equal(noAttachmentHooks.fileTypeLabel({ kind: "no-attachment" }), "添付ファイルなし");

// 未提出画面では添付欄や前後ボタンが描画途中で消えることがある。ZIP巡回は
// その場合でもURLの学生IDで処理済み登録を続け、添付なしを終了扱いにしない。
const noAttachmentWithoutNavigationHooks = runDetection({
  href: "https://classroom.google.com/u/5/g/tg/course/work#u=ODU4NjY4MDY5MDE0&t=f",
  nodes: [new MockElement({ text: "添付ファイルはありません" })]
});
assert.equal(noAttachmentWithoutNavigationHooks.getStudentKey(), "");
assert.equal(noAttachmentWithoutNavigationHooks.zipStudentKey(), "u:ODU4NjY4MDY5MDE0");
assert.equal(noAttachmentWithoutNavigationHooks.navigationStudentKey(), "u:ODU4NjY4MDY5MDE0");
assert.equal(noAttachmentWithoutNavigationHooks.submissionStateKind({ noAttachment: true }), "no-attachment");
assert.equal(noAttachmentWithoutNavigationHooks.submissionStateKind({ kind: "office" }), "attachment");
assert.equal(noAttachmentWithoutNavigationHooks.submissionStateKind({ waiting: true }), "");

// 学生の識別情報の変化を先に確認する。ファイルIDが無いことだけでは切替成功にしない。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: false,
    fileState: { noAttachment: true },
    previousFileId: "previous-drive-file",
    noAttachmentForMs: 2000
  }),
  false,
  "学生が変わっていない添付なし表示は切替完了にしない"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { kind: "pdf" },
    previousFileId: "previous-drive-file",
    displayedFileId: "new-drive-file",
    studentLabelStableForMs: 2000,
    filePaneChanged: false,
    filePaneStableForMs: 2000
  }),
  false,
  "URLや新しいiframeだけでは、右側ファイル欄が更新されるまで収集しない"
);
// 提出済み -> 未提出：前の学生だけがファイルIDを持つ場合。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { noAttachment: true },
    previousFileId: "previous-drive-file",
    noAttachmentForMs: 1500,
    submissionStatus: "未提出",
    submissionStatusForMs: 1500,
    studentLabelStableForMs: 1500,
    filePaneChanged: true,
    filePaneStableForMs: 1500
  }),
  true,
  "提出済み学生から未提出者へ移るときは、新しいファイルIDが無くても切替完了にする"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { noAttachment: true },
    previousFileId: "previous-drive-file",
    noAttachmentForMs: 1499,
    submissionStatus: "未提出",
    submissionStatusForMs: 1499,
    studentLabelStableForMs: 1500,
    filePaneChanged: true,
    filePaneStableForMs: 1500
  }),
  false,
  "添付なし表示は短時間の描画途中では確定しない"
);
// 未提出 -> 提出済み：学生IDの変化後、新しいファイルIDが補助情報として得られる。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { kind: "office" },
    previousFileId: "",
    displayedFileId: "new-drive-file",
    studentLabelStableForMs: 1500,
    filePaneChanged: true,
    filePaneStableForMs: 1500
  }),
  true
);
// 未提出 -> 未提出：どちらにもファイルIDが無くても、学生IDの変化と状態確定で進む。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { noAttachment: true },
    noAttachmentForMs: 1500,
    submissionStatus: "未提出",
    submissionStatusForMs: 1500,
    studentLabelStableForMs: 1500,
    filePaneChanged: true,
    filePaneStableForMs: 1500
  }),
  true
);
// 提出済み -> 添付なし提出：提出状態は巡回側で「提出済み」のまま保持し、
// 切替判定だけを添付なし状態で完了できる。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { noAttachment: true },
    previousFileId: "previous-drive-file",
    noAttachmentForMs: 1500,
    studentLabelStableForMs: 1500,
    filePaneChanged: true,
    filePaneStableForMs: 1500
  }),
  true
);
// Classroomが未提出を「不足」と表示する場合も、未提出として扱う。
assert.equal(noAttachmentWithoutNavigationHooks.zipStatusOf("26_0301 佐藤 不足"), "未提出");
// 添付欄が無くても、新しい学生の表示名と未提出状態が安定すれば切替完了にする。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    submissionStatus: "未提出",
    studentLabelStableForMs: 1500,
    submissionStatusForMs: 1500,
    filePaneChanged: true,
    filePaneStableForMs: 1500
  }),
  true
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    submissionStatus: "未提出",
    studentLabelStableForMs: 2000,
    submissionStatusForMs: 2000,
    filePaneChanged: false,
    filePaneStableForMs: 2000
  }),
  false,
  "前の未提出者の表示が残っている間は切替完了にしない"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    submissionStatus: "未提出",
    studentLabelStableForMs: 1499,
    submissionStatusForMs: 1499,
    filePaneChanged: true,
    filePaneStableForMs: 1499
  }),
  false,
  "未提出状態も一定時間安定するまで確定しない"
);
// 右側ファイル欄そのものを特定できないClassroom画面では、署名がいつまでも
// 変わらない。この場合に待ち続けると、一括準備が1人目の直後で必ず止まる。
// 一定時間を過ぎたら、学生名・提出状態・表示中のファイル番号だけで進める。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { kind: "office" },
    previousFileId: "previous-drive-file",
    displayedFileId: "new-drive-file",
    studentChangedForMs: 6000,
    studentLabelStableForMs: 1500,
    filePaneChanged: false,
    filePaneStableForMs: 0
  }),
  true,
  "ファイル欄の署名を取得できない画面でも、別の手掛かりが揃えば切替完了にする"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { kind: "office" },
    previousFileId: "previous-drive-file",
    displayedFileId: "previous-drive-file",
    studentChangedForMs: 6000,
    studentLabelStableForMs: 1500,
    filePaneChanged: false,
    filePaneStableForMs: 0
  }),
  false,
  "猶予時間を過ぎても、前の学生のファイルが表示されたままなら切替完了にしない"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: { kind: "office" },
    previousFileId: "previous-drive-file",
    displayedFileId: "new-drive-file",
    studentChangedForMs: 2000,
    studentLabelStableForMs: 1500,
    filePaneChanged: false,
    filePaneStableForMs: 0
  }),
  false,
  "切替直後は従来どおり右側ファイル欄の更新を待つ"
);
// ファイル欄を特定できない画面では提出物の状態自体を読み取れず、fileStateが
// nullになる。この場合も猶予後は表示中ファイルの入れ替わりで切替完了にする。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    previousFileId: "previous-drive-file",
    displayedFileId: "new-drive-file",
    studentChangedForMs: 6000,
    studentLabelStableForMs: 1500,
    filePaneChanged: false,
    filePaneStableForMs: 0
  }),
  true,
  "提出物の状態を読み取れない画面でも、表示中ファイルが入れ替われば切替完了にする"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    previousFileId: "previous-drive-file",
    displayedFileId: "previous-drive-file",
    studentChangedForMs: 6000,
    studentLabelStableForMs: 1500,
    filePaneChanged: false,
    filePaneStableForMs: 0
  }),
  false,
  "前の学生のファイルが表示されたままなら、状態を読めなくても切替完了にしない"
);
// PDF提出はClassroom自身のビューアで開き、Drive/Docsのプレビュー枠が置かれない
// ことがある。この場合ファイル番号は前後とも空になるため、番号の入れ替わりでは
// 判定できない。猶予後は、画面上の提出者名が別人へ変わったことを根拠にする。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    previousFileId: "",
    displayedFileId: "",
    studentChangedForMs: 6000,
    studentLabelStableForMs: 1500,
    studentLabelChanged: true,
    filePaneChanged: false,
    filePaneStableForMs: 0
  }),
  true,
  "PDF提出でファイル番号が取れなくても、提出者名が変わっていれば切替完了にする"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    previousFileId: "",
    displayedFileId: "",
    studentChangedForMs: 6000,
    studentLabelStableForMs: 1500,
    studentLabelChanged: false,
    filePaneChanged: false,
    filePaneStableForMs: 0
  }),
  false,
  "提出者名もファイル番号も変わらないなら、猶予後でも切替完了にしない"
);

assert.deepEqual(plain(noAttachmentWithoutNavigationHooks.zipCollectionCompletion({
  rosterTotal: 18, collectedCount: 18, stopReason: "end"
})), { complete: true, message: "" });
assert.equal(
  noAttachmentWithoutNavigationHooks.zipCollectionCompletion({ rosterTotal: 18, collectedCount: 7, stopReason: "end" }).complete,
  false,
  "総人数未達は、次へボタンが末尾でも正常終了にしない"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.zipCollectionCompletion({ rosterTotal: 18, collectedCount: 7, stopReason: "stuck" }).complete,
  false,
  "学生切替待機のタイムアウトを正常終了にしない"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.zipCollectionCompletion({ rosterTotal: 18, collectedCount: 7, stopReason: "missing" }).complete,
  false,
  "次へボタンの取得失敗を正常終了にしない"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.zipCollectionCompletion({ rosterTotal: 18, collectedCount: 7, stopReason: "duplicate-student" }).complete,
  false,
  "処理済み学生の重複を正常終了にしない"
);

// 通常の提出物が表示されている画面では、添付なしと誤判定しない。
assert.equal(solePdfHooks.findNoAttachmentMessage(), false);

// Word/PowerPointを共有リンクで提出する学生がいる。Drive上に実体が無いため
// 取得できず、そのままでは前の学生の表示が残ってしまう。リンクとして拾う。
const oneDriveUrl = "https://1drv.ms/w/s!AbCdEfGhIjKlMnOp";
const sharedLinkHooks = runDetection({
  nodes: [
    new MockElement({ text: "製品戦略論2026＿中間レポート.docx", href: oneDriveUrl }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
const sharedLinks = sharedLinkHooks.findSubmittedLinks();
assert.equal(sharedLinks.length, 1);
assert.equal(sharedLinks[0].kind, "link");
assert.equal(sharedLinks[0].sourceUrl, oneDriveUrl);
assert.equal(sharedLinks[0].fileName, "製品戦略論2026＿中間レポート.docx");
// 共有リンクだけの提出でも、待ち続けずに確定させる。
assert.equal(sharedLinkHooks.inspectSubmissionFile().linkOnly, true);
assert.equal(sharedLinkHooks.fileTypeLabel({ kind: "link" }), "共有リンク");

// Classroom自身の案内リンクや、Drive上の本物の添付は共有リンク扱いしない。
assert.equal(
  sharedLinkHooks.isLikelySubmittedLink(
    new MockElement({ text: "ヘルプ", href: "https://support.google.com/edu/classroom" }),
    "https://support.google.com/edu/classroom"
  ),
  false
);
assert.equal(
  sharedLinkHooks.isLikelySubmittedLink(
    new MockElement({ text: "レポート.docx", href: "https://drive.google.com/file/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/view" }),
    "https://drive.google.com/file/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/view"
  ),
  false
);

// 共有リンクはファイル番号を持たない。URLで見分けないと、同じ提出者の
// 複数リンクが1件にまとまってしまう。
assert.notEqual(
  sharedLinkHooks.submissionCatalogKey({ studentKey: "u:student", kind: "link", sourceUrl: oneDriveUrl, fileName: "レポート.docx" }),
  sharedLinkHooks.submissionCatalogKey({ studentKey: "u:student", kind: "link", sourceUrl: "https://1drv.ms/w/s!ZZZZ", fileName: "レポート.docx" })
);

// 共有リンクの提出は、表示対象としてもリンクとして返す。ここでWordファイルと
// 判定してしまうと、取得に失敗して前の学生のPDFが残ったままになる。
assert.equal(sharedLinkHooks.currentDisplayedFileInfo().kind, "link");
assert.equal(sharedLinkHooks.currentDisplayedFileInfo().sourceUrl, oneDriveUrl);

// Drive上に実体があるふつうの提出は、これまでどおりファイルとして扱う。
const driveFileId = "1REALREALREALREALREALREALREAL";
const normalWordHooks = runDetection({
  nodes: [
    new MockElement({ text: "Microsoft Word: 26_0100 田中 レポート.docx" }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ],
  frames: [new MockElement({ src: `https://drive.google.com/file/d/${driveFileId}/view` })]
});
assert.equal(normalWordHooks.currentDisplayedFileInfo().kind, "office");
assert.equal(normalWordHooks.inspectSubmissionFile().kind, "office");

// ---------------------------------------------------------------
// ZIP一括ダウンロード：提出者一覧と提出状態の読み取り
// ---------------------------------------------------------------
// Classroomの提出者切替欄は、閉じている間も全員分の項目をDOMに持っている。
// ここから「未提出の学生」まで含めた一覧を作れないと、未提出者の表示を
// 待ち続けて一括処理が止まってしまう。
const rosterHooks = runDetection({
  nodes: [
    new MockElement({ text: "26_0243 安田（Yasuda）提出済み", attributes: { "aria-checked": "true", "data-value": "858685482900" } }),
    new MockElement({ text: "26_0244 吾郷（Ago）未提出", attributes: { "aria-checked": "false", "data-value": "858670518078" } }),
    new MockElement({ text: "26_0247 前田（Maeda）割り当て済み", attributes: { "aria-checked": "false", "data-value": "858669315782" } }),
    new MockElement({ text: "26_0248 山中（Yamanaka）下書き", attributes: { "aria-checked": "false", "data-value": "858670812792" } }),
    // 並べ替えなどの項目は data-value を持っていても提出者ではない。
    new MockElement({ text: "ステータスで並べ替え", attributes: { "aria-checked": "true", "data-value": "sort:1" } }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
const roster = plain(rosterHooks.readClassroomRoster());
assert.deepEqual(roster, [
  { studentId: "858685482900", studentName: "26_0243 安田（Yasuda）", status: "提出済み" },
  { studentId: "858670518078", studentName: "26_0244 吾郷（Ago）", status: "未提出" },
  // 「割り当て済み」はClassroomの言い方の違いで、実質は未提出。
  { studentId: "858669315782", studentName: "26_0247 前田（Maeda）", status: "未提出" },
  { studentId: "858670812792", studentName: "26_0248 山中（Yamanaka）", status: "下書き" }
]);
assert.equal(rosterHooks.zipStatusOf("26_0243 安田（Yasuda）提出済み"), "提出済み");
assert.equal(rosterHooks.zipStudentName("26_0243 安田（Yasuda）提出済み"), "26_0243 安田（Yasuda）");
// ClassroomはURLでは base64、一覧では10進で同じ提出者を表す。
assert.equal(rosterHooks.zipDecodeStudentId("ODU4Njg1NDgyOTAw"), "858685482900");
assert.equal(rosterHooks.zipDecodeStudentId("not-base64!"), "");

// 添付カードの名前は aria-label から読み取る（実画面の形に合わせる）。
const attachmentNode = new MockElement({
  attributes: { "aria-label": "添付ファイル: Microsoft Word: マーケティング.docx" }
});
assert.equal(rosterHooks.zipAttachmentLabel(attachmentNode), "マーケティング.docx");
const sheetNode = new MockElement({
  attributes: { "aria-label": "添付ファイル: Google スプレッドシート: 集計表" }
});
assert.equal(rosterHooks.zipAttachmentLabel(sheetNode), "集計表");

// 採点表示では扱わないGoogleスプレッドシートなども、ZIP用には拾う。
const sheetId = "1SHEETSHEETSHEETSHEETSHEETSHEET";
const extraHooks = runDetection({
  nodes: [
    new MockElement({
      href: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
      attributes: { "aria-label": "添付ファイル: Google スプレッドシート: 集計表" }
    }),
    new MockElement({
      href: "https://docs.google.com/forms/d/e/1FAIpQLSfFORMfFORMfFORMfFORMfFORMfFORM/viewform",
      attributes: { "aria-label": "添付ファイル: Google フォーム: アンケート" }
    }),
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ]
});
const extras = extraHooks.collectExtraGoogleAttachments();
assert.equal(extras.length, 2);
assert.deepEqual(plain(extras[0]), {
  kind: "google-spreadsheet",
  googleType: "spreadsheet",
  fileId: sheetId,
  fileName: "集計表",
  sourceUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
});
// フォームは取り込めないので、開くためのリンクとして残す。
assert.equal(extras[1].kind, "link");
assert.equal(extras[1].fileName, "アンケート");

// 名簿CSVの照合：省略番号と氏名の完全一致が1件だけの場合に限る。
const rosterCsv = [
  "学籍番号,氏名",
  "2610170001,学生A",
  "2610170002,学生B",
  "2600000001,学生C"
].join("\n");
assert.equal(rosterHooks.zipAbbreviatedNumber("2610170001"), "26_0001");
assert.equal(rosterHooks.zipRosterNameKey(" 学生Ａ （Student A） "), "学生a");
assert.equal(rosterHooks.parseRosterCsv(rosterCsv).length, 3);
const rosterMatched = rosterHooks.applyRosterStudentNumbers([
  { studentKey: "u:1", studentName: "26_0001 学生A（Student A）" },
  { studentKey: "u:2", studentName: "26_0002 学生B" },
  { studentKey: "u:3", studentName: "26_0001 学生D" }
], rosterCsv);
assert.equal(rosterMatched[0].studentNumber, "2610170001");
assert.equal(rosterMatched[1].studentNumber, "2610170002");
assert.equal(rosterMatched[2].studentNumber, undefined, "姓だけや部分一致で正式な学籍番号を推測しない");
assert.match(rosterMatched[2].rosterWarning, /複数/);

// A列だけでも、省略番号が一意なら正式な学籍番号を使う。CSVの並び順は関係ない。
const numberOnlyRoster = ["学籍番号", "2610170397", "2610170395", "2610170396"].join("\n");
const numberOnlyMatched = rosterHooks.applyRosterStudentNumbers([
  { studentKey: "u:4", studentName: "26_0395 学生A" },
  { studentKey: "u:5", studentName: "26_0396 学生B" }
], numberOnlyRoster);
assert.equal(numberOnlyMatched[0].studentNumber, "2610170395");
assert.equal(numberOnlyMatched[1].studentNumber, "2610170396");
const duplicateNumberOnly = rosterHooks.applyRosterStudentNumbers(
  [{ studentKey: "u:6", studentName: "26_0001 学生A" }],
  ["学籍番号", "2610170001", "2600000001"].join("\n")
);
assert.equal(duplicateNumberOnly[0].studentNumber, undefined);
assert.match(duplicateNumberOnly[0].rosterWarning, /複数/);

// ZIP設定画面は識別名とファイル名構成を分け、次回復元用の保存キーを使う。
assert.match(content, /<legend>学生の識別名<\/legend>/);
assert.match(content, /表示名をそのまま使う/);
assert.match(content, /<legend>ファイル名の構成<\/legend>/);
assert.match(content, /cwrZipFileNameStyle/);
assert.match(content, /名簿CSV（学籍番号。氏名列は任意）/);
assert.match(content, /氏名列は任意です。入力内容は保存しません。/);

console.log("Content detection handles Word duplicates, native Google documents, PDF submissions, multiple attachments, progress wording, and bulk ZIP collection.");
