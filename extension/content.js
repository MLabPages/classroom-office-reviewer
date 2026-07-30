(() => {
  const isClassroomTop = location.hostname === "classroom.google.com" && window === window.top;
  const state = {
    enabled: true,
    busy: false,
    auto: false,
    preparing: false,
    remotePreparing: false,
    dedicatedPreparation: false,
    prepareCancelled: false,
    mode: "pdf",
    currentKey: "",
    convertedKey: "",
    displayedPdfUrl: "",
    viewerStatus: null,
    timer: null,
    preparationTimer: null,
    ui: null,
    overlay: null,
    pendingOverlay: null
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

  function findOfficeFileName() {
    const nodes = document.querySelectorAll("a, button, [role='button'], [aria-label], [title], [data-tooltip], span");
    for (const node of nodes) {
      if (!visible(node)) continue;
      const sources = [
        textOf(node),
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.getAttribute("data-tooltip")
      ];
      for (const source of sources) {
        if (!source || source.length > 220) continue;
        const match = source?.match(/([^\\/:*?\"<>|\r\n]{1,160}\.(?:docx?|pptx?))(?:\s|$)/i);
        if (match) return match[1].trim();
      }
    }
    return "";
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
      fileName: findOfficeFileName(),
      fileId,
      downloadUrl,
      authuser: authMatch ? Number(authMatch[1]) : null,
      frameUrl: location.href
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "cwr-describe-document") {
      sendResponse(describeDocument());
      return false;
    }
    if (!isClassroomTop) return false;

    if (message?.type === "cwr-run-preparation") {
      if (state.preparing) {
        sendResponse({ ok: false });
        return false;
      }
      sendResponse({ ok: true });
      setTimeout(() => prepareAllSubmissions({ dedicated: true }), 0);
      return false;
    }

    if (message?.type === "cwr-cancel-preparation") {
      state.prepareCancelled = true;
      updatePreparation(null, "現在の1件が終わったら中止します。");
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
    const elements = document.querySelectorAll("button, [role='button'], [aria-label], div");
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
    return [location.href, getStudentLabel(), findOfficeFileName()].join("|");
  }

  function findSubmissionButton(direction) {
    const labelPattern = direction === "next"
      ? /次の(?:提出者|生徒|学生)|次へ|next(?:\s+(?:student|submission))?/i
      : /前の(?:提出者|生徒|学生)|前へ|previous(?:\s+(?:student|submission))?/i;
    return [...document.querySelectorAll("button, [role='button']")].find((element) => {
      if (!visible(element) || element.getAttribute("aria-disabled") === "true" || element.disabled) return false;
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

  function waitForSubmissionChange(previousKey) {
    return new Promise((resolve) => {
      let checks = 0;
      const timer = setInterval(() => {
        checks += 1;
        if (getSubmissionKey() !== previousKey) {
          clearInterval(timer);
          resolve(true);
        } else if (checks >= 60) {
          clearInterval(timer);
          resolve(false);
        }
      }, 150);
    });
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function showPreparationPanel() {
    document.getElementById("cwr-preparation")?.remove();
    const noteText = state.remotePreparing
      ? "準備専用タブで処理しています。この採点タブは通常どおり使用できます。"
      : "この準備専用タブは自動で切り替わります。完了まで操作しないでください。";
    const panel = document.createElement("section");
    panel.id = "cwr-preparation";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    panel.innerHTML = `
      <div id="cwr-preparation-card">
        <div id="cwr-preparation-header">
          <div id="cwr-preparation-spinner" aria-hidden="true"></div>
          <h2 id="cwr-preparation-title">提出物の一括準備</h2>
        </div>
        <p id="cwr-preparation-count">準備を開始しています…</p>
        <p id="cwr-preparation-detail">先頭の提出者を確認中です。</p>
        <p id="cwr-preparation-elapsed">経過 0秒</p>
        <p id="cwr-preparation-note">${noteText}</p>
        <button id="cwr-preparation-cancel" type="button">現在の処理後に中止</button>
      </div>
    `;
    panel.querySelector("#cwr-preparation-cancel").addEventListener("click", () => {
      if (state.remotePreparing) {
        chrome.runtime.sendMessage({ type: "cwr-cancel-bulk-preparation" }).catch(() => undefined);
        panel.querySelector("#cwr-preparation-cancel").disabled = true;
        panel.querySelector("#cwr-preparation-detail").textContent = "準備専用タブへ中止を伝えています。";
        return;
      }
      if (!state.preparing) {
        panel.remove();
        return;
      }
      state.prepareCancelled = true;
      panel.querySelector("#cwr-preparation-cancel").disabled = true;
      panel.querySelector("#cwr-preparation-detail").textContent = "現在の1件が終わったら中止します。";
    });
    document.body.appendChild(panel);
    const startedAt = Date.now();
    clearInterval(state.preparationTimer);
    state.preparationTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      const elapsedElement = document.getElementById("cwr-preparation-elapsed");
      if (elapsedElement) elapsedElement.textContent = minutes ? `経過 ${minutes}分${seconds}秒` : `経過 ${seconds}秒`;
    }, 1000);
  }

  function updatePreparation(countText, detailText) {
    const count = document.getElementById("cwr-preparation-count");
    const detail = document.getElementById("cwr-preparation-detail");
    if (count && countText) count.textContent = countText;
    if (detail && detailText) detail.textContent = detailText;
    if (state.dedicatedPreparation) reportPreparationProgress("running");
  }

  function reportPreparationProgress(status, override = {}) {
    if (!state.dedicatedPreparation) return;
    chrome.runtime.sendMessage({
      type: "cwr-prepare-progress",
      progress: {
        status,
        title: override.title || document.getElementById("cwr-preparation-title")?.textContent || "提出物の一括準備",
        countText: override.countText || document.getElementById("cwr-preparation-count")?.textContent || "",
        detailText: override.detailText || document.getElementById("cwr-preparation-detail")?.textContent || ""
      }
    }).catch(() => undefined);
  }

  function finishPreparation(title, countText, detailText, status = "done") {
    const panel = document.getElementById("cwr-preparation");
    if (!panel) return;
    clearInterval(state.preparationTimer);
    state.preparationTimer = null;
    panel.querySelector("#cwr-preparation-spinner")?.remove();
    panel.querySelector("#cwr-preparation-title").textContent = title;
    updatePreparation(countText, detailText);
    const button = panel.querySelector("#cwr-preparation-cancel");
    button.disabled = false;
    button.textContent = "閉じる";
    reportPreparationProgress(status, { title, countText, detailText });
  }

  function handleRemotePreparationProgress(message) {
    const running = !message.status || message.status === "running";
    state.remotePreparing = running;
    if (!document.getElementById("cwr-preparation")) showPreparationPanel();
    const title = document.getElementById("cwr-preparation-title");
    if (title && message.title) title.textContent = message.title;
    if (running) {
      updatePreparation(message.countText, message.detailText);
      return;
    }
    finishPreparation(
      message.title || "一括準備が完了しました",
      message.countText || "",
      message.detailText || "",
      message.status
    );
  }

  async function startDedicatedPreparation() {
    if (state.remotePreparing) return;
    state.remotePreparing = true;
    showPreparationPanel();
    updatePreparation("準備専用タブを起動中…", "この採点タブはそのまま使用できます。");
    try {
      const response = await chrome.runtime.sendMessage({ type: "cwr-start-bulk-preparation" });
      if (!response?.ok) throw new Error(response?.error || "準備専用タブを開始できませんでした。");
      updatePreparation("準備専用タブで処理中", "採点を続けながらお待ちください。");
    } catch (error) {
      state.remotePreparing = false;
      finishPreparation("一括準備を開始できませんでした", "準備は開始されていません", error.message || "エラーが発生しました。", "error");
    }
  }

  async function moveSubmission(direction) {
    const button = direction === "next" ? findNextSubmissionButton() : findPreviousSubmissionButton();
    if (!button) return false;
    const before = getSubmissionKey();
    button.click();
    const changed = await waitForSubmissionChange(before);
    if (changed) await wait(direction === "next" ? 650 : 180);
    return changed;
  }

  async function prepareAllSubmissions({ dedicated = false } = {}) {
    if (state.preparing) return;
    state.preparing = true;
    state.dedicatedPreparation = dedicated;
    state.prepareCancelled = false;
    state.busy = false;
    removeOverlay();
    showPreparationPanel();

    let preparedCount = 0;
    let cachedCount = 0;
    let skippedCount = 0;
    let forwardMoves = 0;
    const seen = new Set();
    const preparedDocumentKeys = new Set();

    try {
      updatePreparation("先頭へ移動中…", "提出者の最初まで戻っています。");
      for (let attempts = 0; attempts < 1000 && !state.prepareCancelled; attempts += 1) {
        if (!await moveSubmission("previous")) break;
      }

      while (!state.prepareCancelled) {
        const submissionKey = getSubmissionKey();
        if (!submissionKey || seen.has(submissionKey)) break;
        seen.add(submissionKey);
        const sequence = seen.size;
        const fileName = findOfficeFileName();

        if (/\.(?:docx?|pptx?)$/i.test(fileName)) {
          updatePreparation(`${sequence}件目を準備中`, `${fileName} を取得・PDF化しています。`);
          let response = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            response = await chrome.runtime.sendMessage({ type: "cwr-prepare-one", submissionKey, expectedName: fileName });
            const repeatedDocument = response?.ok && preparedDocumentKeys.has(response.documentKey);
            if ((response?.ok && !repeatedDocument) || attempt === 2) break;
            response = repeatedDocument ? { ok: false, error: "画面更新を待っています。" } : response;
            await wait(900);
          }
          if (response?.ok) {
            preparedDocumentKeys.add(response.documentKey);
            if (response.cached) cachedCount += 1;
            else preparedCount += 1;
          } else {
            skippedCount += 1;
          }
        } else {
          skippedCount += 1;
        }

        updatePreparation(
          `${preparedCount + cachedCount}件準備済み${skippedCount ? `・${skippedCount}件未準備` : ""}`,
          "次の提出者へ移動しています。"
        );
        if (state.prepareCancelled || !await moveSubmission("next")) break;
        forwardMoves += 1;
      }

      updatePreparation("先頭へ戻しています…", "準備したPDFはこのPC内に保持されています。");
      for (let index = 0; index < forwardMoves; index += 1) {
        if (!await moveSubmission("previous")) break;
      }

      const total = preparedCount + cachedCount;
      finishPreparation(
        state.prepareCancelled ? "一括準備を中止しました" : "提出物の準備が完了しました",
        `${total}件準備済み${skippedCount ? `・${skippedCount}件未準備` : ""}`,
        total ? "学生を切り替えると、準備済みPDFを直接表示します。" : "準備できるWord／PowerPoint提出物が見つかりませんでした。",
        state.prepareCancelled ? "cancelled" : "done"
      );
      setStatus(`${total}件の提出物を準備済み`, total ? "ready" : "idle");
    } catch (error) {
      finishPreparation("一括準備を中断しました", `${preparedCount + cachedCount}件準備済み`, error.message || "処理中にエラーが発生しました。", "error");
      setStatus(error.message || "一括準備に失敗しました。", "error");
    } finally {
      state.preparing = false;
      state.prepareCancelled = false;
      state.dedicatedPreparation = false;
    }
  }

  function isPowerPoint(fileName = findOfficeFileName()) {
    return /\.pptx?$/i.test(fileName);
  }

  function updateUiLabels() {
    const root = state.ui;
    if (!root) return;
    const powerpoint = isPowerPoint();
    root.querySelector("#cwr-open").textContent = powerpoint
      ? "PowerPointを正確に表示"
      : "Wordで正確に表示";
    root.querySelector("#cwr-open-window").textContent = powerpoint
      ? "PowerPointで発表"
      : "Word別窓で表示";
  }

  function makeUi() {
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
      state.auto = Boolean(cwrAuto);
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
    if (state.preparing && document.getElementById("cwr-preparation-spinner")) {
      const detail = document.getElementById("cwr-preparation-detail");
      if (detail) detail.textContent = text;
      reportPreparationProgress("running");
    }
    state.overlay?.querySelector("iframe")?.contentWindow?.postMessage({ type: "cwr-viewer-status", text, kind }, "*");
  }

  async function startConversion(isAutomatic) {
    if (!state.enabled || state.busy) return;
    const fileName = findOfficeFileName();
    if (!/\.(?:docx?|pptx?)$/i.test(fileName)) {
      if (!isAutomatic) setStatus("表示中のWord／PowerPointファイルが見つかりません。", "error");
      return;
    }

    state.busy = true;
    const key = getSubmissionKey();
    setStatus("提出物を取得中…", "working");
    try {
      const response = await chrome.runtime.sendMessage({ type: "cwr-start", submissionKey: key });
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
    const fileName = findOfficeFileName();
    if (!/\.(?:docx?|pptx?)$/i.test(fileName)) {
      if (!isAutomatic) setStatus("表示中のWord／PowerPointファイルが見つかりません。", "error");
      return;
    }

    state.busy = true;
    const key = getSubmissionKey();
    setStatus(isPowerPoint(fileName) ? "PowerPoint発表画面を準備中…" : "Word別ウィンドウを準備中…", "working");
    try {
      const response = await chrome.runtime.sendMessage({ type: "cwr-open-office", submissionKey: key });
      if (!response?.ok) throw new Error(response?.error || "別ウィンドウを開けませんでした。");
      state.busy = false;
      setStatus(isPowerPoint(response.fileName) ? `${response.fileName} を発表中` : `${response.fileName} をWord別窓で表示中`, "ready");
    } catch (error) {
      state.busy = false;
      setStatus(error.message || "別ウィンドウを開けませんでした。", "error");
    }
  }

  function findPreviewBounds() {
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
    });
    overlay.appendChild(iframe);
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
  });

  function handlePossibleSubmissionChange() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      makeUi();
      updateUiLabels();
      const key = getSubmissionKey();
      if (!key || key === state.currentKey) return;
      const hadPrevious = Boolean(state.currentKey);
      state.currentKey = key;
      state.busy = false;
      if (state.preparing) return;
      if (hadPrevious) {
        // Do not blank the projector while Office is converting the next file.
        // The previous PDF remains visible until the replacement is ready.
        setStatus(state.overlay
          ? "次の提出物へ切り替えています。表示は切替まで維持します。"
          : "提出者が切り替わりました。", "idle");
      }
      if (state.enabled && hadPrevious && state.auto && /\.(?:docx?|pptx?)$/i.test(findOfficeFileName())) {
        setTimeout(() => {
          if (state.mode === "office") startOfficeWindow(true);
          else startConversion(true);
        }, 120);
      }
    }, 200);
  }

  makeUi();
  state.currentKey = getSubmissionKey();
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
    if (!state.overlay) return;
    const bounds = findPreviewBounds();
    state.overlay.style.top = `${bounds.top}px`;
    state.overlay.style.right = `${bounds.right}px`;
  });
  window.addEventListener("unload", () => {
    if (state.mode === "office") {
      chrome.runtime.sendMessage({ type: "cwr-close-office" }).catch(() => undefined);
    }
  });
})();
