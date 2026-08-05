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

// テスト5：学生切替と巡回キーは、提出画面の表示状態に依存しないナビゲーションキーを使う。
assert.match(content, /const before = navigationStudentKey\(\);/);
assert.match(content, /const studentKey = navigationStudentKey\(\);/);

// テスト6：未提出者は長時間の提出物待機を行わず、添付なしとして一覧に残す。
assert.match(content, /const missingStudent = zipStatusOf\(getStudentLabel\(\)\) === "未提出";/);
assert.match(content, /missingStudent\s*\?\s*null\s*:\s*await waitForSubmissionFileWithRecovery/);
assert.match(content, /kind: "no-attachment"/);

// テスト7：次へボタンの一時的な消失を末尾扱いにしない。
assert.doesNotMatch(content, /status === "missing" && findSubmissionButton\(/);
assert.match(content, /if \(submissionButtonDisabled\(button\)\) return \{ status: "end" \};/);

// テスト8：キー欠落・重複・切替停止は正常完了にせず、現在位置からの再開を案内する。
assert.match(content, /if \(!studentKey\) \{\s*stopReason = "student-key-missing";/s);
assert.match(content, /if \(seen\.has\(studentKey\)\) \{\s*stopReason = "duplicate-student";/s);
assert.match(content, /if \(!state\.prepareCancelled && !\["end", "limit"\]\.includes\(stopReason\)\)/);
assert.match(content, /人目まで確認しました。現在位置から再開してください/);
assert.match(content, /if \(moved !== "moved"\) \{\s*stopReason = moved;/s);

// テスト9：未提出ステータスは、次の学生のファイル待機を省略する判断に使う。
assert.match(content, /"割り当て済み", "不足", "未提出"/);
assert.match(content, /\["割り当て済み", "不足", "Assigned", "Missing", "未提出"\]/);
assert.match(content, /const missingStudent = zipStatusOf\(getStudentLabel\(\)\) === "未提出";/);

// テスト10：学生移動はURLの学生IDだけで判定し、ファイル表示とは分離する。
assert.match(content, /function studentNavigationChanged\(/);
assert.match(content, /async function waitForStudentNavigation\(/);
assert.match(content, /waitForStudentNavigation\(before, 10000\)/);
const moveSubmissionSection = content.match(/async function moveSubmission\([\s\S]*?\n  \}\n\n  \/\/ 背面であることは停止理由ではない/)?.[0] || "";
assert.doesNotMatch(moveSubmissionSection, /waitForSubmissionChange/);
assert.match(content, /transition\.retried = true/);

// テスト11：次の学生で前のPDFが残っている間は受理せず、PDF自体は変換しない。
assert.match(content, /function submissionFileStillPrevious\(/);
assert.match(content, /waitForSubmissionFileWithRecovery\(15000, previousDisplayedFileId, studentKey\)/);
assert.match(content, /const departingFileId = findDisplayedFileId\(\)/);
assert.match(content, /if \(file\.kind === "pdf"\)/);
assert.match(content, /status: "pdf-direct"/);
assert.match(content, /PDFのため変換せず一覧に登録しました/);

// テスト12：準備タブを背面にしても待機Promiseで停止しない。
assert.match(content, /準備タブは背面ですが、処理を続けています/);
assert.match(content, /function waitForPreparationVisibility\(\)[\s\S]*return Promise\.resolve\(true\);/);

console.log("12件の一括準備・学生移動・PDF直登録テストに合格しました。");
