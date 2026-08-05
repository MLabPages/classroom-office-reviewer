import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [content, css] = await Promise.all([
  readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/content.css", import.meta.url), "utf8")
]);

const backgroundPauseMessage = "Classroomタブがバックグラウンドのため一時停止しています。Classroomタブを表示すると自動的に再開します。";
assert(content.includes(`const PREPARATION_BACKGROUND_PAUSE_MESSAGE = "${backgroundPauseMessage}"`));
assert(content.includes('document.addEventListener("visibilitychange", handlePreparationVisibilityEvent)'));
assert(content.includes('window.addEventListener("focus", handlePreparationVisibilityEvent)'));
assert(content.includes('window.addEventListener("pageshow", handlePreparationVisibilityEvent)'));
assert(content.includes('if (!state.preparing && !state.remotePreparing)'));
assert(content.includes('if (status === "stuck" && (transition || result.transition)) return "stuck";'));
assert(!content.includes('retries > BACKGROUND_RETRY_BEFORE_STALLED && retries % 3 === 0'));
assert(content.includes('title="パネルをドラッグして移動" aria-label="パネルをドラッグして移動">ドラッグで移動</button>'));
assert(!content.includes('id="cwr-preparation-drag" type="button" title="ドラッグして位置を変える"'));
assert(css.includes("#cwr-preparation-drag"));
assert(css.includes("cursor: grab"));
assert(css.includes("cwr-preparation-paused"));

console.log("Bulk preparation pauses safely in hidden tabs and the compact drag control has an explicit label.");
