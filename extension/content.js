(() => {
  const isClassroomTop = location.hostname === "classroom.google.com" && window === window.top;
  // 準備専用タブが背面のとき、Chromeはタイマーを最大1分まで遅らせる。
  // 進捗が途絶えたと判断するまでの余裕をここで一括管理する。
  const PROGRESS_TICK_MS = 2000;
  const STALL_WARNING_MS = 40000;
  // 提出者の切替ボタンは、採点画面が出ていれば数百ミリ秒で見つかる。
  // 見つからない時間を長く待つと、先頭と末尾の判定でそのぶん待たされる。
  const SUBMISSION_BUTTON_WAIT_MS = 5000;
  const state = {
    enabled: true,
    busy: false,
    auto: false,
    preparing: false,
    remotePreparing: false,
    dedicatedPreparation: false,
    isPreparationTab: false,
    prepareCancelled: false,
    mode: "pdf",
    submissionView: false,
    currentKey: "",
    convertedKey: "",
    displayedPdfUrl: "",
    viewerStatus: null,
    timer: null,
    preparationTimer: null,
    progressTicker: null,
    watchdogTimer: null,
    lastRemoteProgressAt: 0,
    preparationCompact: false,
    wide: false,
    overlayBounds: null,
    activeFile: null,
    ui: null,
    overlay: null,
    pendingOverlay: null
  };

  // 画面に出す準備状況は1か所にまとめ、準備専用タブと採点タブで同じ内容を描く。
  const progress = {
    phase: "idle",
    title: "提出物の一括準備",
    countText: "準備を開始しています…",
    detailText: "先頭の提出者を確認中です。",
    fileName: "",
    done: 0,
    skipped: 0,
    current: 0,
    startedAt: 0,
    stalled: false,
    remote: false
  };

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function textOf(element) {
    return (element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function labelSourcesOf(node) {
    return [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("data-tooltip"),
      textOf(node)
    ];
  }

  function matchFileName(source, extensionPattern) {
    if (!source || source.length > 220) return "";
    // Classroom sometimes concatenates the visible label twice without a
    // separator (for example, `name.docxname.docx`).  Requiring whitespace
    // after the extension misses the first, valid filename in that case.
    // A filename cannot contain a colon, so use the last label prefix as a
    // boundary and stop at the first supported extension.
    const colonIndex = source.lastIndexOf(":");
    const candidateSource = (colonIndex >= 0 ? source.slice(colonIndex + 1) : source).trim();
    const match = candidateSource.match(new RegExp(`([^\\\\/:*?\"<>|\\r\\n]{1,160}?\\.(?:${extensionPattern}))`, "i"));
    if (!match) return "";
    return match[1]
      .trim()
      .replace(/^[「『〈《【（([{]+/u, "")
      .replace(/[」』〉》】）)\]}]+$/u, "");
  }

  function findFileName(extensionPattern) {
    const nodes = document.querySelectorAll("a, button, [role='button'], [role='menuitem'], [aria-label], [title], [data-tooltip]");
    for (const node of nodes) {
      if (!visible(node)) continue;
      for (const source of labelSourcesOf(node)) {
        const fileName = matchFileName(source, extensionPattern);
        if (fileName) return fileName;
      }
    }
    return "";
  }

  function findOfficeFileName() {
    return findFileName("docx?|pptx?");
  }

  function findAnyAttachmentFileName() {
    return findFileName("docx?|pptx?|pdf|xlsx?|csv|txt|rtf|odt|ods|odp|jpe?g|png|gif|webp|zip");
  }

  function findGoogleFileInfo() {
    const frames = [...document.querySelectorAll("iframe[src]")];
    const documentFrame = frames.find((frame) => visible(frame) && /docs\.google\.com\/document\/(?:u\/\d+\/)?d\//i.test(frame.src));
    const slidesFrame = frames.find((frame) => visible(frame) && /docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\//i.test(frame.src));
    let labeledKind = "";
    let labeledFileName = "";
    const nodes = document.querySelectorAll("a, button, [role='button'], [role='menuitem'], [aria-label], [title], [data-tooltip]");
    for (const node of nodes) {
      if (!visible(node)) continue;
      const sources = [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-tooltip"), textOf(node)];
      for (const source of sources) {
        const match = source?.match(/^Google\s*(ドキュメント|Docs?|スライド|Slides?)\s*[:：]\s*(.{1,160})$/i);
        if (!match) continue;
        labeledKind = /ドキュメント|docs?/i.test(match[1]) ? "google-document" : "google-presentation";
        labeledFileName = match[2].trim();
        break;
      }
      if (labeledKind) break;
    }
    if (!labeledKind && !documentFrame && !slidesFrame) return null;
    const kind = labeledKind || (documentFrame ? "google-document" : "google-presentation");
    const matchingFrame = kind === "google-document" ? documentFrame : slidesFrame;
    return {
      kind,
      fileName: labeledFileName || (kind === "google-document" ? "Googleドキュメント" : "Googleスライド"),
      expectedName: "",
      expectedFileId: parseDriveId(matchingFrame?.src || ""),
      expectedGoogleType: kind === "google-document" ? "document" : "presentation"
    };
  }

  function findSupportedFileInfo() {
    const googleFileInfo = findGoogleFileInfo();
    if (googleFileInfo) return googleFileInfo;
    const officeFileName = findOfficeFileName();
    if (officeFileName) return { kind: "office", fileName: officeFileName, expectedName: officeFileName };
    return null;
  }

  function googleTypeOfUrl(value) {
    if (/docs\.google\.com\/document\//i.test(value)) return "document";
    if (/docs\.google\.com\/presentation\//i.test(value)) return "presentation";
    return "";
  }

  // 添付カードの名前は、リンク自身か近い親のラベルに入っている。
  function attachmentNameOf(node, googleType) {
    let current = node;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      for (const source of labelSourcesOf(current)) {
        const officeName = matchFileName(source, "docx?|pptx?");
        if (officeName) return officeName;
        const googleLabel = source?.match(/^Google\s*(?:ドキュメント|Docs?|スライド|Slides?)\s*[:：]\s*(.{1,160})$/i);
        if (googleLabel) return googleLabel[1].trim();
      }
      current = current.parentElement;
    }
    if (!googleType) return "";
    const label = textOf(node).slice(0, 160);
    return label || (googleType === "document" ? "Googleドキュメント" : "Googleスライド");
  }

  // 1人が複数ファイルを提出することがある。1件目だけ準備して残りを取り
  // こぼさないよう、提出者画面にある添付リンクをすべて拾う。
  function findSubmissionAttachments() {
    const attachments = [];
    const seen = new Set();
    for (const node of document.querySelectorAll("a[href]")) {
      const url = node.href || "";
      if (!/(?:drive|docs)\.google\.com/i.test(url)) continue;
      if (!visible(node)) continue;
      const fileId = parseDriveId(url);
      if (!fileId || seen.has(fileId)) continue;
      const googleType = googleTypeOfUrl(url);
      const fileName = attachmentNameOf(node, googleType);
      if (!fileName) continue;
      if (!googleType && !/\.(?:docx?|pptx?)$/i.test(fileName)) continue;
      seen.add(fileId);
      attachments.push({
        kind: googleType ? (googleType === "document" ? "google-document" : "google-presentation") : "office",
        fileName,
        expectedName: googleType ? "" : fileName,
        expectedFileId: fileId,
        expectedGoogleType: googleType
      });
    }
    return attachments;
  }

  // 表示中の1件（従来の検出）を先頭に、見つかった添付を続ける。
  // 添付の検出に失敗しても、これまでどおり1件目は必ず準備できる。
  function listSubmissionFiles(primary = findSupportedFileInfo()) {
    const files = primary && !primary.unsupported && !primary.waiting ? [primary] : [];
    for (const attachment of findSubmissionAttachments()) {
      const duplicate = files.some((item) => (item.expectedFileId && item.expectedFileId === attachment.expectedFileId)
        || (!item.expectedFileId && item.fileName === attachment.fileName));
      if (!duplicate) files.push(attachment);
    }
    return files;
  }

  function inspectSubmissionFile() {
    const supportedFile = findSupportedFileInfo();
    if (supportedFile?.kind?.startsWith("google-") && !supportedFile.expectedFileId) return { waiting: true };
    if (supportedFile) return supportedFile;
    if (findAnyAttachmentFileName()) return { unsupported: true };
    return null;
  }

  function parseDriveId(value) {
    if (!value) return "";
    const patterns = [
      /\/d\/([a-zA-Z0-9_-]{20,})/,
      /[?&]id=([a-zA-Z0-9_-]{20,})/,
      /\/file\/([a-zA-Z0-9_-]{20,})/
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return match[1];
    }
    return "";
  }

  function describeDocument() {
    let downloadUrl = "";
    let fileId = parseDriveId(location.href);
    const classroomGoogleInfo = isClassroomTop ? findGoogleFileInfo() : null;
    const googleType = (classroomGoogleInfo?.expectedFileId ? classroomGoogleInfo.expectedGoogleType : "") || (/docs\.google\.com\/document\/(?:u\/\d+\/)?d\//i.test(location.href)
      ? "document"
      : /docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\//i.test(location.href)
        ? "presentation"
        : "");
    const candidates = document.querySelectorAll("a[href], iframe[src]");

    for (const element of candidates) {
      const value = element.href || element.src || "";
      if (!fileId) fileId = parseDriveId(value);
      if (!downloadUrl && /(?:usercontent\.google\.com\/download|[?&]export=download|\/uc\?)/i.test(value)) {
        downloadUrl = value;
      }
    }

    const authMatch = location.href.match(/\/u\/(\d+)(?:\/|$)/);
    return {
      fileName: classroomGoogleInfo?.fileName || findOfficeFileName() || (googleType === "document" ? "Googleドキュメント" : googleType === "presentation" ? "Googleスライド" : ""),
      fileId,
      downloadUrl,
      googleType,
      submissionView: !isClassroomTop || isSubmissionView(),
      authuser: authMatch ? Number(authMatch[1]) : null,
      frameUrl: location.href
    };
  }

  if (globalThis.__CWR_TEST_HOOKS__) {
    Object.assign(globalThis.__CWR_TEST_HOOKS__, {
      findOfficeFileName,
      findAnyAttachmentFileName,
      findGoogleFileInfo,
      findSupportedFileInfo,
      inspectSubmissionFile,
      describeDocument,
      isSubmissionView,
      formatDuration,
      preparationCountText,
      findSubmissionAttachments,
      listSubmissionFiles
    });
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "cwr-describe-document") {
      sendResponse(describeDocument());
      return false;
    }
    if (!isClassroomTop) return false;

    if (message?.type === "cwr-preparation-ping") {
      sendResponse({ ok: true, preparing: state.preparing });
      return false;
    }

    if (message?.type === "cwr-run-preparation") {
      if (state.preparing) {
        sendResponse({ ok: false });
        return false;
      }
      becomePreparationTab();
      // Classroomの読み込み待ちでも、このタブが何をしているのかを必ず示す。
      setPreparationProgress({
        phase: "running",
        remote: false,
        title: "提出物の一括準備",
        countText: "Classroomの読み込みを待っています…",
        detailText: "提出者を切り替えられる採点画面が出るまで待機します。",
        done: 0,
        skipped: 0,
        current: 0,
        startedAt: Date.now(),
        stalled: false,
        cancelRequested: false
      });
      (async () => {
        const ready = await waitForSubmissionView(30000);
        if (!ready) {
          const error = "準備専用タブでClassroomの提出者画面を開けませんでした。採点画面で提出物を1件開いてから、もう一度お試しください。";
          finishPreparation("一括準備を開始できませんでした", "準備は始まっていません", error, "error");
          sendResponse({ ok: false, error });
          return;
        }
        sendResponse({ ok: true });
        prepareAllSubmissions({ dedicated: true });
      })();
      return true;
    }

    if (message?.type === "cwr-cancel-preparation") {
      state.prepareCancelled = true;
      setPreparationProgress({ detailText: "現在の1件が終わったら中止します。", cancelRequested: true });
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "cwr-prepare-remote-progress") {
      handleRemotePreparationProgress(message);
      return false;
    }

    if (message?.type === "cwr-status") {
      if (message.submissionKey && message.submissionKey !== getSubmissionKey()) return false;
      setStatus(message.text, message.state);
      if (message.state === "error") state.busy = false;
    }
    if (message?.type === "cwr-show-pdf") {
      if (!state.enabled) {
        state.busy = false;
        chrome.runtime.sendMessage({ type: "cwr-release-pdf", pdfUrl: message.pdfUrl }).catch(() => undefined);
        return false;
      }
      if (message.submissionKey && message.submissionKey !== getSubmissionKey()) {
        state.busy = false;
        chrome.runtime.sendMessage({ type: "cwr-release-pdf", pdfUrl: message.pdfUrl }).catch(() => undefined);
        setStatus("提出者が切り替わったため、古い表示を破棄しました。", "idle");
        return false;
      }
      state.busy = false;
      state.convertedKey = getSubmissionKey();
      renderPdf(message.pdfUrl, message.fileName, message.pageCount);
      setStatus("提出物を表示中", "ready");
    }
    return false;
  });

  if (!isClassroomTop) return;

  function getStudentLabel() {
    const markers = ["提出済み", "Turned in", "返却済み", "Returned"];
    const elements = document.querySelectorAll("button, [role='button'], [aria-label]");
    for (const element of elements) {
      if (!visible(element)) continue;
      const value = textOf(element);
      if (value.length > 220 || !markers.some((marker) => value.includes(marker))) continue;
      const parent = element.closest("button, [role='button']") || element.parentElement || element;
      const label = textOf(parent);
      if (label) return label.slice(0, 220);
    }
    return "";
  }

  function getSubmissionKey() {
    if (!isSubmissionView()) return "";
    return [location.href, getStudentLabel(), findSupportedFileInfo()?.fileName || ""].join("|");
  }

  function findSubmissionButton(direction) {
    const labelPattern = direction === "next"
      ? /^(?:次の(?:生徒|学生)を選択|Select next student|Next student)(?:[:：]|$)/i
      : /^(?:前の(?:生徒|学生)を選択|Select previous student|Previous student)(?:[:：]|$)/i;
    return [...document.querySelectorAll("button, [role='button']")].find((element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 180 || rect.width > 90 || rect.height > 90) return false;
      const labels = [textOf(element), element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-tooltip")];
      return labels.some((label) => labelPattern.test(label || ""));
    }) || null;
  }

  function findNextSubmissionButton() {
    return findSubmissionButton("next");
  }

  function findPreviousSubmissionButton() {
    return findSubmissionButton("previous");
  }

  function isSubmissionView() {
    // The grading overview contains many submission cards and filenames.  It
    // is not a safe place to fetch anything: only the individual submission
    // screen exposes the previous/next student controls.
    return Boolean(findPreviousSubmissionButton() || findNextSubmissionButton());
  }

  async function waitForSubmissionView(timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (isSubmissionView()) return true;
      await wait(250);
    }
    return false;
  }

  async function waitForSubmissionChange(previousKey, timeoutMs = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const currentKey = getSubmissionKey();
      if (currentKey && currentKey !== previousKey && (findSupportedFileInfo() || inspectSubmissionFile()?.unsupported)) return true;
      await wait(150);
    }
    return false;
  }

  function localWait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // 背面タブのsetTimeoutはChromeに最大1分まで遅らされる。待ち時間は拡張機能の
  // バックグラウンド側でも計り、先に返ってきた方を採用する。これで採点タブへ
  // 戻しても準備が止まらない。バックグラウンドが応答しない場合は手元のタイマー
  // だけで進むため、処理が二重に走ることはない。
  function wait(milliseconds) {
    if (!milliseconds) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      localWait(milliseconds).then(finish);
      chrome.runtime.sendMessage({ type: "cwr-sleep", ms: milliseconds }).then(finish, () => undefined);
    });
  }

  function submissionButtonDisabled(button) {
    return button.disabled || button.getAttribute("aria-disabled") === "true";
  }

  async function waitForSubmissionButton(direction, timeoutMs = SUBMISSION_BUTTON_WAIT_MS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const button = findSubmissionButton(direction);
      if (button) return button;
      await wait(250);
    }
    return null;
  }

  async function waitForSubmissionFile(timeoutMs = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const fileState = inspectSubmissionFile();
      if (fileState && !fileState.waiting) return fileState;
      await wait(250);
    }
    return null;
  }

  function formatDuration(milliseconds) {
    const total = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`;
  }

  function isPreparationFinished() {
    return ["done", "cancelled", "error"].includes(progress.phase);
  }

  function preparationNote() {
    if (isPreparationFinished()) {
      return state.isPreparationTab
        ? "このタブは閉じても構いません。準備した表示用PDFは採点タブでそのまま使えます。"
        : "学生を切り替えると、準備済みのPDFがすぐ表示されます。";
    }
    if (progress.stalled) {
      return state.isPreparationTab
        ? "このタブを前面に表示すると、止まっているところから自動で再開します。"
        : "準備が進んでいません。Chromeが背面のタブを止めている可能性があります。「準備タブを開く」を押すと、続きから自動で再開します。";
    }
    return state.isPreparationTab
      ? "このタブは自動で操作します。完了まで触らずにお待ちください。終わると採点タブへ自動で戻ります。"
      : "準備専用タブで処理中です。この採点タブはそのまま採点に使えます。";
  }

  function ensurePreparationPanel() {
    const existing = document.getElementById("cwr-preparation");
    if (existing) return existing;
    const panel = document.createElement("section");
    panel.id = "cwr-preparation";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    panel.innerHTML = `
      <div id="cwr-preparation-card">
        <div id="cwr-preparation-header">
          <div id="cwr-preparation-spinner" aria-hidden="true"></div>
          <h2 id="cwr-preparation-title">提出物の一括準備</h2>
          <button id="cwr-preparation-compact" type="button" aria-pressed="false">小さく表示</button>
        </div>
        <p id="cwr-preparation-count">準備を開始しています…</p>
        <div id="cwr-preparation-bar" aria-hidden="true"><span></span></div>
        <p id="cwr-preparation-detail">先頭の提出者を確認中です。</p>
        <p id="cwr-preparation-elapsed">経過 0秒</p>
        <p id="cwr-preparation-note"></p>
        <div id="cwr-preparation-actions">
          <button id="cwr-preparation-cancel" type="button">現在の処理後に中止</button>
          <button id="cwr-preparation-focus" type="button">準備タブを開く</button>
        </div>
      </div>
    `;
    panel.querySelector("#cwr-preparation-cancel").addEventListener("click", handlePreparationCancelClick);
    panel.querySelector("#cwr-preparation-focus").addEventListener("click", handlePreparationFocusClick);
    panel.querySelector("#cwr-preparation-compact").addEventListener("click", () => {
      state.preparationCompact = !state.preparationCompact;
      chrome.storage.local.set({ cwrPreparationCompact: state.preparationCompact });
      renderPreparation();
    });
    document.body.appendChild(panel);
    return panel;
  }

  function closePreparationPanel() {
    clearInterval(state.preparationTimer);
    state.preparationTimer = null;
    document.getElementById("cwr-preparation")?.remove();
  }

  function handlePreparationCancelClick() {
    if (isPreparationFinished()) {
      closePreparationPanel();
      return;
    }
    if (state.isPreparationTab && state.preparing) {
      state.prepareCancelled = true;
      setPreparationProgress({ detailText: "現在の1件が終わったら中止します。", cancelRequested: true });
      return;
    }
    setPreparationProgress({ detailText: "準備専用タブへ中止を伝えています。", cancelRequested: true });
    chrome.runtime.sendMessage({ type: "cwr-cancel-bulk-preparation" }).then((response) => {
      if (response?.ok) return;
      endRemoteTracking();
      setPreparationProgress({
        phase: "error",
        title: "一括準備の状態を確認できません",
        detailText: response?.error || "準備専用タブが見つかりませんでした。もう一度「全員分を一括準備」を押してください。",
        cancelRequested: false
      });
    }, () => undefined);
  }

  function handlePreparationFocusClick() {
    const type = state.isPreparationTab ? "cwr-focus-source-tab" : "cwr-focus-preparation-tab";
    chrome.runtime.sendMessage({ type }).then((response) => {
      if (response?.ok || state.isPreparationTab) return;
      endRemoteTracking();
      setPreparationProgress({
        phase: "error",
        title: "準備専用タブが見つかりません",
        detailText: "もう一度「全員分を一括準備」を押すと、新しい準備専用タブで最初からやり直します。"
      });
    }, () => undefined);
  }

  function renderPreparation() {
    const panel = document.getElementById("cwr-preparation");
    if (!panel) return;
    const finished = isPreparationFinished();
    const running = !finished;
    panel.dataset.phase = progress.phase;
    panel.classList.toggle("cwr-preparation-compact", state.preparationCompact);
    panel.classList.toggle("cwr-preparation-stalled", Boolean(progress.stalled));
    panel.querySelector("#cwr-preparation-spinner").hidden = finished;
    panel.querySelector("#cwr-preparation-title").textContent = progress.title;
    panel.querySelector("#cwr-preparation-count").textContent = progress.countText;
    panel.querySelector("#cwr-preparation-detail").textContent = progress.detailText;
    panel.querySelector("#cwr-preparation-bar").hidden = finished;

    const elapsedElement = panel.querySelector("#cwr-preparation-elapsed");
    const elapsed = progress.startedAt ? Date.now() - progress.startedAt : 0;
    const average = progress.done ? elapsed / progress.done : 0;
    elapsedElement.textContent = average
      ? `経過 ${formatDuration(elapsed)}・1件あたり約${Math.max(1, Math.round(average / 1000))}秒`
      : `経過 ${formatDuration(elapsed)}`;
    panel.querySelector("#cwr-preparation-note").textContent = preparationNote();

    const cancelButton = panel.querySelector("#cwr-preparation-cancel");
    cancelButton.textContent = finished ? "閉じる" : "現在の処理後に中止";
    cancelButton.disabled = running && progress.cancelRequested === true;

    const focusButton = panel.querySelector("#cwr-preparation-focus");
    focusButton.hidden = finished || !(progress.remote || state.isPreparationTab);
    focusButton.textContent = state.isPreparationTab ? "採点タブに戻る" : "準備タブを開く";
    focusButton.classList.toggle("cwr-preparation-urgent", Boolean(progress.stalled));

    const compactButton = panel.querySelector("#cwr-preparation-compact");
    compactButton.textContent = state.preparationCompact ? "大きく表示" : "小さく表示";
    compactButton.setAttribute("aria-pressed", String(state.preparationCompact));

    // 経過時間は動いている間だけ数える。
    if (finished) {
      clearInterval(state.preparationTimer);
      state.preparationTimer = null;
    } else if (!state.preparationTimer) {
      state.preparationTimer = setInterval(renderPreparation, 1000);
    }
  }

  function endRemoteTracking() {
    state.remotePreparing = false;
    stopStallWatchdog();
    updateUiLabels();
  }

  function setPreparationProgress(patch = {}) {
    Object.assign(progress, patch);
    if (!progress.startedAt) progress.startedAt = Date.now();
    ensurePreparationPanel();
    renderPreparation();
    if (state.dedicatedPreparation) reportPreparationProgress();
  }

  function updatePreparation(countText, detailText) {
    setPreparationProgress({
      ...(countText ? { countText } : {}),
      ...(detailText ? { detailText } : {})
    });
  }

  function reportPreparationProgress() {
    if (!state.dedicatedPreparation) return;
    chrome.runtime.sendMessage({
      type: "cwr-prepare-progress",
      progress: {
        status: isPreparationFinished() ? progress.phase : "running",
        phase: progress.phase,
        title: progress.title,
        countText: progress.countText,
        detailText: progress.detailText,
        done: progress.done,
        skipped: progress.skipped,
        current: progress.current,
        startedAt: progress.startedAt,
        stalled: progress.stalled === true,
        cancelRequested: progress.cancelRequested === true
      }
    }).catch(() => undefined);
  }

  function finishPreparation(title, countText, detailText, status = "done") {
    stopProgressTicker();
    setPreparationProgress({
      phase: status,
      title,
      countText,
      detailText,
      stalled: false,
      cancelRequested: false
    });
  }

  function startProgressTicker() {
    stopProgressTicker();
    // 数値が変わらない待ち時間でも定期的に生存を伝え、採点タブ側が
    // 「止まっている」と誤解しないようにする。
    state.progressTicker = setInterval(() => {
      if (!state.preparing) return;
      reportPreparationProgress();
    }, PROGRESS_TICK_MS);
  }

  function stopProgressTicker() {
    clearInterval(state.progressTicker);
    state.progressTicker = null;
  }

  // 準備専用タブから連絡が途絶えたら、黙って待たせずに操作できる案内へ切り替える。
  // 解除は進捗が届いたときに行う（handleRemotePreparationProgress）。
  function startStallWatchdog() {
    if (state.watchdogTimer) return;
    state.lastRemoteProgressAt = Date.now();
    state.watchdogTimer = setInterval(() => {
      if (!state.remotePreparing || progress.stalled) return;
      if (Date.now() - state.lastRemoteProgressAt <= STALL_WARNING_MS) return;
      progress.stalled = true;
      renderPreparation();
    }, 5000);
  }

  function stopStallWatchdog() {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }

  function handleRemotePreparationProgress(message) {
    if (state.preparing) return;
    const running = !message.status || message.status === "running";
    state.remotePreparing = running;
    state.lastRemoteProgressAt = Date.now();
    updateUiLabels();
    setPreparationProgress({
      remote: true,
      stalled: running && message.stalled === true,
      phase: running ? "running" : message.status,
      title: message.title || progress.title,
      countText: message.countText || progress.countText,
      detailText: message.detailText || progress.detailText,
      done: message.done ?? progress.done,
      skipped: message.skipped ?? progress.skipped,
      current: message.current ?? progress.current,
      startedAt: message.startedAt || progress.startedAt,
      cancelRequested: message.cancelRequested === true
    });
    if (running) {
      startStallWatchdog();
      return;
    }
    endRemoteTracking();
    setStatus(
      message.status === "done" ? progress.countText : progress.title,
      message.status === "done" ? "ready" : "error"
    );
  }

  async function startDedicatedPreparation() {
    if (!isSubmissionView()) {
      setStatus("提出物を個別に開いてから一括準備を開始してください。", "error");
      return;
    }
    if (state.remotePreparing || state.preparing) {
      setPreparationProgress({ remote: true });
      return;
    }
    state.remotePreparing = true;
    updateUiLabels();
    setPreparationProgress({
      remote: true,
      phase: "running",
      title: "提出物の一括準備",
      countText: "準備専用タブを起動中…",
      detailText: "Classroomをもう1枚開き、先頭の提出者から順に準備します。",
      done: 0,
      skipped: 0,
      current: 0,
      startedAt: Date.now(),
      cancelRequested: false
    });
    startStallWatchdog();
    try {
      const response = await chrome.runtime.sendMessage({ type: "cwr-start-bulk-preparation" });
      if (!response?.ok) throw new Error(response?.error || "準備専用タブを開始できませんでした。");
      updatePreparation(
        response.alreadyRunning ? "準備専用タブで処理中" : "準備専用タブを起動しました",
        response.alreadyRunning
          ? "すでに実行中の一括準備を続けています。"
          : "準備専用タブが前面になります。採点タブに戻っても準備は続きます。"
      );
    } catch (error) {
      endRemoteTracking();
      finishPreparation(
        "一括準備を開始できませんでした",
        "準備は始まっていません",
        error.message || "エラーが発生しました。もう一度お試しください。",
        "error"
      );
    }
  }

  function becomePreparationTab() {
    if (state.isPreparationTab) return;
    state.isPreparationTab = true;
    state.auto = false;
    removeOverlay();
    state.ui?.remove();
    state.ui = null;
  }

  // "moved"（次の提出者へ進んだ）、"end"（もう先がない）、"missing"（ボタンが
  // 見つからない）、"stuck"（押したのに画面が変わらない）を区別する。
  // 区別しないと、背面タブで画面が止まっただけなのに「全員分の準備が完了」と
  // 誤って報告してしまう。
  async function moveSubmission(direction) {
    const button = await waitForSubmissionButton(direction);
    // 「押せない状態で見つかった」なら本当に端。「見つからない」だけのときは、
    // 背面で止まっているか描き直し中の可能性があるので端と決めつけない。
    if (!button) return document.hidden ? "stuck" : "missing";
    if (submissionButtonDisabled(button)) return "end";
    const before = getSubmissionKey();
    button.click();
    if (!await waitForSubmissionChange(before)) return "stuck";
    await wait(direction === "next" ? 650 : 180);
    return "moved";
  }

  // Chromeは背面のタブの描画を止めるため、Classroomの画面が更新されなくなる
  // ことがある。中断せずに前面へ戻るのを待ち、続きから自動で再開する。
  async function waitForVisibleTab(timeoutMs = 600000) {
    if (!document.hidden) return true;
    setPreparationProgress({
      stalled: true,
      detailText: "Chromeが背面のタブを止めています。準備タブを前面に表示すると、続きから自動で再開します。"
    });
    const startedAt = Date.now();
    while (document.hidden && Date.now() - startedAt < timeoutMs) {
      await wait(1000);
    }
    const visible = !document.hidden;
    setPreparationProgress({
      stalled: false,
      detailText: visible ? "画面の更新を確認しました。準備を再開します。" : "画面が更新されないまま10分が過ぎました。"
    });
    return visible;
  }

  // 呼び出し側へは "moved" / "end" / "stuck" だけを返す。
  async function moveWithRecovery(direction) {
    const result = await moveSubmission(direction);
    if (result === "moved" || result === "end") return result;

    if (result === "missing") {
      // 反対向きのボタンがあれば画面は生きている＝先頭または末尾。
      // どちらも無いときだけ描き直し中とみなし、もう一度だけ長めに待つ。
      if (findSubmissionButton(direction === "next" ? "previous" : "next")) return "end";
      if (!await waitForSubmissionButton(direction, 10000)) return "end";
    } else {
      if (!await waitForVisibleTab()) return "stuck";
      await wait(1200);
    }

    const retried = await moveSubmission(direction);
    return retried === "moved" ? "moved" : retried === "stuck" ? "stuck" : "end";
  }

  // 実行中は内訳を分けず「未準備」でまとめ、終了時の要約で対象外と失敗を分ける。
  function preparationCountText(done, notReady, current) {
    const base = done ? `${done}件を準備しました` : "準備中…";
    const currentPart = current ? `（${current}人目を処理中）` : "";
    const notReadyPart = notReady ? `・未準備 ${notReady}件` : "";
    return `${base}${notReadyPart}${currentPart}`;
  }

  async function prepareAllSubmissions({ dedicated = false } = {}) {
    if (state.preparing) return;
    if (!await waitForSubmissionView()) {
      throw new Error("提出物を個別に開いてから一括準備を開始してください。");
    }
    state.preparing = true;
    state.dedicatedPreparation = dedicated;
    state.prepareCancelled = false;
    state.busy = false;
    removeOverlay();
    setPreparationProgress({
      phase: "running",
      remote: false,
      title: "提出物の一括準備",
      countText: "準備を開始しています…",
      detailText: "先頭の提出者を確認中です。",
      done: 0,
      skipped: 0,
      current: 0,
      startedAt: Date.now(),
      stalled: false,
      cancelRequested: false
    });
    startProgressTicker();

    let preparedCount = 0;
    let cachedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let forwardMoves = 0;
    const failedNames = [];
    const seen = new Set();
    const preparedDocumentKeys = new Set();

    try {
      updatePreparation("先頭の提出者へ移動中…", "提出者リストの最初まで戻っています。");
      for (let attempts = 0; attempts < 1000 && !state.prepareCancelled; attempts += 1) {
        if (await moveWithRecovery("previous") !== "moved") break;
        updatePreparation("先頭の提出者へ移動中…", `${attempts + 1}人分戻りました。`);
      }

      updatePreparation("最初の提出物を確認中…", "Classroomのファイルプレビューを待っています。");
      const initialFileInfo = await waitForSubmissionFile(20000);
      const initialNavigation = findNextSubmissionButton() || findPreviousSubmissionButton();
      if (!initialFileInfo && !initialNavigation) {
        throw new Error("Classroomの提出者画面を読み込めませんでした。準備専用タブで提出物が表示されているか確認してください。");
      }

      while (!state.prepareCancelled) {
        const sequence = seen.size + 1;
        setPreparationProgress({
          current: sequence,
          countText: preparationCountText(preparedCount + cachedCount, skippedCount + failedCount, sequence),
          detailText: `${sequence}人目の提出物を読み取っています。`
        });
        // 提出物の名前が出そろってから鍵を作る。先に作ると読み込み途中の
        // 名前で保存され、採点時に準備済みPDFを見つけられなくなる。
        let fileInfo = sequence === 1 && initialFileInfo
          ? initialFileInfo
          : await waitForSubmissionFile(15000);
        if (!fileInfo && document.hidden && await waitForVisibleTab()) {
          fileInfo = await waitForSubmissionFile(15000);
        }
        const submissionKey = getSubmissionKey();
        if (!submissionKey || seen.has(submissionKey)) break;
        seen.add(submissionKey);

        // 1人が複数ファイルを出していることがあるので、全部まとめて準備する。
        const files = fileInfo && !fileInfo.unsupported ? listSubmissionFiles(fileInfo) : [];
        if (files.length) {
          for (const [fileIndex, file] of files.entries()) {
            if (state.prepareCancelled) break;
            const fileName = file.fileName;
            const ofFiles = files.length > 1 ? `（${fileIndex + 1}/${files.length}件目）` : "";
            setPreparationProgress({
              countText: preparationCountText(preparedCount + cachedCount, skippedCount + failedCount, sequence),
              detailText: `${fileName}${ofFiles} を取得してPDFに変換しています。`,
              fileName
            });
            let response = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              response = await chrome.runtime.sendMessage({
                // 1件目は表示中のファイルなので、画面と突き合わせる確実な経路を使う。
                // 2件目以降は画面に出ていないため、ファイル番号を直接指定して取得する。
                type: fileIndex === 0 ? "cwr-prepare-one" : "cwr-prepare-attachment",
                submissionKey,
                primary: fileIndex === 0,
                fileName,
                expectedName: file.expectedName || "",
                expectedFileId: file.expectedFileId || "",
                expectedGoogleType: file.expectedGoogleType || ""
              });
              // 画面と突き合わせる1件目だけ、前の提出者と同じ結果なら画面更新待ちとみなす。
              const repeatedDocument = fileIndex === 0 && response?.ok && preparedDocumentKeys.has(response.documentKey);
              if ((response?.ok && !repeatedDocument) || attempt === 2) break;
              response = repeatedDocument ? { ok: false, error: "画面更新を待っています。" } : response;
              await wait(900);
            }
            if (response?.ok) {
              preparedDocumentKeys.add(response.documentKey);
              if (response.cached) cachedCount += 1;
              else preparedCount += 1;
            } else {
              if (/補助アプリ|Start-Reviewer|古い版|起動していません/.test(response?.error || "")) {
                throw new Error(response.error);
              }
              failedCount += 1;
              failedNames.push(fileName);
            }
          }
        } else {
          skippedCount += 1;
        }

        setPreparationProgress({
          done: preparedCount + cachedCount,
          skipped: skippedCount + failedCount,
          countText: preparationCountText(preparedCount + cachedCount, skippedCount + failedCount, sequence),
          detailText: "次の提出者へ移動しています。"
        });
        if (state.prepareCancelled) break;
        const moved = await moveWithRecovery("next");
        if (moved === "stuck") {
          throw new Error("Classroomの画面が更新されなくなったため、途中で停止しました。準備専用タブを前面にしてから、もう一度「全員分を一括準備」を押すと続きから準備します。");
        }
        if (moved === "end") break;
        forwardMoves += 1;
      }

      if (!dedicated) {
        // 採点タブで直接実行した場合だけ、見ていた提出者の位置へ戻す。
        updatePreparation("先頭へ戻しています…", "準備したPDFはこのPC内に保持されています。");
        for (let index = 0; index < forwardMoves; index += 1) {
          if (await moveWithRecovery("previous") !== "moved") break;
        }
      }

      const total = preparedCount + cachedCount;
      const notReady = skippedCount + failedCount;
      const summary = [
        `${total}件を準備しました`,
        skippedCount ? `対象外 ${skippedCount}件` : "",
        failedCount ? `準備できず ${failedCount}件` : ""
      ].filter(Boolean).join("・");
      const failedNote = failedCount
        ? `準備できなかった提出物：${failedNames.slice(0, 3).join("、")}${failedCount > 3 ? " ほか" : ""}。採点画面で個別に「表示」を押すと再試行します。`
        : "";
      finishPreparation(
        state.prepareCancelled ? "一括準備を中止しました" : "提出物の準備が完了しました",
        summary,
        total
          ? failedNote || "変換した表示用PDFは、このPC内に24時間保持します。"
          : notReady
            ? `準備できるWord／PowerPoint／Google形式の提出物がありませんでした。${failedNote}`
            : "提出者を読み取れませんでした。Classroomの採点画面で提出物を1件開いてから、もう一度お試しください。",
        state.prepareCancelled ? "cancelled" : "done"
      );
      setStatus(`${total}件の提出物を準備済み`, total ? "ready" : "idle");
    } catch (error) {
      finishPreparation(
        "一括準備を中断しました",
        `${preparedCount + cachedCount}件まで準備できました`,
        error.message || "処理中にエラーが発生しました。",
        "error"
      );
      setStatus(error.message || "一括準備に失敗しました。", "error");
    } finally {
      stopProgressTicker();
      state.preparing = false;
      state.prepareCancelled = false;
      state.dedicatedPreparation = false;
      updateUiLabels();
    }
  }

  function isPowerPoint(fileName = findOfficeFileName()) {
    return /\.pptx?$/i.test(fileName);
  }

  function updateUiLabels() {
    const root = state.ui;
    if (!root) return;
    const submissionView = isSubmissionView();
    const fileInfo = submissionView ? findSupportedFileInfo() : null;
    const googleDocument = fileInfo?.kind === "google-document";
    const googlePresentation = fileInfo?.kind === "google-presentation";
    const powerpoint = submissionView && isPowerPoint(fileInfo?.fileName || "");
    const openButton = root.querySelector("#cwr-open");
    const officeButton = root.querySelector("#cwr-open-window");
    const prepareButton = root.querySelector("#cwr-prepare");
    const autoInput = root.querySelector("#cwr-auto");
    if (!submissionView) {
      openButton.textContent = "提出物を開くと表示できます";
      officeButton.textContent = "提出物を開くと操作できます";
      openButton.disabled = true;
      officeButton.disabled = true;
      prepareButton.disabled = true;
      autoInput.disabled = true;
      return;
    }
    openButton.textContent = googleDocument
      ? "Googleドキュメントを表示"
      : googlePresentation
        ? "Googleスライドを表示"
        : powerpoint
          ? "PowerPointを正確に表示"
          : "Wordで正確に表示";
    officeButton.textContent = googleDocument || googlePresentation
      ? "Google形式はPDF表示のみ"
      : powerpoint
        ? "PowerPointで発表"
        : "Word別窓で表示";
    openButton.disabled = !fileInfo;
    officeButton.disabled = !fileInfo || googleDocument || googlePresentation;
    const busyPreparing = state.remotePreparing || state.preparing;
    prepareButton.textContent = busyPreparing ? "一括準備を実行中…" : "全員分を一括準備";
    prepareButton.disabled = busyPreparing;
    autoInput.disabled = false;
  }

  function makeUi() {
    // 準備専用タブでは自動操作の邪魔になるため、採点用の操作パネルは出さない。
    if (state.isPreparationTab && !isPreparationFinished()) return;
    if (document.getElementById("cwr-controls")) return;
    const root = document.createElement("section");
    root.id = "cwr-controls";
    root.setAttribute("aria-label", "Classroom Office Reviewer");
    root.innerHTML = `
      <button id="cwr-open" type="button">Wordで正確に表示</button>
      <button id="cwr-open-window" type="button">Word別窓で表示</button>
      <button id="cwr-prepare" type="button">全員分を一括準備</button>
      <label id="cwr-auto-label">
        <input id="cwr-auto" type="checkbox">
        次の提出物を自動表示
      </label>
      <button id="cwr-toggle" type="button">機能OFF</button>
      <span id="cwr-status" role="status">待機中</span>
    `;
    document.body.appendChild(root);
    state.ui = root;

    root.querySelector("#cwr-open").addEventListener("click", () => {
      state.mode = "pdf";
      chrome.storage.local.set({ cwrMode: state.mode });
      chrome.runtime.sendMessage({ type: "cwr-close-office" }).catch(() => undefined);
      startConversion(false);
    });
    root.querySelector("#cwr-open-window").addEventListener("click", () => {
      state.mode = "office";
      chrome.storage.local.set({ cwrMode: state.mode });
      removeOverlay();
      startOfficeWindow(false);
    });
    root.querySelector("#cwr-prepare").addEventListener("click", startDedicatedPreparation);
    root.querySelector("#cwr-auto").addEventListener("change", (event) => {
      state.auto = event.target.checked;
      chrome.storage.local.set({ cwrAuto: state.auto });
      setStatus(state.auto ? "自動表示オン" : "自動表示オフ", "idle");
    });
    root.querySelector("#cwr-toggle").addEventListener("click", () => setEnabled(!state.enabled));
    updateUiLabels();
    chrome.storage.local.get(["cwrAuto", "cwrMode", "cwrEnabled"]).then(({ cwrAuto, cwrMode, cwrEnabled }) => {
      state.auto = state.isPreparationTab ? false : Boolean(cwrAuto);
      state.mode = ["word", "office"].includes(cwrMode) ? "office" : "pdf";
      state.enabled = cwrEnabled !== false;
      root.querySelector("#cwr-auto").checked = state.auto;
      applyEnabledUi();
    });
  }

  function applyEnabledUi() {
    if (!state.ui) return;
    state.ui.classList.toggle("cwr-disabled", !state.enabled);
    const toggle = state.ui.querySelector("#cwr-toggle");
    toggle.textContent = state.enabled ? "機能OFF" : "提出物表示をON";
    toggle.setAttribute("aria-pressed", String(state.enabled));
  }

  function setEnabled(value, persist = true) {
    state.enabled = Boolean(value);
    if (persist) chrome.storage.local.set({ cwrEnabled: state.enabled });
    if (!state.enabled) {
      state.busy = false;
      removeOverlay();
      chrome.runtime.sendMessage({ type: "cwr-close-office" }).catch(() => undefined);
    }
    applyEnabledUi();
    setStatus(state.enabled ? "機能をオンにしました。" : "機能停止中", "idle");
  }

  function setStatus(text, kind = "idle") {
    state.viewerStatus = { text, kind };
    const status = document.getElementById("cwr-status");
    if (status) {
      status.textContent = text;
      status.dataset.kind = kind;
    }
    if (state.preparing && !isPreparationFinished()) setPreparationProgress({ detailText: text });
    state.overlay?.querySelector("iframe")?.contentWindow?.postMessage({ type: "cwr-viewer-status", text, kind }, "*");
  }

  async function startConversion(isAutomatic) {
    if (!state.enabled || state.busy) return;
    if (!isSubmissionView()) {
      if (!isAutomatic) setStatus("提出物を個別に開いてから操作してください。", "error");
      return;
    }
    const fileInfo = findSupportedFileInfo();
    if (!fileInfo) {
      if (!isAutomatic) setStatus("表示中のWord／PowerPoint／Google形式のファイルが見つかりません。", "error");
      return;
    }

    state.busy = true;
    const key = getSubmissionKey();
    setActiveFile(fileInfo);
    setStatus("提出物を取得中…", "working");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "cwr-start",
        submissionKey: key,
        expectedName: fileInfo.expectedName || "",
        expectedFileId: fileInfo.expectedFileId || "",
        expectedGoogleType: fileInfo.expectedGoogleType || ""
      });
      if (!response?.ok) throw new Error(response?.error || "処理を開始できませんでした。");
      if (!response.completed) {
        setStatus(`${response.fileName} を一時取得中…`, "working");
      }
    } catch (error) {
      state.busy = false;
      setStatus(error.message || "処理を開始できませんでした。", "error");
    }
  }

  async function startOfficeWindow(isAutomatic) {
    if (!state.enabled || state.busy) return;
    if (!isSubmissionView()) {
      if (!isAutomatic) setStatus("提出物を個別に開いてから操作してください。", "error");
      return;
    }
    const fileInfo = findSupportedFileInfo();
    const fileName = fileInfo?.fileName || "";
    if (!fileInfo || fileInfo.kind !== "office" || !/\.(?:docx?|pptx?)$/i.test(fileName)) {
      if (!isAutomatic) setStatus("表示中のWord／PowerPointファイルが見つかりません。", "error");
      return;
    }

    state.busy = true;
    const key = getSubmissionKey();
    setStatus(isPowerPoint(fileName) ? "PowerPoint発表画面を準備中…" : "Word別ウィンドウを準備中…", "working");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "cwr-open-office",
        submissionKey: key,
        expectedName: fileInfo.expectedName || "",
        expectedFileId: fileInfo.expectedFileId || ""
      });
      if (!response?.ok) throw new Error(response?.error || "別ウィンドウを開けませんでした。");
      state.busy = false;
      setStatus(isPowerPoint(response.fileName) ? `${response.fileName} を発表中` : `${response.fileName} をWord別窓で表示中`, "ready");
    } catch (error) {
      state.busy = false;
      setStatus(error.message || "別ウィンドウを開けませんでした。", "error");
    }
  }

  // 画面の端から表示枠までの余白（px）。上端と右端だけを持ち、左下は常に画面の角。
  function clampBounds(bounds) {
    const maxTop = Math.max(0, window.innerHeight - 220);
    const maxRight = Math.max(0, window.innerWidth - 360);
    return {
      top: Math.min(Math.max(0, Math.round(bounds.top)), maxTop),
      right: Math.min(Math.max(0, Math.round(bounds.right)), maxRight)
    };
  }

  // 自動計算 → 幅いっぱい設定 → 手動で変えた大きさ、の順に上書きする。
  function findPreviewBounds() {
    const automatic = detectPreviewBounds();
    const base = state.wide ? { top: automatic.top, right: 0 } : automatic;
    return clampBounds({
      top: Number.isFinite(state.overlayBounds?.top) ? state.overlayBounds.top : base.top,
      right: Number.isFinite(state.overlayBounds?.right) ? state.overlayBounds.right : base.right
    });
  }

  function applyOverlayBounds() {
    const bounds = findPreviewBounds();
    for (const element of [state.overlay, state.pendingOverlay]) {
      if (!element) continue;
      element.style.top = `${bounds.top}px`;
      element.style.right = `${bounds.right}px`;
    }
  }

  function saveOverlayBounds() {
    chrome.storage.local.set({ cwrOverlayBounds: state.overlayBounds || null }).catch(() => undefined);
  }

  function setWideLayout(value) {
    state.wide = Boolean(value);
    // 幅の指定が残っていると「幅いっぱい」が効かないので、横方向だけ手動値を捨てる。
    if (state.overlayBounds) delete state.overlayBounds.right;
    chrome.storage.local.set({ cwrWide: state.wide }).catch(() => undefined);
    saveOverlayBounds();
    applyOverlayBounds();
    sendViewerControls();
  }

  function resetOverlayBounds() {
    state.overlayBounds = null;
    saveOverlayBounds();
    applyOverlayBounds();
    sendViewerControls();
    setStatus("表示の大きさを自動に戻しました。", "idle");
  }

  // 表示枠の上辺・右辺・角をつまんで、好きな大きさにできるようにする。
  function attachResizeHandles(overlay) {
    for (const handle of overlay.querySelectorAll(".cwr-resize")) {
      handle.addEventListener("dblclick", resetOverlayBounds);
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const edge = handle.dataset.edge;
        handle.setPointerCapture(event.pointerId);
        overlay.classList.add("cwr-resizing");

        const move = (moveEvent) => {
          const next = { ...findPreviewBounds() };
          if (edge !== "right") next.top = moveEvent.clientY;
          if (edge !== "top") next.right = window.innerWidth - moveEvent.clientX;
          state.overlayBounds = clampBounds(next);
          applyOverlayBounds();
        };
        const stop = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", stop);
          handle.removeEventListener("pointercancel", stop);
          overlay.classList.remove("cwr-resizing");
          saveOverlayBounds();
          sendViewerControls();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
      });
    }
  }

  function setActiveFile(file) {
    state.activeFile = file ? { id: file.expectedFileId || "", name: file.fileName || "" } : null;
  }

  function activeFileIndex(files) {
    if (!state.activeFile) return 0;
    return files.findIndex((file) => (state.activeFile.id && file.expectedFileId === state.activeFile.id)
      || (!state.activeFile.id && file.fileName === state.activeFile.name));
  }

  function sendViewerControls() {
    const frame = state.overlay?.querySelector("iframe");
    if (!frame) return;
    const previousButton = findSubmissionButton("previous");
    const nextButton = findSubmissionButton("next");
    const files = isSubmissionView() ? listSubmissionFiles() : [];
    frame.contentWindow?.postMessage({
      type: "cwr-viewer-controls",
      previous: Boolean(previousButton) && !submissionButtonDisabled(previousButton),
      next: Boolean(nextButton) && !submissionButtonDisabled(nextButton),
      wide: state.wide,
      files: files.map((file) => ({ name: file.fileName })),
      activeIndex: activeFileIndex(files)
    }, "*");
  }

  // 同じ提出者の2件目以降を表示する。画面に出ていないファイルは
  // Drive上のファイル番号から直接取得する。
  async function showSubmissionFile(index) {
    if (!state.enabled || state.busy) return;
    const files = listSubmissionFiles();
    const file = files[index];
    if (!file) {
      setStatus("選んだファイルが見つかりませんでした。Classroomを再読み込みしてください。", "error");
      return;
    }
    if (index === 0) {
      startConversion(false);
      return;
    }
    state.busy = true;
    setActiveFile(file);
    setStatus(`${file.fileName} を取得中…`, "working");
    sendViewerControls();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "cwr-open-attachment",
        submissionKey: getSubmissionKey(),
        primary: false,
        fileName: file.fileName,
        expectedName: file.expectedName || "",
        expectedFileId: file.expectedFileId || "",
        expectedGoogleType: file.expectedGoogleType || ""
      });
      if (!response?.ok) throw new Error(response?.error || "このファイルを表示できませんでした。");
    } catch (error) {
      state.busy = false;
      setStatus(error.message || "このファイルを表示できませんでした。", "error");
    }
  }

  async function moveToAdjacentSubmission(direction) {
    if (!state.enabled) return;
    const button = findSubmissionButton(direction);
    if (!button || submissionButtonDisabled(button)) {
      setStatus(direction === "next" ? "最後の提出者です。" : "最初の提出者です。", "idle");
      return;
    }
    const before = getSubmissionKey();
    setStatus(direction === "next" ? "次の提出者へ移動しています…" : "前の提出者へ移動しています…", "working");
    button.click();
    if (!await waitForSubmissionChange(before, 8000)) {
      setStatus("提出者を切り替えられませんでした。Classroomを再読み込みしてください。", "error");
      return;
    }
    await waitForSubmissionFile(5000);
    sendViewerControls();
    startConversion(false);
  }

  function detectPreviewBounds() {
    const fallback = {
      // Keep the Classroom navigation visible, but use nearly the whole remaining
      // screen. This makes the normal view suitable for a classroom projector.
      top: Math.max(92, Math.round(window.innerHeight * 0.12)),
      right: 12
    };
    const filename = findOfficeFileName();
    let toolbarTop = Number.POSITIVE_INFINITY;
    let sidebarLeft = 0;
    for (const element of document.querySelectorAll("div, aside, section")) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      const value = textOf(element);
      if (rect.right < window.innerWidth - 5 || rect.height < window.innerHeight * 0.45) continue;
      if (rect.width < 240 || rect.width > 520 || !/(成績|Grade)/.test(value)) continue;
      sidebarLeft = Math.max(sidebarLeft, rect.left);
    }
    const previewRight = sidebarLeft > window.innerWidth * 0.55
      ? Math.round(window.innerWidth - sidebarLeft)
      : fallback.right;

    const topToolbar = [...document.querySelectorAll("div, header, section")]
      .filter((element) => element.id !== "cwr-overlay" && !element.closest("#cwr-overlay"))
      .map((element) => ({ rect: element.getBoundingClientRect(), background: getComputedStyle(element).backgroundColor }))
      .find(({ rect, background }) => rect.left <= 4
        && rect.top <= 8
        && rect.width >= window.innerWidth * 0.45
        && rect.height >= 38
        && rect.height <= 100
        && /rgb\((?:1[5-9]|2[0-9]|3[0-9]),\s*(?:1[5-9]|2[0-9]|3[0-9]),\s*(?:1[5-9]|2[0-9]|3[0-9])\)/.test(background));
    if (topToolbar) return { top: 0, right: previewRight };

    // Google Classroom's own file preview is a dark, wide panel. Replacing that
    // panel keeps one document area instead of stacking two viewers vertically.
    const previewPanel = [...document.querySelectorAll("div, section")]
      .filter((element) => element.id !== "cwr-overlay" && !element.closest("#cwr-overlay"))
      .map((element) => ({
        element,
        rect: element.getBoundingClientRect(),
        background: getComputedStyle(element).backgroundColor
      }))
      .filter(({ rect, background }) => rect.left <= 4
        && rect.top >= 80
        && rect.width >= window.innerWidth * 0.45
        && rect.height >= window.innerHeight * 0.45
        && /rgb\((?:1[5-9]|2[0-9]|3[0-9]),\s*(?:1[5-9]|2[0-9]|3[0-9]),\s*(?:1[5-9]|2[0-9]|3[0-9])\)/.test(background))
      .sort((a, b) => a.rect.top - b.rect.top)[0];

    if (previewPanel) {
      return {
        top: Math.round(previewPanel.rect.top),
        right: previewRight
      };
    }

    if (filename) {
      const elements = [...document.querySelectorAll("div, header, section")];
      for (const element of elements) {
        if (!visible(element) || !textOf(element).includes(filename)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width > window.innerWidth * 0.45 && rect.height >= 45 && rect.height <= 130) {
          toolbarTop = Math.min(toolbarTop, rect.top);
        }
      }
    }

    return {
      top: Number.isFinite(toolbarTop) && toolbarTop > 120 ? Math.round(toolbarTop) : fallback.top,
      right: previewRight
    };
  }

  function removeOverlay() {
    state.pendingOverlay?.remove();
    state.pendingOverlay = null;
    state.overlay?.remove();
    state.overlay = null;
    state.displayedPdfUrl = "";
    state.ui?.classList.remove("cwr-hidden");
  }

  function renderPdf(pdfUrl, fileName, pageCount) {
    state.pendingOverlay?.remove();
    state.pendingOverlay = null;

    const existingIframe = state.overlay?.querySelector("iframe");
    if (existingIframe && document.body.contains(state.overlay)) {
      const previousPdfUrl = state.displayedPdfUrl;
      state.displayedPdfUrl = pdfUrl;
      existingIframe.title = `${fileName || "Office提出物"} の高忠実度プレビュー`;
      existingIframe.contentWindow?.postMessage({
        type: "cwr-load-pdf",
        pdfUrl,
        fileName: fileName || "Office提出物",
        pageCount: pageCount || null
      }, "*");
      const viewerStatus = state.viewerStatus;
      if (viewerStatus) existingIframe.contentWindow?.postMessage({ type: "cwr-viewer-status", ...viewerStatus }, "*");
      const bounds = findPreviewBounds();
      state.overlay.style.top = `${bounds.top}px`;
      state.overlay.style.right = `${bounds.right}px`;
      sendViewerControls();
      if (previousPdfUrl && previousPdfUrl !== pdfUrl) {
        chrome.runtime.sendMessage({ type: "cwr-release-pdf", pdfUrl: previousPdfUrl }).catch(() => undefined);
      }
      return;
    }

    const previousOverlay = state.overlay;
    const previousPdfUrl = state.displayedPdfUrl;
    const bounds = findPreviewBounds();
    const overlay = document.createElement("div");
    overlay.id = "cwr-overlay";
    overlay.style.top = `${bounds.top}px`;
    overlay.style.right = `${bounds.right}px`;

    const viewerUrl = new URL(chrome.runtime.getURL("viewer.html"));
    viewerUrl.searchParams.set("pdf", pdfUrl);
    viewerUrl.searchParams.set("name", fileName || "Office提出物");
    if (pageCount) viewerUrl.searchParams.set("pages", String(pageCount));

    const iframe = document.createElement("iframe");
    iframe.src = viewerUrl.href;
    iframe.title = `${fileName || "Office提出物"} の高忠実度プレビュー`;
    iframe.allow = "fullscreen";
    iframe.addEventListener("load", () => {
      const viewerStatus = state.viewerStatus;
      if (viewerStatus) iframe.contentWindow?.postMessage({ type: "cwr-viewer-status", ...viewerStatus }, "*");
      sendViewerControls();
    });
    overlay.appendChild(iframe);
    overlay.insertAdjacentHTML("beforeend", `
      <div class="cwr-resize cwr-resize-top" data-edge="top" title="上下の大きさを変更（ダブルクリックで自動に戻す）"></div>
      <div class="cwr-resize cwr-resize-right" data-edge="right" title="左右の大きさを変更（ダブルクリックで自動に戻す）"></div>
      <div class="cwr-resize cwr-resize-corner" data-edge="corner" title="大きさを変更（ダブルクリックで自動に戻す）"></div>
    `);
    attachResizeHandles(overlay);
    if (previousOverlay) overlay.style.visibility = "hidden";
    document.body.appendChild(overlay);
    state.ui?.classList.add("cwr-hidden");

    if (!previousOverlay) {
      state.overlay = overlay;
      state.displayedPdfUrl = pdfUrl;
    } else {
      state.pendingOverlay = overlay;
      const activate = (event) => {
        if (event.source !== iframe.contentWindow || !new Set(["cwr-viewer-ready", "cwr-viewer-error"]).has(event.data?.type)) return;
        window.removeEventListener("message", activate);
        if (state.pendingOverlay !== overlay) {
          overlay.remove();
          return;
        }
        previousOverlay.remove();
        overlay.style.visibility = "visible";
        state.pendingOverlay = null;
        state.overlay = overlay;
        state.displayedPdfUrl = pdfUrl;
        if (previousPdfUrl && previousPdfUrl !== pdfUrl) {
          chrome.runtime.sendMessage({ type: "cwr-release-pdf", pdfUrl: previousPdfUrl }).catch(() => undefined);
        }
      };
      window.addEventListener("message", activate);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "cwr-close") {
      removeOverlay();
      setStatus("プレビューを閉じました。", "idle");
    }
    if (event.data?.type === "cwr-disable") setEnabled(false);
    if (event.data?.type === "cwr-prepare-all") startDedicatedPreparation();
    if (event.data?.type === "cwr-navigate") moveToAdjacentSubmission(event.data.direction === "previous" ? "previous" : "next");
    if (event.data?.type === "cwr-toggle-wide") setWideLayout(!state.wide);
    if (event.data?.type === "cwr-reset-size") resetOverlayBounds();
    if (event.data?.type === "cwr-show-file") showSubmissionFile(Number(event.data.index) || 0);
  });

  function handlePossibleSubmissionChange() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      // 準備専用タブは自動操作中なので、採点用の表示処理は動かさない。
      if (state.isPreparationTab && state.preparing) return;
      makeUi();
      const submissionView = isSubmissionView();
      if (!submissionView) {
        const changedFromSubmission = state.submissionView;
        state.submissionView = false;
        state.currentKey = "";
        state.busy = false;
        if (changedFromSubmission) {
          removeOverlay();
          updateUiLabels();
          setStatus("提出物を開くと操作できます。", "idle");
        }
        return;
      }
      const enteredSubmission = !state.submissionView;
      state.submissionView = true;
      if (enteredSubmission) updateUiLabels();
      const key = getSubmissionKey();
      if (!key || key === state.currentKey) return;
      const hadPrevious = Boolean(state.currentKey);
      state.currentKey = key;
      state.busy = false;
      state.activeFile = null;
      if (state.preparing) return;
      sendViewerControls();
      if (hadPrevious) {
        // Do not blank the projector while Office is converting the next file.
        // The previous PDF remains visible until the replacement is ready.
        setStatus(state.overlay
          ? "次の提出物へ切り替えています。表示は切替まで維持します。"
          : "提出者が切り替わりました。", "idle");
      }
      if (state.enabled && hadPrevious && state.auto && isSubmissionView() && findSupportedFileInfo()) {
        setTimeout(() => {
          if (state.mode === "office" && findSupportedFileInfo()?.kind === "office") startOfficeWindow(true);
          else startConversion(true);
        }, 120);
      }
    }, 200);
  }

  // 拡張機能を再読み込みしても、このタブが準備専用タブかどうかを取り戻す。
  chrome.runtime.sendMessage({ type: "cwr-preparation-role" }).then((response) => {
    if (response?.role === "preparation" && !response.interrupted) becomePreparationTab();
    if (response?.role === "source" && response.progress) handleRemotePreparationProgress(response.progress);
  }, () => undefined);
  chrome.storage.local.get(["cwrPreparationCompact", "cwrWide", "cwrOverlayBounds"]).then((stored) => {
    state.preparationCompact = Boolean(stored.cwrPreparationCompact);
    state.wide = Boolean(stored.cwrWide);
    state.overlayBounds = stored.cwrOverlayBounds || null;
    renderPreparation();
    if (state.overlay) applyOverlayBounds();
  }, () => undefined);

  makeUi();
  state.submissionView = isSubmissionView();
  state.currentKey = state.submissionView ? getSubmissionKey() : "";
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.cwrEnabled) {
      const enabled = changes.cwrEnabled.newValue !== false;
      if (enabled !== state.enabled) setEnabled(enabled, false);
    }
  });
  new MutationObserver(handlePossibleSubmissionChange).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
  window.addEventListener("resize", () => {
    if (state.overlay) applyOverlayBounds();
  });
  window.addEventListener("unload", () => {
    if (state.mode === "office") {
      chrome.runtime.sendMessage({ type: "cwr-close-office" }).catch(() => undefined);
    }
  });
})();
