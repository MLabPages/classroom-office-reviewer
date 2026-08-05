from pathlib import Path

path = Path("tools/one_time_fix_stale_attachment_leak.py")
text = path.read_text(encoding="utf-8")
old = '      if (matchedVisibleItems.length) return matchedVisibleItems;'
new = '''      const selectedVisibleItem = matchedVisibleItems.some((node) => [
        node.getAttribute("aria-selected"),
        node.getAttribute("aria-current"),
        node.getAttribute("data-selected")
      ].some((value) => value === "true") || node.getAttribute("tabindex") === "0");
      if (matchedVisibleItems.length >= 2 || (matchedVisibleItems.length === 1 && selectedVisibleItem)) {
        return matchedVisibleItems;
      }'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"generator refinement: expected 1 match, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
