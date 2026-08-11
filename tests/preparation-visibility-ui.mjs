import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [content, css] = await Promise.all([
  readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/content.css", import.meta.url), "utf8")
]);
const [viewer, viewerHtml] = await Promise.all([
  readFile(new URL("../extension/viewer.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/viewer.html", import.meta.url), "utf8")
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

// 操作パネルの長い項目名がはみ出さないこと。
assert(css.includes("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);"));
assert(css.includes("overflow-wrap: anywhere;"));
assert(!css.includes("#cwr-google-native-label {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  white-space: nowrap;"));

// 全画面でも倍率変更・ページ送りを使えること。
assert(viewerHtml.includes("html:fullscreen.controls-visible header"));
assert(viewer.includes("function revealFullscreenControls"));
assert(viewer.includes("function stepPage(delta)"));
assert(viewer.includes('if (event.clientY <= 72) revealFullscreenControls();'));

// PDFへ変換しないGoogle形式も、ビューア内へ大きく埋め込むこと。
assert(viewer.includes('notice.kind === "google-native" && notice.embedUrl'));
assert(viewerHtml.includes("#google-frame"));
assert(viewer.includes('id = "google-frame-link"'));

// ビューアが開いていないときは、案内表示のためにビューアを新しく開くこと。
// ここが無いと「PDFで表示」を押しても画面が変わらない。
assert(content.includes("function openViewerForNotice(notice)"));
assert(content.includes("openViewerForNotice(notice);"));
assert(!content.includes("if (!iframe || !document.body.contains(state.overlay)) return false;"));

// ビューアを開いたまま学生を切り替えたら、自動表示の設定に関係なく追従すること。
assert(content.includes("const viewerOpen = Boolean(state.overlay) && document.body.contains(state.overlay);"));
assert(content.includes("const shouldFollow = state.auto || fileChangedWithinStudent || viewerOpen;"));
// 閉じたビューアーを、切替中に届いた自動変換結果で開き直さない。
assert(content.includes("viewerClosedByUser: false"));
assert(content.includes("if (isAutomatic && state.viewerClosedByUser && !state.overlay) return false;"));
assert(content.includes("if (state.viewerClosedByUser && !state.overlay) {"));
assert(content.includes("state.viewerClosedByUser = true;"));
// GoogleスライドでClassroomの切替が遅れても、同じ学生切替を安全に再確認する。
assert(content.includes("const moved = await moveWithRecovery(direction);"));
assert(content.includes("if (moved !== \"moved\") {"));

console.log("Bulk preparation keeps running in hidden tabs and the compact drag control has an explicit label.");
