(() => {
  const isClassroomTop = location.hostname === "classroom.google.com" && window === window.top;
  const state = {
    enabled: true,
    busy: false,
    auto: false,
    prefetching: false,
    mode: "pdf",
    currentKey: "",
    convertedKey: "",
    displayedPdfUrl: "",
    viewerStatus: null,
    timer: null,
    ui: null,
    overlay: null
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

    if (message?.type === "cwr-prefetch-next") {
      (async () => {
        state.prefetching = true;
        const before = getSubmissionKey();
        const nextButton = findNextSubmissionButton();
        if (!nextButton) {
          sendResponse({ ok: false });
          return;
        }
        nextButton.click();
        sendResponse({ ok: await waitForSubmissionChange(before) });
      })();
      return true;
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

  function findNextSubmissionButton() {
    const nextLabel = /次の(?:提出者|生徒|学生)|次へ|next(?:\s+(?:student|submission))?/i;
    return [...document.querySelectorAll("button, [role='button']")].find((element) => {
      if (!visible(element) || element.getAttribute("aria-disabled") === "true" || element.disabled) return false;
      const labels = [textOf(element), element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-tooltip")];
      return labels.some((label) => nextLabel.test(label || ""));
    }) || null;
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
      <label id="cwr-auto-label">
        <input id="cwr-auto" type="checkbox">
        次を自動表示・先読み
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
    root.querySelector("#cwr-auto").addEventListener("change", (event) => {
      state.auto = event.target.checked;
      chrome.storage.local.set({ cwrAuto: state.auto });
      setStatus(state.auto ? "自動表示・先読みオン" : "自動表示・先読みオフ", "idle");
      if (state.auto && state.convertedKey === getSubmissionKey()) {
        chrome.runtime.sendMessage({ type: "cwr-prefetch" }).catch(() => undefined);
      }
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
    state.overlay?.remove();
    state.overlay = null;
    state.displayedPdfUrl = "";
    state.ui?.classList.remove("cwr-hidden");
  }

  function renderPdf(pdfUrl, fileName, pageCount) {
    const previousPdfUrl = state.displayedPdfUrl;
    removeOverlay();
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
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.displayedPdfUrl = pdfUrl;
    state.ui?.classList.add("cwr-hidden");
    if (previousPdfUrl && previousPdfUrl !== pdfUrl) {
      chrome.runtime.sendMessage({ type: "cwr-release-pdf", pdfUrl: previousPdfUrl }).catch(() => undefined);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "cwr-close") {
      removeOverlay();
      setStatus("プレビューを閉じました。", "idle");
    }
    if (event.data?.type === "cwr-disable") setEnabled(false);
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
      if (hadPrevious) {
        // Do not blank the projector while Office is converting the next file.
        // The previous PDF remains visible until the replacement is ready.
        setStatus(state.overlay
          ? "次の提出物を裏で準備中です。表示は切替まで維持します。"
          : "提出者が切り替わりました。", "idle");
      }
      if (state.enabled && hadPrevious && state.auto && !state.prefetching && /\.(?:docx?|pptx?)$/i.test(findOfficeFileName())) {
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
