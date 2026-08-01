import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

class MockElement {
  constructor({ text = "", attributes = {}, src = "", href = "", rect = { width: 600, height: 60, top: 60 }, hidden = false } = {}) {
    this.textContent = text;
    this.attributes = attributes;
    this.src = src;
    this.href = href;
    this.rect = rect;
    this.hidden = hidden;
    this.parentElement = null;
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  matches(selector) {
    if (selector === "a[href]") return Boolean(this.href);
    const roleMatch = selector.match(/^\[role=['"]?([\w-]+)['"]?\]$/);
    if (roleMatch) return this.getAttribute("role") === roleMatch[1];
    return false;
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

function runDetection({ nodes = [], frames = [], href, runtimeId = "test-extension-id", storageBroken = false } = {}) {
  const hooks = {};
  const location = {
    hostname: "classroom.google.com",
    href: href || "https://classroom.google.com/u/5/g/tg/course/work#u=student&t=f"
  };
  const window = {};
  window.top = window;
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "iframe[src]") return frames;
      if (selector === "a[href], iframe[src]") return frames;
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
assert.equal(mixedHooks.submissionCatalogKey({ studentKey: "u:student", expectedFileId: mixedDocumentId }), `u:student|${mixedDocumentId}`);

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

console.log("Content detection handles Word duplicates, native Google documents, PDF submissions, multiple attachments, and progress wording.");
