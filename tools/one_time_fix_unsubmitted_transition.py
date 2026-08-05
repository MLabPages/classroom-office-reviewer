from pathlib import Path
import re

CONTENT_PATH = Path("extension/content.js")
FLOW_TEST_PATH = Path("tests/bulk-preparation-flow.mjs")
DETECTION_TEST_PATH = Path("tests/content-detection.mjs")


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

content = replace_once(
    content,
    '    "提出済み", "遅れて提出", "提出期限後に提出", "返却済み", "採点済み", "下書き", "割り当て済み", "未提出",\n',
    '    "提出済み", "遅れて提出", "提出期限後に提出", "返却済み", "採点済み", "下書き", "割り当て済み", "不足", "未提出",\n',
    "recognize Japanese Missing status",
)
content = replace_once(
    content,
    '    if (["割り当て済み", "Assigned", "Missing", "未提出"].includes(found)) return "未提出";',
    '    if (["割り当て済み", "不足", "Assigned", "Missing", "未提出"].includes(found)) return "未提出";',
    "normalize Japanese Missing status",
)

new_ready = '''  function submissionChangeReady({
    studentChanged = false,
    fileState = null,
    previousFileId = "",
    displayedFileId = "",
    studentChangedForMs = 0,
    noAttachmentForMs = 0,
    submissionStatus = "",
    studentLabelChanged = false,
    submissionStatusForMs = 0
  } = {}) {
    if (!studentChanged) return false;
    // 未提出者では添付欄そのものが出ないことがある。URLの学生IDに加えて、
    // 新しい学生の表示名・提出状態が一定時間安定したら切替完了とする。
    // 表示名の変化も必須にし、前の未提出者の状態が残った一瞬を誤認しない。
    if (
      submissionStatus === "未提出"
      && studentLabelChanged
      && submissionStatusForMs >= NO_ATTACHMENT_CONFIRM_MS
    ) return true;
    const stateKind = submissionStateKind(fileState);
    if (!stateKind) return false;
    if (stateKind === "no-attachment") return noAttachmentForMs >= NO_ATTACHMENT_CONFIRM_MS;
    if (displayedFileId && displayedFileId !== previousFileId) return true;
    if (displayedFileId && previousFileId && displayedFileId === previousFileId) return false;
    return studentChangedForMs >= NO_ATTACHMENT_CONFIRM_MS;
  }
'''
content = replace_regex_once(
    content,
    r'^  function submissionChangeReady\(\{\n.*?^  \}\n(?=\n  async function waitForSubmissionChange)',
    new_ready,
    "extend submission change readiness",
)

new_wait = '''  async function waitForSubmissionChange(previousKey, timeoutMs = 20000, previousFileId = "", previousLabel = "") {
    const startedAt = Date.now();
    let pausedMilliseconds = 0;
    let studentChangedAt = 0;
    let noAttachmentSince = 0;
    let submissionStatusSince = 0;
    while (Date.now() - startedAt - pausedMilliseconds < timeoutMs) {
      const pauseStartedAt = Date.now();
      if (!await waitForPreparationVisibility()) return false;
      pausedMilliseconds += Date.now() - pauseStartedAt;
      if (Date.now() - startedAt - pausedMilliseconds >= timeoutMs) return false;
      const currentKey = navigationStudentKey();
      const studentChanged = Boolean(currentKey) && currentKey !== previousKey;
      const currentLabel = getStudentLabel();
      const studentLabelChanged = Boolean(currentLabel) && currentLabel !== previousLabel;
      const submissionStatus = zipStatusOf(currentLabel);
      const fileState = inspectSubmissionFile();
      if (studentChanged) {
        if (!studentChangedAt) studentChangedAt = Date.now();
        // 未提出者には新しいDriveファイルIDや「添付ファイルはありません」が
        // 出ない場合がある。新しい学生の表示名と未提出状態が安定した時間も測る。
        if (submissionStatus === "未提出" && studentLabelChanged) {
          if (!submissionStatusSince) submissionStatusSince = Date.now();
        } else {
          submissionStatusSince = 0;
        }
        if (fileState?.noAttachment === true) {
          if (!noAttachmentSince) noAttachmentSince = Date.now();
        } else {
          noAttachmentSince = 0;
        }
        const displayedFileId = findDisplayedFileId();
        if (submissionChangeReady({
          studentChanged,
          fileState,
          previousFileId,
          displayedFileId,
          studentChangedForMs: Date.now() - studentChangedAt,
          noAttachmentForMs: noAttachmentSince ? Date.now() - noAttachmentSince : 0,
          submissionStatus,
          studentLabelChanged,
          submissionStatusForMs: submissionStatusSince ? Date.now() - submissionStatusSince : 0
        })) return true;
      }
      await wait(150);
    }
    return false;
  }
'''
content = replace_regex_once(
    content,
    r'^  async function waitForSubmissionChange\([^\n]*\) \{\n.*?^  \}\n(?=\n  function localWait)',
    new_wait,
    "track stable unsubmitted status",
)

content = replace_once(
    content,
    '      if (!await waitForSubmissionChange(transition.before, BACKGROUND_RETRY_MS, transition.beforeFileId)) {',
    '      if (!await waitForSubmissionChange(transition.before, BACKGROUND_RETRY_MS, transition.beforeFileId, transition.beforeLabel)) {',
    "reuse previous label on transition recheck",
)
content = replace_once(
    content,
    '    const beforeFileId = findDisplayedFileId();\n    button.click();\n    const pendingTransition = { before, beforeFileId };\n    if (!await waitForSubmissionChange(before, 20000, beforeFileId)) {',
    '    const beforeFileId = findDisplayedFileId();\n    const beforeLabel = getStudentLabel();\n    button.click();\n    const pendingTransition = { before, beforeFileId, beforeLabel };\n    if (!await waitForSubmissionChange(before, 20000, beforeFileId, beforeLabel)) {',
    "capture previous label before moving",
)

new_recovery = '''      // クリック済みなら矢印は押し直さず、同じ遷移を複数回確認する。
      // 未提出者はClassroomの描画が遅いことがあり、最初の20秒だけで止めない。
      transition = result.transition || transition || null;
      retries += 1;
      const transitionRetry = Boolean(transition);
      const retryLimit = transitionRetry
        ? BACKGROUND_RETRY_BEFORE_STALLED
        : BACKGROUND_RETRY_BEFORE_STALLED + 1;
      if (retries >= retryLimit) return transitionRetry ? "stuck" : status;
      const stalled = retries > BACKGROUND_RETRY_BEFORE_STALLED;
      setPreparationProgress({
        delayed: !stalled && document.hidden,
        stalled,
        detailText: transitionRetry
          ? `切り替え済みの学生画面を再確認しています（${retries}/${retryLimit - 1}回目）。`
          : stalled
            ? "Classroomの画面更新を待っています。正しい学生・ファイルを確認するため、30秒後に自動で再試行します。"
            : document.hidden
              ? `背面で画面更新を待っています（${retries}/${BACKGROUND_RETRY_BEFORE_STALLED}回目の自動再試行）。`
              : `画面更新を確認中です（${retries}/${BACKGROUND_RETRY_BEFORE_STALLED}回目の自動再試行）。`
      });
      // transition付きのmoveSubmission自体が10秒待つため、追加待機はしない。
      if (!transitionRetry) await wait(stalled ? BACKGROUND_STALLED_RETRY_MS : BACKGROUND_RETRY_MS);
'''
content = replace_regex_once(
    content,
    r'^      // クリック済みの遷移は、Classroomが遅れて更新する可能性があるため\n.*?^      await wait\(stalled \? BACKGROUND_STALLED_RETRY_MS : BACKGROUND_RETRY_MS\);\n',
    new_recovery,
    "retry an already-clicked transition",
)

content = replace_once(
    content,
    '      if (!state.prepareCancelled && !["end", "limit"].includes(stopReason)) {\n'
    '        throw new Error(`${seen.size}人目まで確認しました。現在位置から再開してください`);\n'
    '      }',
    '      if (!state.prepareCancelled && !["end", "limit"].includes(stopReason)) {\n'
    '        const reason = {\n'
    '          "student-key-missing": "現在の学生を識別できませんでした",\n'
    '          "duplicate-student": "同じ学生を再び検出しました",\n'
    '          missing: "次へボタンを取得できませんでした",\n'
    '          stuck: "次の学生への画面切替を確認できませんでした"\n'
    '        }[stopReason] || "一括準備を最後まで完了できませんでした";\n'
    '        throw new Error(`${reason}。${seen.size}人目まで確認しました。現在位置から再開してください。`);\n'
    '      }',
    "show the actual traversal stop reason",
)

flow_insert = '''
// テスト9：未提出ステータスだけの画面でも切替完了にし、クリック後の遷移を再確認する。
assert.match(content, /"割り当て済み", "不足", "未提出"/);
assert.match(content, /\["割り当て済み", "不足", "Assigned", "Missing", "未提出"\]/);
assert.match(content, /submissionStatus === "未提出"/);
assert.match(content, /studentLabelChanged/);
assert.match(content, /submissionStatusForMs >= NO_ATTACHMENT_CONFIRM_MS/);
assert.match(content, /transition\.beforeLabel/);
assert.match(content, /const beforeLabel = getStudentLabel\(\);/);
assert.match(content, /const transitionRetry = Boolean\(transition\);/);
assert.doesNotMatch(content, /if \(status === "stuck" && \(transition \|\| result\.transition\)\) return "stuck";/);
assert.match(content, /次の学生への画面切替を確認できませんでした/);
'''
flow_tests = replace_once(
    flow_tests,
    '\nconsole.log("8件の一括準備・キャッシュ・先読み・排他テストに合格しました。");\n',
    flow_insert + '\nconsole.log("9件の一括準備・キャッシュ・先読み・排他・未提出遷移テストに合格しました。");\n',
    "extend bulk preparation regression tests",
)

detection_insert = '''// Classroomが未提出を「不足」と表示する場合も、未提出として扱う。
assert.equal(noAttachmentWithoutNavigationHooks.zipStatusOf("26_0301 佐藤 不足"), "未提出");
// 添付欄が無くても、新しい学生の表示名と未提出状態が安定すれば切替完了にする。
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    submissionStatus: "未提出",
    studentLabelChanged: true,
    submissionStatusForMs: 1500
  }),
  true
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    submissionStatus: "未提出",
    studentLabelChanged: false,
    submissionStatusForMs: 2000
  }),
  false,
  "前の未提出者の表示が残っている間は切替完了にしない"
);
assert.equal(
  noAttachmentWithoutNavigationHooks.submissionChangeReady({
    studentChanged: true,
    fileState: null,
    submissionStatus: "未提出",
    studentLabelChanged: true,
    submissionStatusForMs: 1499
  }),
  false,
  "未提出状態も一定時間安定するまで確定しない"
);

'''
detection_tests = replace_once(
    detection_tests,
    'assert.deepEqual(plain(noAttachmentWithoutNavigationHooks.zipCollectionCompletion({\n',
    detection_insert + 'assert.deepEqual(plain(noAttachmentWithoutNavigationHooks.zipCollectionCompletion({\n',
    "add stable unsubmitted status behavior tests",
)

CONTENT_PATH.write_text(content, encoding="utf-8")
FLOW_TEST_PATH.write_text(flow_tests, encoding="utf-8")
DETECTION_TEST_PATH.write_text(detection_tests, encoding="utf-8")
