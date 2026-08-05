from pathlib import Path
import re

CONTENT_PATH = Path("extension/content.js")
FLOW_TEST_PATH = Path("tests/bulk-preparation-flow.mjs")
DETECTION_TEST_PATH = Path("tests/content-detection.mjs")
VALIDATE_PATH = Path("tests/validate-release.mjs")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return updated


content = CONTENT_PATH.read_text(encoding="utf-8")
flow_tests = FLOW_TEST_PATH.read_text(encoding="utf-8")
detection_tests = DETECTION_TEST_PATH.read_text(encoding="utf-8")
validate = VALIDATE_PATH.read_text(encoding="utf-8")

# ---------------------------------------------------------------------------
# 1. Keep the preparation tab running while it is in the background.
# ---------------------------------------------------------------------------
content = replace_once(
    content,
    '  const PREPARATION_BACKGROUND_PAUSE_MESSAGE = "Classroomタブがバックグラウンドのため一時停止しています。Classroomタブを表示すると自動的に再開します。";',
    '  const PREPARATION_BACKGROUND_PAUSE_MESSAGE = "準備タブは背面ですが、処理を続けています。Classroomの画面更新を確認中です。";',
    "background preparation message",
)

visibility_block = '''  function pausePreparationForBackground() {
    if (!state.isPreparationTab || isPreparationFinished() || preparationDocumentVisible()) return;
    setPreparationProgress({
      paused: false,
      delayed: true,
      stalled: false,
      detailText: PREPARATION_BACKGROUND_PAUSE_MESSAGE
    });
  }

  // 背面タブでも処理を止めない。待ち時間はservice worker側でも計測しているため、
  // Chromeのタイマー抑制を避けながらClassroomのDOM更新を確認し続けられる。
  function waitForPreparationVisibility() {
    if (state.prepareCancelled || state.contextInvalidated) return Promise.resolve(false);
    if (state.isPreparationTab && !isPreparationFinished() && !preparationDocumentVisible()) {
      if (!progress.delayed || progress.paused) pausePreparationForBackground();
    }
    return Promise.resolve(true);
  }

  function resumePreparationAfterForeground() {
    if (!state.isPreparationTab || isPreparationFinished() || !preparationDocumentVisible()) return;
    if (progress.paused || progress.delayed) {
      setPreparationProgress({
        paused: false,
        delayed: false,
        stalled: false,
        detailText: "Classroomの画面を再確認しています。"
      });
    }
    resolvePreparationVisibilityWaiters(true);
  }

  function handlePreparationVisibilityEvent() {
    if (!state.isPreparationTab || isPreparationFinished()) return;
    if (preparationDocumentVisible()) resumePreparationAfterForeground();
    else pausePreparationForBackground();
  }
'''
content = replace_regex_once(
    content,
    r'^  function pausePreparationForBackground\(\) \{.*?^  function handlePreparationVisibilityEvent\(\) \{.*?^  \}\n',
    visibility_block,
    "keep preparation running in background",
)

# ---------------------------------------------------------------------------
# 2. Do not accept the previous student's still-visible file as the new one.
# ---------------------------------------------------------------------------
new_file_wait = '''  function displayedSubmissionFileId(fileState = null) {
    return findDisplayedFileId() || fileState?.expectedFileId || fileState?.id || "";
  }

  function submissionFileStillPrevious(previousFileId = "", fileState = null) {
    const currentFileId = displayedSubmissionFileId(fileState);
    return Boolean(previousFileId && currentFileId && currentFileId === previousFileId);
  }

  async function waitForSubmissionFile(timeoutMs = 20000, previousFileId = "", expectedStudentKey = "") {
    const startedAt = Date.now();
    let pausedMilliseconds = 0;
    let noAttachmentSince = 0;
    while (Date.now() - startedAt - pausedMilliseconds < timeoutMs) {
      const pauseStartedAt = Date.now();
      if (!await waitForPreparationVisibility()) return null;
      pausedMilliseconds += Date.now() - pauseStartedAt;
      if (Date.now() - startedAt - pausedMilliseconds >= timeoutMs) return null;
      if (expectedStudentKey && navigationStudentKey() !== expectedStudentKey) {
        await wait(150);
        continue;
      }
      const fileState = inspectSubmissionFile();
      const stalePreviousFile = fileState
        && !fileState.waiting
        && !fileState.noAttachment
        && submissionFileStillPrevious(previousFileId, fileState);
      if (fileState && !fileState.waiting && !stalePreviousFile) {
        // 提出物が見つかったときは、これまでどおり即座に返す。
        if (!fileState.noAttachment) return fileState;
        // 「添付ファイルはありません」は、Classroomが描き直している
        // 一瞬だけ出ることがある。すぐ確定させると、提出済みの学生を
        // 添付なしと誤判定してしまうため、少しだけ確認し直す。
        if (!noAttachmentSince) noAttachmentSince = Date.now();
        if (Date.now() - noAttachmentSince >= NO_ATTACHMENT_CONFIRM_MS) return fileState;
      } else {
        noAttachmentSince = 0;
      }
      await wait(250);
    }
    const finalState = inspectSubmissionFile();
    if (expectedStudentKey && navigationStudentKey() !== expectedStudentKey) return null;
    if (finalState?.noAttachment) return { noAttachment: true };
    if (finalState && !finalState.waiting && !submissionFileStillPrevious(previousFileId, finalState)) return finalState;
    return null;
  }
'''
content = replace_regex_once(
    content,
    r'^  async function waitForSubmissionFile\([^\n]*\) \{.*?^  \}\n(?=\n  function formatDuration)',
    new_file_wait,
    "reject stale previous student file",
)

content = replace_once(
    content,
    '  async function waitForSubmissionFileWithRecovery(timeoutMs = 15000) {',
    '  async function waitForSubmissionFileWithRecovery(timeoutMs = 15000, previousFileId = "", expectedStudentKey = "") {',
    "extend file recovery signature",
)
content = replace_once(
    content,
    '      const fileInfo = await waitForSubmissionFile(timeoutMs);',
    '      const fileInfo = await waitForSubmissionFile(timeoutMs, previousFileId, expectedStudentKey);',
    "pass stale-file guard to file wait",
)
content = replace_once(
    content,
    '      if (retries > MAX_FILE_WAIT_RETRIES) {',
    '      const maximumRetries = previousFileId ? 0 : MAX_FILE_WAIT_RETRIES;\n      if (retries > maximumRetries) {',
    "avoid long retries after student navigation",
)

# ---------------------------------------------------------------------------
# 3. Student navigation succeeds on a stable URL student-key change only.
#    File readiness is checked separately in the next loop iteration.
# ---------------------------------------------------------------------------
new_move = '''  function studentNavigationChanged(previousKey, currentKey) {
    return Boolean(currentKey) && currentKey !== previousKey;
  }

  async function waitForStudentNavigation(previousKey, timeoutMs = 10000) {
    const startedAt = Date.now();
    let changedKey = "";
    let changedSince = 0;
    while (Date.now() - startedAt < timeoutMs) {
      if (!await waitForPreparationVisibility()) return "";
      const currentKey = navigationStudentKey();
      if (studentNavigationChanged(previousKey, currentKey)) {
        if (changedKey !== currentKey) {
          changedKey = currentKey;
          changedSince = Date.now();
        }
        if (Date.now() - changedSince >= 300) return currentKey;
      } else {
        changedKey = "";
        changedSince = 0;
      }
      await wait(120);
    }
    return "";
  }

  async function moveSubmission(direction, transition = null) {
    if (!contextAvailable()) return { status: "stuck", transition };
    if (!await waitForPreparationVisibility()) return { status: "stuck", transition };

    // 最初のクリックでURLが変わらなかった場合だけ、同じ学生にいることを
    // 再確認して1回だけ押し直す。学生IDが変わっていれば再クリックしないため、
    // 遅延した遷移で1人飛ばすことはない。
    if (transition) {
      if (studentNavigationChanged(transition.before, navigationStudentKey())) {
        await wait(direction === "next" ? 350 : 180);
        return { status: "moved" };
      }
      if (transition.retried) return { status: "stuck", transition };
      const retryButton = await waitForSubmissionButton(direction, 3000);
      if (!retryButton) return { status: document.hidden ? "stuck" : "missing", transition };
      if (submissionButtonDisabled(retryButton)) return { status: "end" };
      if (navigationStudentKey() !== transition.before) {
        await wait(direction === "next" ? 350 : 180);
        return { status: "moved" };
      }
      transition.retried = true;
      retryButton.click();
      if (!await waitForStudentNavigation(transition.before, 10000)) {
        return { status: "stuck", transition };
      }
      await wait(direction === "next" ? 350 : 180);
      return { status: "moved" };
    }

    const button = await waitForSubmissionButton(direction);
    // 「押せない状態で見つかった」なら本当に端。「見つからない」だけのときは、
    // 背面で止まっているか描き直し中の可能性があるので端と決めつけない。
    if (!button) return { status: document.hidden ? "stuck" : "missing" };
    if (submissionButtonDisabled(button)) return { status: "end" };
    const before = navigationStudentKey();
    if (!before) return { status: "stuck" };
    button.click();
    const pendingTransition = { before, retried: false };
    if (!await waitForStudentNavigation(before, 10000)) {
      return { status: "stuck", transition: pendingTransition };
    }
    await wait(direction === "next" ? 350 : 180);
    return { status: "moved" };
  }
'''
content = replace_regex_once(
    content,
    r'^  async function moveSubmission\([^\n]*\) \{.*?^  \}\n(?=\n  // 背面であることは停止理由ではない)',
    new_move,
    "decouple navigation from file rendering",
)

new_recovery = '''  async function moveWithRecovery(direction) {
    let retries = 0;
    let transition = null;
    while (!state.prepareCancelled && contextAvailable()) {
      const result = await moveSubmission(direction, transition);
      const status = result.status;
      if (status === "moved" || status === "end") {
        if (retries) {
          setPreparationProgress({
            delayed: false,
            stalled: false,
            detailText: "Classroomの学生切替を確認しました。準備を続けます。"
          });
        }
        return status;
      }

      transition = result.transition || transition || null;
      retries += 1;
      // 同じ学生で安全に1回押し直してもURLが変わらなければ、そこで中断する。
      // 無制限にクリックすると学生を飛ばす危険がある。
      if (status === "stuck" && transition?.retried) return "stuck";
      if (!transition && retries > BACKGROUND_RETRY_BEFORE_STALLED) return status;
      setPreparationProgress({
        delayed: document.hidden,
        stalled: false,
        detailText: transition
          ? "次の学生への移動を確認できなかったため、同じ位置で1回だけ再試行します。"
          : document.hidden
            ? `背面で次へボタンを待っています（${retries}/${BACKGROUND_RETRY_BEFORE_STALLED}回目）。`
            : `次へボタンを確認中です（${retries}/${BACKGROUND_RETRY_BEFORE_STALLED}回目）。`
      });
      if (!transition) await wait(BACKGROUND_RETRY_MS);
    }
    return "stuck";
  }
'''
content = replace_regex_once(
    content,
    r'^  async function moveWithRecovery\(direction\) \{.*?^  \}\n(?=\n  async function waitForSubmissionFileWithRecovery)',
    new_recovery,
    "simplify safe navigation recovery",
)

# ---------------------------------------------------------------------------
# 4. Prepare loop: identify the student first, guard against stale previews,
#    and register PDFs without downloading/converting them.
# ---------------------------------------------------------------------------
content = replace_once(
    content,
    '    let noAttachmentCount = 0;\n    let forwardMoves = 0;',
    '    let noAttachmentCount = 0;\n    let directPdfCount = 0;\n    let previousDisplayedFileId = "";\n    let forwardMoves = 0;',
    "add direct PDF and previous-file counters",
)

old_loop_start = '''        // 提出物の名前が出そろってから鍵を作る。先に作ると読み込み途中の
        // 名前で保存され、採点時に準備済みPDFを見つけられなくなる。
        const missingStudent = zipStatusOf(getStudentLabel()) === "未提出";
        let fileInfo = sequence === 1 && initialFileInfo
          ? initialFileInfo
          : missingStudent
            ? null
            : await waitForSubmissionFileWithRecovery(15000);
        const studentKey = navigationStudentKey();
        if (!studentKey) {
          stopReason = "student-key-missing";
          break;
        }
        if (seen.has(studentKey)) {
          stopReason = "duplicate-student";
          break;
        }
        seen.add(studentKey);
'''
new_loop_start = '''        // 学生IDを先に確定する。ファイル表示は遅れて更新されることがあるため、
        // 学生移動の成否とファイル読み込みを同じ判定にしない。
        const studentKey = navigationStudentKey();
        if (!studentKey) {
          stopReason = "student-key-missing";
          break;
        }
        if (seen.has(studentKey)) {
          stopReason = "duplicate-student";
          break;
        }
        seen.add(studentKey);
        const missingStudent = zipStatusOf(getStudentLabel()) === "未提出";
        const fileInfo = sequence === 1 && initialFileInfo
          ? initialFileInfo
          : missingStudent
            ? null
            : await waitForSubmissionFileWithRecovery(15000, previousDisplayedFileId, studentKey);
        // 前の学生のファイルIDは、この学生の読み込み確認にだけ使う。
        previousDisplayedFileId = "";
'''
content = replace_once(content, old_loop_start, new_loop_start, "identify student before file wait")

# Count PDF-direct entries as ready throughout this function.
prepare_start = content.index('  async function prepareAllSubmissions(')
prepare_end = content.index('\n  // ============================================================\n  // 提出物のZIP一括ダウンロード', prepare_start)
prepare_section = content[prepare_start:prepare_end]
prepare_section = prepare_section.replace('preparedCount + cachedCount', 'preparedCount + cachedCount + directPdfCount')
content = content[:prepare_start] + prepare_section + content[prepare_end:]

pdf_branch_anchor = '''              continue;
            }
            // 画面に出ている1件はそのまま使い、それ以外は番号があれば
'''
pdf_branch = '''              continue;
            }
            // PDFはすでに表示可能な形式なので、一括準備では取得・変換・保存を
            // 行わない。ファイル情報だけを一覧へ登録し、必要なときに直接開く。
            if (file.kind === "pdf") {
              directPdfCount += 1;
              const sourceUrl = sourceUrlForFile(file) || file.sourceUrl || "";
              addLedgerEntry(fileIndex, file, { status: "pdf-direct", sourceUrl });
              setPreparationProgress({
                countText: preparationCountText(preparedCount + cachedCount + directPdfCount, skippedCount + failedCount, sequence),
                detailText: `${file.fileName} はPDFのため変換せず一覧に登録しました。`,
                fileName: file.fileName
              });
              continue;
            }
            // 画面に出ている1件はそのまま使い、それ以外は番号があれば
'''
content = replace_once(content, pdf_branch_anchor, pdf_branch, "register PDFs without conversion")

move_anchor = '''        if (state.prepareCancelled) break;
        const moved = await moveWithRecovery("next");
        if (moved !== "moved") {
          stopReason = moved;
          break;
        }
        forwardMoves += 1;
'''
move_replacement = '''        if (state.prepareCancelled) break;
        // 次の学生の画面に前のPDFが残っていても誤登録しないよう、移動前の
        // ファイルIDを次のループへ1回だけ引き継ぐ。
        const departingFileId = findDisplayedFileId() || fileInfo?.expectedFileId || "";
        const moved = await moveWithRecovery("next");
        if (moved !== "moved") {
          stopReason = moved;
          break;
        }
        previousDisplayedFileId = departingFileId;
        forwardMoves += 1;
'''
content = replace_once(content, move_anchor, move_replacement, "carry previous file id across navigation")

content = replace_once(
    content,
    '        linkCount ? `共有リンク ${linkCount}件` : "",\n        noAttachmentCount ? `添付なし ${noAttachmentCount}件` : "",',
    '        directPdfCount ? `PDF（変換不要） ${directPdfCount}件` : "",\n        linkCount ? `共有リンク ${linkCount}件` : "",\n        noAttachmentCount ? `添付なし ${noAttachmentCount}件` : "",',
    "show direct PDF count in summary",
)

# Ledger and catalog presentation for direct PDFs.
content = replace_once(
    content,
    '      row.dataset.status = ["ok", "link", "no-attachment"].includes(entry.status) ? entry.status : "failed";',
    '      row.dataset.status = ["ok", "pdf-direct", "link", "no-attachment"].includes(entry.status) ? entry.status : "failed";',
    "style direct PDF ledger entries",
)
content = replace_once(
    content,
    '      } else if (entry.status === "link") {',
    '''      } else if (entry.status === "pdf-direct") {
        const note = document.createElement(entry.sourceUrl ? "a" : "span");
        note.className = "cwr-preparation-ledger-note";
        note.textContent = entry.sourceUrl ? "元のPDFを開く（変換不要）" : "PDF（変換不要）";
        if (entry.sourceUrl) {
          note.href = entry.sourceUrl;
          note.target = "_blank";
          note.rel = "noopener noreferrer";
        }
        row.append(note);
      } else if (entry.status === "link") {''',
    "render direct PDF ledger entry",
)
content = replace_once(
    content,
    '      status: entry.status === "ok" ? "available" : (entry.status || "unavailable")',
    '      status: ["ok", "pdf-direct"].includes(entry.status) ? "available" : (entry.status || "unavailable")',
    "make direct PDFs available in catalog",
)

# Export pure helpers for deterministic regression tests.
content = replace_once(
    content,
    '      submissionStateKind,\n      submissionChangeReady,\n      preparationDocumentState,',
    '      submissionStateKind,\n      submissionChangeReady,\n      studentNavigationChanged,\n      displayedSubmissionFileId,\n      submissionFileStillPrevious,\n      preparationDocumentState,',
    "export navigation test helpers",
)

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
flow_insert = r'''
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
'''
flow_tests = replace_once(
    flow_tests,
    '\nconsole.log("9件の一括準備・キャッシュ・先読み・排他・未提出遷移テストに合格しました。");',
    flow_insert + '\nconsole.log("12件の一括準備・学生移動・PDF直登録テストに合格しました。");',
    "extend bulk preparation tests",
)

detection_insert = '''// 学生移動はファイル状態ではなく、URL由来の学生キーの変化だけで判定する。
assert.equal(noAttachmentWithoutNavigationHooks.studentNavigationChanged("u:student-a", "u:student-b"), true);
assert.equal(noAttachmentWithoutNavigationHooks.studentNavigationChanged("u:student-a", "u:student-a"), false);
assert.equal(noAttachmentWithoutNavigationHooks.studentNavigationChanged("u:student-a", ""), false);

// 次の学生へ移動した直後に前のPDF iframeが残っている場合は、まだ新しい提出物としない。
const stalePreviousPdfId = "1STALEPREVIOUSPDFID123456789012345";
const stalePreviousPdfHooks = runDetection({
  frames: [new MockElement({ src: `https://docs.google.com/file/d/${stalePreviousPdfId}/grading` })]
});
assert.equal(
  stalePreviousPdfHooks.submissionFileStillPrevious(stalePreviousPdfId, { kind: "pdf", expectedFileId: stalePreviousPdfId }),
  true
);
assert.equal(
  stalePreviousPdfHooks.submissionFileStillPrevious("1OTHERPREVIOUSPDFID12345678901234", { kind: "pdf", expectedFileId: stalePreviousPdfId }),
  false
);

'''
detection_tests = replace_once(
    detection_tests,
    '// 学生の識別情報の変化を先に確認する。ファイルIDが無いことだけでは切替成功にしない。\n',
    detection_insert + '// 学生の識別情報の変化を先に確認する。ファイルIDが無いことだけでは切替成功にしない。\n',
    "add navigation and stale-file behavior tests",
)

old_validate = '''// 学生切替は、表示中のファイル番号が入れ替わるまで完了と見なさない。
// ここを戻すと、前の提出物のまま同じPDFが再表示される。
assert(content.includes("async function waitForSubmissionChange(previousKey, timeoutMs = 20000, previousFileId"));
assert(content.includes("waitForSubmissionChange(before, 8000, beforeFileId)"));
assert(content.includes("waitForSubmissionChange(before, 20000, beforeFileId, beforeLabel)"));
'''
new_validate = '''// 学生切替はURLの学生ID変化だけで確認し、ファイル表示は次のループで別に待つ。
// 前のPDFが残っている間はsubmissionFileStillPreviousで受理しない。
assert(content.includes("async function waitForStudentNavigation(previousKey, timeoutMs = 10000)"));
assert(content.includes("waitForStudentNavigation(before, 10000)"));
assert(content.includes("function submissionFileStillPrevious"));
assert(content.includes("waitForSubmissionFileWithRecovery(15000, previousDisplayedFileId, studentKey)"));
assert(content.includes('status: "pdf-direct"'));
'''
validate = replace_once(validate, old_validate, new_validate, "update release navigation validation")

CONTENT_PATH.write_text(content, encoding="utf-8")
FLOW_TEST_PATH.write_text(flow_tests, encoding="utf-8")
DETECTION_TEST_PATH.write_text(detection_tests, encoding="utf-8")
VALIDATE_PATH.write_text(validate, encoding="utf-8")
