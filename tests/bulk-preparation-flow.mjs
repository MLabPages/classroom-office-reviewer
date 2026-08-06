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
assert.match(content, /const beforePaneSignature = submissionFilePaneSignature\(\);/);
assert.match(content, /waitForSubmissionChange\(before, 20000, beforeFileId, beforeLabel, beforePaneSignature\)/);

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

// テスト9：未提出ステータスだけの画面でも切替完了にし、クリック後の遷移を再確認する。
assert.match(content, /"割り当て済み", "不足", "未提出"/);
assert.match(content, /\["割り当て済み", "不足", "Assigned", "Missing", "未提出"\]/);
assert.match(content, /submissionStatus === "未提出"/);
assert.match(content, /studentLabelStableForMs/);
assert.match(content, /filePaneChanged/);
assert.match(content, /filePaneStableForMs/);
assert.match(content, /submissionStatusForMs >= NO_ATTACHMENT_CONFIRM_MS/);
assert.match(content, /transition\.beforeLabel/);
assert.match(content, /transition\.beforePaneSignature/);
assert.match(content, /const beforeLabel = getStudentLabel\(\);/);
assert.match(content, /const transitionRetry = Boolean\(transition\);/);
assert.doesNotMatch(content, /if \(status === "stuck" && \(transition \|\| result\.transition\)\) return "stuck";/);
assert.match(content, /次の学生への画面切替を確認できませんでした/);

// テスト10：添付収集は現在学生の右側ファイル領域に限定し、過去学生・CRW UIを除外する。
assert.match(content, /function submissionFileRegion\(\)/);
assert.match(content, /function submissionFilePaneSignature\(\)/);
assert.match(content, /nodesWithin\(region, "a, button, div, span/);
assert.match(content, /const menuRoots = new Set\(menuItems\.map/);
assert.match(content, /現在表示中のファイルと結び付けられない複数メニュー/);
assert.doesNotMatch(content, /const linkNodes = \[\.\.\.document\.querySelectorAll\("a\[href\]"\)\]/);

// テスト11：一覧キーは課題・学生・ファイルで構成し、一括準備開始時に同じ課題の一覧を初期化する。
assert.match(content, /function assignmentKey\(\)/);
assert.match(content, /const assignment = String\(file\.assignmentKey \|\| assignmentKey\(\)\)/);
assert.match(content, /return `\$\{assignment\}\|\$\{student\}\|\$\{identity\}`/);
assert.match(content, /ensureSubmissionCatalogContext\(\);\s*state\.submissionCatalog = \[\];/s);

// テスト12：多数添付は一覧登録前に学生名・件数・候補名を表示して停止する。
assert.match(content, /MAX_PREPARATION_ATTACHMENTS = 10/);
assert.match(content, /files\.length > MAX_PREPARATION_ATTACHMENTS/);
assert.match(content, /一覧へ登録せず停止します。候補：/);
assert.match(content, /const unverifiedPdf = files\.find\(\(file\) => file\.kind === "pdf" && !file\.expectedFileId\)/);

// テスト13：PDFは正しいfileIdが確定した後、Office変換ではなく直接保存する。
assert.match(content, /type: preparedFile\.expectedFileId && !onScreen \? "cwr-prepare-attachment" : "cwr-prepare-one"/);
assert.match(background, /if \(isPdfDescriptor\(descriptor\)\) return storeExistingPdf/);
assert.match(background, /async function storeExistingPdf/);

// テスト14：長い巡回でも学生キーを重複登録しない安全な構造を維持する。
assert.match(content, /const seen = new Set\(\);/);
assert.match(content, /if \(seen\.has\(studentKey\)\) \{/);
assert.match(content, /seen\.add\(studentKey\);/);
assert.match(content, /studentKey,\s*fileSeq:/s);

// テスト15：右側ファイル欄を特定できない画面でも、一括準備が1人目で止まらない。
assert.match(content, /FILE_PANE_CONFIRM_GRACE_MS = \d+/);
assert.match(content, /const filePaneGraceExpired = studentChangedForMs >= FILE_PANE_CONFIRM_GRACE_MS;/);
assert.match(content, /if \(!filePaneConfirmed && !filePaneGraceExpired\) return false;/);
assert.doesNotMatch(content, /if \(!filePaneChanged \|\| filePaneStableForMs < NO_ATTACHMENT_CONFIRM_MS\) return false;/);
assert.match(content, /region \? nodesWithin\(region, "iframe\[src\]"\) : \[\.\.\.document\.querySelectorAll\("iframe\[src\]"\)\]/);

// テスト16：待ち直しでも猶予時間の起点を引き継ぎ、状態を読めない画面でも進める。
assert.match(content, /let studentChangedAt = transition\?\.studentChangedAt \|\| 0;/);
assert.match(content, /if \(transition\) transition\.studentChangedAt = studentChangedAt;/);
assert.match(content, /transition\.beforePaneSignature, transition\)/);
assert.match(content, /beforePaneSignature, pendingTransition\)/);
assert.match(content, /if \(filePaneGraceExpired && \(fileIdChanged \|\| studentLabelChanged\)\) return true;/);
assert.match(content, /const studentLabelChanged = Boolean\(currentLabel\) && Boolean\(previousLabel\) && currentLabel !== previousLabel;/);

// テスト17：準備タブが背面でも処理を続け、切替待ちを短くして1件あたりを速くする。
assert.match(content, /FILE_PANE_CONFIRM_GRACE_MS = 2500/);
assert.match(content, /await wait\(direction === "next" \? 300 : 180\);/);
assert.doesNotMatch(content, /await wait\(direction === "next" \? 650 : 180\);/);
assert.doesNotMatch(content, /paused: true/);

console.log("17件の一括準備・キャッシュ・先読み・排他・安全収集テストに合格しました。");
