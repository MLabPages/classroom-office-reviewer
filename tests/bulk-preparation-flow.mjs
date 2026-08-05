import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [content, background] = await Promise.all([
  readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/background.js", import.meta.url), "utf8")
]);

// テスト1：現在位置から一括準備
assert.match(content, /name="range" value="current" checked/);
assert.match(content, /startAtCurrent = preparationRange === "current"/);
assert.match(content, /startAtCurrent: message\.prefetch === true \|\| message\.startAtCurrent === true/);
assert.match(content, /if \(!startAtCurrent\) \{/);

// テスト2：変換済みをスキップ
assert.match(background, /const prepared = await getPreparedPdf\(key\) \|\| await getPreparedPdfById\(descriptor\.fileId\)/);
assert.match(background, /const prepared = await getPreparedPdf\(key\) \|\| await getPreparedPdfById\(fileId\)/);
assert.doesNotMatch(background, /const prepared = !cacheIdentity && \(await getPreparedPdf\(key\)/);
assert.doesNotMatch(background, /const prepared = !message\.cacheIdentity && \(await getPreparedPdf\(key\)/);

// テスト3：先読みの補充
assert.match(content, /limit: message\.prefetch \? 4 : 0/);
assert.match(content, /prefetchRequestedStudentKey/);
assert.match(background, /pendingPrefetchSourceTabId/);
assert.match(background, /startBulkPreparation\(pendingPrefetchSourceTabId, \{ prefetch: true \}\)/);

// テスト4：一括準備との排他
assert.match(content, /if \(state\.isPreparationTab \|\| state\.preparing \|\| state\.remotePreparing\) return;/);
assert.match(content, /if \(\["done", "cancelled"\]\.includes\(message\.status\)\)/);
assert.match(content, /if \(!fileChangedWithinStudent\) requestNextPrefetch\(\);/);
assert.match(background, /if \(prefetch && preparationState\.prefetch\)/);

console.log("4件の一括準備・キャッシュ・先読み・排他テストに合格しました。");
