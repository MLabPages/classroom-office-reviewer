from pathlib import Path

path = Path("tools/one_time_fix_stale_attachment_leak.py")
text = path.read_text(encoding="utf-8")

old_visible_filter = '      if (matchedVisibleItems.length) return matchedVisibleItems;'
new_visible_filter = '''      const selectedVisibleItem = matchedVisibleItems.some((node) => [
        node.getAttribute("aria-selected"),
        node.getAttribute("aria-current"),
        node.getAttribute("data-selected")
      ].some((value) => value === "true") || node.getAttribute("tabindex") === "0");
      if (matchedVisibleItems.length >= 2 || (matchedVisibleItems.length === 1 && selectedVisibleItem)) {
        return matchedVisibleItems;
      }'''
count = text.count(old_visible_filter)
if count != 1:
    raise SystemExit(f"visible filter refinement: expected 1 match, found {count}")
text = text.replace(old_visible_filter, new_visible_filter, 1)

old_link_filter = """new_links = '''    const linkNodes = [...document.querySelectorAll(\"a[href]\")].filter((node) => {
      if (insideReviewerUi(node)) return false;
      const isAnchor = typeof node.matches === \"function\" ? node.matches(\"a[href]\") : Boolean(node.href);
      // 過去の学生の非表示DriveリンクはDOMに残る。現在見えているカードのリンク
      // だけを直接列挙し、非表示リンクは対応するcurrent menuitem経由で解決する。
      return isAnchor && visible(node);
    });
'''"""
new_link_filter = """new_links = '''    const menuItems = findSubmissionFileMenuItems();
    const allowUnscopedHiddenDriveLinks = menuItems.length === 0;
    const linkNodes = [...document.querySelectorAll(\"a[href]\")].filter((node) => {
      if (insideReviewerUi(node)) return false;
      const isAnchor = typeof node.matches === \"function\" ? node.matches(\"a[href]\") : Boolean(node.href);
      // menuitemがある場合、非表示のDriveリンクは過去学生の履歴である可能性が高い。
      // menuitemが一切ないClassroom表示だけ、従来どおり非表示Driveリンクを採用する。
      return isAnchor && (visible(node) || (allowUnscopedHiddenDriveLinks && isDriveUrl(fileUrlOf(node))));
    });
'''"""
count = text.count(old_link_filter)
if count != 1:
    raise SystemExit(f"hidden link refinement: expected 1 match, found {count}")
text = text.replace(old_link_filter, new_link_filter, 1)

path.write_text(text, encoding="utf-8")
