import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [content, css] = await Promise.all([
  readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/content.css", import.meta.url), "utf8")
]);

// 準備タブが背面でも処理を止めない。採点タブと準備タブを行き来せずに済ませる。
const backgroundMessage = "準備タブは背面ですが、そのまま処理を続けています。採点タブで作業を続けて構いません。";
assert(content.includes(`const PREPARATION_BACKGROUND_MESSAGE = "${backgroundMessage}"`));
assert(!content.includes("PREPARATION_BACKGROUND_PAUSE_MESSAGE"));
// 背面待ちで処理を止める入り口を残さない。中止と切り離しのときだけ false を返す。
assert(content.includes("if (state.prepareCancelled || state.contextInvalidated) return Promise.resolve(false);"));
assert(!content.includes("state.preparationVisibilityWaiters.push(resolve)"));
assert(content.includes('document.addEventListener("visibilitychange", handlePreparationVisibilityEvent)'));
assert(content.includes('window.addEventListener("focus", handlePreparationVisibilityEvent)'));
assert(content.includes('window.addEventListener("pageshow", handlePreparationVisibilityEvent)'));
assert(!content.includes('retries > BACKGROUND_RETRY_BEFORE_STALLED && retries % 3 === 0'));
assert(content.includes('title="パネルをドラッグして移動" aria-label="パネルをドラッグして移動"><svg'));
assert(content.includes('<button id="cwr-preparation-compact" type="button" aria-pressed="false">小さく表示</button>'));
assert(content.includes('compactButton.textContent = state.preparationCompact ? "展開" : "最小化";'));
assert(!content.includes('id="cwr-preparation-drag" type="button" title="ドラッグして位置を変える"'));
assert(css.includes("#cwr-preparation-drag"));
assert(css.includes("cursor: grab"));
assert(css.includes("width: max-content;"));
assert(css.includes("justify-self: end;"));

console.log("Bulk preparation keeps running in hidden tabs and the compact drag control has an explicit label.");
