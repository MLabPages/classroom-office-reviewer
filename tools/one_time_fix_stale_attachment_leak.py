from pathlib import Path

CONTENT_PATH = Path("extension/content.js")
TEST_PATH = Path("tests/content-detection.mjs")
VALIDATE_PATH = Path("tests/validate-release.mjs")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


content = CONTENT_PATH.read_text(encoding="utf-8")
tests = TEST_PATH.read_text(encoding="utf-8")
validate = VALIDATE_PATH.read_text(encoding="utf-8")

# The previous run may already have persisted cross-student associations.
# Use a fresh derived-catalog namespace; prepared PDF caches use separate keys.
content = replace_once(
    content,
    '  const SUBMISSION_CATALOG_STORAGE_KEY = "classroomWordReviewerSubmissionCatalogV1";',
    '  const SUBMISSION_CATALOG_STORAGE_KEY = "classroomWordReviewerSubmissionCatalogV2";',
    "reset corrupted derived submission catalog",
)

# Do not let CRW's own progress/list UI become a Classroom attachment source.
content = replace_once(
    content,
    '''  function fileUrlOf(node) {
    return node?.href
      || node?.getAttribute("href")
      || node?.getAttribute("data-href")
      || node?.getAttribute("data-url")
      || node?.getAttribute("data-file-url")
      || node?.getAttribute("data-file-id")
      || "";
  }
''',
    '''  function fileUrlOf(node) {
    return node?.href
      || node?.getAttribute("href")
      || node?.getAttribute("data-href")
      || node?.getAttribute("data-url")
      || node?.getAttribute("data-file-url")
      || node?.getAttribute("data-file-id")
      || "";
  }

  function insideReviewerUi(node) {
    return Boolean(node?.closest?.("#cwr-controls, #cwr-preparation, #cwr-overlay"));
  }
''',
    "exclude reviewer UI from attachment discovery",
)

# Exclude our UI from menu-item discovery and correlate stale/reused menus with the
# currently visible Classroom attachment cards.
old_menu_function = '''  function findSubmissionFileMenuItems() {
    const items = [...document.querySelectorAll("[role='menuitem']")].filter((node) => {
      if (node.getAttribute?.("role") !== "menuitem") return false;
      const text = textOf(node);
      if (!text || /新しいウィンドウ|new window/i.test(text)) return false;
      const menu = node.closest?.("[role='menu']");
      const menuLabel = menu?.getAttribute("aria-label") || "";
      return !menu || /ファイル|file|submission/i.test(menuLabel) || Boolean(attachmentNameOf(node, googleTypeOfLabel(text)));
    });
    if (items.length < 2) return items;
    // 画面には別の提出者のメニューが残っていることがある。表示中のファイルが
    // 含まれるメニューが見つかったら、その1つだけを使う。
    const displayedId = findDisplayedFileId() || state.activeFile?.id || "";
    const displayedName = normalizedFileName(findOfficeFileName() || findPdfFileName() || state.activeFile?.name || "");
    if (!displayedId && !displayedName) return items;
    const groups = new Map();
    for (const node of items) {
      const menu = node.closest?.("[role='menu']") || null;
      if (!groups.has(menu)) groups.set(menu, []);
      groups.get(menu).push(node);
    }
    if (groups.size < 2) return items;
    if (displayedId) {
      for (const group of groups.values()) {
        if (group.some((node) => attachmentInfoOf(node)?.expectedFileId === displayedId)) return group;
      }
    }
    for (const group of groups.values()) {
      const matched = group.some((node) => {
        const attachment = attachmentInfoOf(node);
        return attachment && fileNamesLikelyMatch(normalizedFileName(attachment.fileName), displayedName);
      });
      if (matched) return group;
    }
    return items;
  }
'''
new_menu_function = '''  function visibleSubmissionAttachmentHints() {
    const hints = [];
    const selectors = "a[href], button, [role='button'], [aria-label], [title], [data-tooltip]";
    for (const node of document.querySelectorAll(selectors)) {
      if (insideReviewerUi(node) || !visible(node)) continue;
      if (node.getAttribute?.("role") === "menuitem") continue;
      const attachment = attachmentInfoOf(node);
      if (!attachment) continue;
      if (hints.some((item) => sameFile(item, attachment))) continue;
      hints.push(attachment);
    }
    return hints;
  }

  function findSubmissionFileMenuItems() {
    const items = [...document.querySelectorAll("[role='menuitem']")].filter((node) => {
      if (insideReviewerUi(node) || node.getAttribute?.("role") !== "menuitem") return false;
      const text = textOf(node);
      if (!text || /新しいウィンドウ|new window/i.test(text)) return false;
      const menu = node.closest?.("[role='menu']");
      const menuLabel = menu?.getAttribute("aria-label") || "";
      return !menu || /ファイル|file|submission/i.test(menuLabel) || Boolean(attachmentNameOf(node, googleTypeOfLabel(text)));
    });
    if (items.length < 2) return items;

    // Classroomは学生を高速に切り替えると、同じmenu要素の中へ過去の学生の
    // menuitemを残すことがある。role=menuによるグループ分けだけでは防げないため、
    // 現在右側に見えている添付カードと一致する項目だけを最優先で採用する。
    const visibleHints = visibleSubmissionAttachmentHints();
    if (visibleHints.length) {
      const matchedVisibleItems = items.filter((node) => {
        const attachment = attachmentInfoOf(node);
        return attachment && visibleHints.some((hint) => sameFile(hint, attachment));
      });
      if (matchedVisibleItems.length) return matchedVisibleItems;
    }

    // 画面には別の提出者のメニューが残っていることがある。表示中のファイルが
    // 含まれるメニューが見つかったら、その1つだけを使う。
    const displayedId = findDisplayedFileId() || state.activeFile?.id || "";
    const displayedName = normalizedFileName(findOfficeFileName() || findPdfFileName() || state.activeFile?.name || "");
    const groups = new Map();
    for (const node of items) {
      const menu = node.closest?.("[role='menu']") || null;
      if (!groups.has(menu)) groups.set(menu, []);
      groups.get(menu).push(node);
    }
    if (groups.size >= 2) {
      if (displayedId) {
        for (const group of groups.values()) {
          if (group.some((node) => attachmentInfoOf(node)?.expectedFileId === displayedId)) return group;
        }
      }
      if (displayedName) {
        for (const group of groups.values()) {
          const matched = group.some((node) => {
            const attachment = attachmentInfoOf(node);
            return attachment && fileNamesLikelyMatch(normalizedFileName(attachment.fileName), displayedName);
          });
          if (matched) return group;
        }
      }
      // 現在のグループを特定できないときは、全履歴を混ぜるより選択中の1件だけを
      // 返す。誤関連付けを防ぐことを、2件目以降の推測より優先する。
      const selected = items.filter((node) => [
        node.getAttribute("aria-selected"),
        node.getAttribute("aria-current"),
        node.getAttribute("data-selected")
      ].some((value) => value === "true") || node.getAttribute("tabindex") === "0");
      return selected.length ? selected : items.filter((node) => visible(node));
    }
    return items;
  }
'''
content = replace_once(content, old_menu_function, new_menu_function, "scope menu items to current student")

# Global hidden Drive links are the main source of cross-student leakage. Current
# hidden links are already resolved through their current menuitem's selection ID.
old_links = '''    const linkNodes = [...document.querySelectorAll("a[href]")].filter((node) =>
      typeof node.matches === "function" ? node.matches("a[href]") : Boolean(node.href));
'''
new_links = '''    const linkNodes = [...document.querySelectorAll("a[href]")].filter((node) => {
      if (insideReviewerUi(node)) return false;
      const isAnchor = typeof node.matches === "function" ? node.matches("a[href]") : Boolean(node.href);
      // 過去の学生の非表示DriveリンクはDOMに残る。現在見えているカードのリンク
      // だけを直接列挙し、非表示リンクは対応するcurrent menuitem経由で解決する。
      return isAnchor && visible(node);
    });
'''
content = replace_once(content, old_links, new_links, "ignore stale hidden Drive links")

old_visibility_comment = '''      // 選択欄の項目は閉じていると見えない。さらに新しいClassroomでは、
      // 提出ファイルへのDriveリンク自体が画面に出ない作りになったため、
      // 「見えないリンク」を捨てると添付が1件も見つからず、表示が
      // 前の提出者のまま固まる。リンクの見た目ではなく、Driveの
      // ファイルを指しているかどうかで判断する。
      if (!isMenuItem && !/(?:drive|docs)\.google\.com/i.test(url) && !visible(node)) continue;
'''
new_visibility_comment = '''      // menuitemは閉じていても現在の選択欄として利用する。リンクは上で
      // 現在見えているカードだけに限定済みで、過去学生の非表示リンクは入らない。
      if (!isMenuItem && !visible(node)) continue;
'''
content = replace_once(content, old_visibility_comment, new_visibility_comment, "update link visibility guard")

# Export the current-card helper for regression tests.
content = replace_once(
    content,
    '      findSubmittedLinks,\n      isLikelySubmittedLink,',
    '      findSubmittedLinks,\n      visibleSubmissionAttachmentHints,\n      isLikelySubmittedLink,',
    "export current attachment hints",
)

# Add regression tests for a reused single menu plus stale hidden Drive links.
anchor = '''// 添付リンクを1件も拾えなくても、従来どおり表示中の1件は準備できる。
'''
regression = '''// Classroomが同じrole=menu内に過去学生の項目を残しても、現在右側に
// 見えている添付カードと一致する2件だけを採用する。
const reusedMenu = new MockElement({ attributes: { role: "menu" } });
const leakedOldItem1 = new MockElement({
  text: "PDF: No.11人目 24_9033 篠原レポート.pdf",
  attributes: { role: "menuitem", tabindex: "-1" },
  rect: { width: 0, height: 0, top: 0 }
});
const leakedOldItem2 = new MockElement({
  text: "PDF: 5：期末レポート.pdf",
  attributes: { role: "menuitem", tabindex: "-1" },
  rect: { width: 0, height: 0, top: 0 }
});
const currentPdf1 = "621569829593678559_スポーツ分析.pdf";
const currentPdf2 = "marketing_6_0_analysis.pdf";
const currentReusedItem1 = new MockElement({
  text: `PDF: ${currentPdf1}`,
  attributes: { role: "menuitem", tabindex: "-1" },
  rect: { width: 0, height: 0, top: 0 }
});
const currentReusedItem2 = new MockElement({
  text: `PDF: ${currentPdf2}`,
  attributes: { role: "menuitem", tabindex: "0" },
  rect: { width: 0, height: 0, top: 0 }
});
for (const item of [leakedOldItem1, leakedOldItem2, currentReusedItem1, currentReusedItem2]) {
  item.parentElement = reusedMenu;
}
const currentVisibleCard1 = new MockElement({
  text: currentPdf1,
  href: "https://drive.google.com/file/d/1CURRENTVISIBLEPDF111111111111111/view"
});
const currentVisibleCard2 = new MockElement({
  text: currentPdf2,
  href: "https://drive.google.com/file/d/1CURRENTVISIBLEPDF222222222222222/view"
});
const staleHiddenDriveLink = new MockElement({
  text: "5：期末レポート.pdf",
  href: "https://drive.google.com/file/d/1STALEHIDDENDRIVELINK111111111111/view",
  rect: { width: 0, height: 0, top: 0 }
});
const reusedMenuHooks = runDetection({
  nodes: [
    leakedOldItem1,
    leakedOldItem2,
    currentReusedItem1,
    currentReusedItem2,
    currentVisibleCard1,
    currentVisibleCard2,
    staleHiddenDriveLink,
    new MockElement({ attributes: { "aria-label": "次の学生を選択" }, rect: { width: 44, height: 44, top: 100 } })
  ],
  frames: [new MockElement({ src: "https://docs.google.com/file/d/1CURRENTVISIBLEPDF222222222222222/grading" })]
});
assert.deepEqual(
  plain(reusedMenuHooks.listSubmissionFiles().map((item) => item.fileName)),
  [currentPdf1, currentPdf2]
);
assert.deepEqual(
  plain(reusedMenuHooks.visibleSubmissionAttachmentHints().map((item) => item.fileName)),
  [currentPdf1, currentPdf2]
);

'''
tests = replace_once(tests, anchor, regression + anchor, "add stale attachment leak regression")

# Release validation: derived catalog namespace and contamination guards must remain.
validate_anchor = '''assert(content.includes("function currentDisplayedFileInfo"));
'''
validate_replacement = '''assert(content.includes("function currentDisplayedFileInfo"));
assert(content.includes('SUBMISSION_CATALOG_STORAGE_KEY = "classroomWordReviewerSubmissionCatalogV2"'));
assert(content.includes("function insideReviewerUi"));
assert(content.includes("function visibleSubmissionAttachmentHints"));
assert(content.includes("return isAnchor && visible(node);"));
'''
validate = replace_once(validate, validate_anchor, validate_replacement, "validate attachment scoping")

CONTENT_PATH.write_text(content, encoding="utf-8")
TEST_PATH.write_text(tests, encoding="utf-8")
VALIDATE_PATH.write_text(validate, encoding="utf-8")
