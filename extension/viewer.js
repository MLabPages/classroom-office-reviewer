import * as pdfjsLib from "./vendor/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.mjs");

const params = new URLSearchParams(location.search);
const pdfUrl = params.get("pdf") || "";
const fileName = params.get("name") || "Office提出物";
const nameElement = document.getElementById("name");
const metaElement = document.getElementById("meta");
const progressElement = document.getElementById("progress");
const mainElement = document.getElementById("main");
const pagesElement = document.getElementById("pages");
const zoomOutButton = document.getElementById("zoom-out");
const zoomInButton = document.getElementById("zoom-in");
const fullscreenButton = document.getElementById("fullscreen");
const headerElement = document.querySelector("header");
const previousButton = document.getElementById("prev");
const nextButton = document.getElementById("next");
const moreButton = document.getElementById("more");
const moreMenu = document.getElementById("more-menu");
const wideButton = document.getElementById("wide");
const filesButton = document.getElementById("files");
const filesMenu = document.getElementById("files-menu");
let pdfDocument = null;
let zoom = 1;
let renderGeneration = 0;
let resizeTimer = null;
let progressTimer = null;
let progressStartedAt = 0;
let progressText = "";

nameElement.textContent = fileName;

function updateToolbar() {
  const pageCount = pdfDocument?.numPages || 0;
  metaElement.textContent = pageCount
    ? `${pageCount}ページ・${zoom === 1 ? "ページ全体" : `${Math.round(zoom * 100)}%`}`
    : "読み込み中…";
  zoomOutButton.disabled = zoom <= 0.6;
  zoomInButton.disabled = zoom >= 2.6;
}

function showError(error) {
  const message = document.createElement("div");
  message.id = "message";
  message.dataset.kind = "error";
  message.textContent = `${error.message} Start-Reviewer.cmd を起動し直してください。`;
  pagesElement.replaceChildren(message);
  window.parent.postMessage({ type: "cwr-viewer-error" }, "*");
}

function send(message) {
  window.parent.postMessage(message, "*");
}

function closeMoreMenu() {
  moreMenu.hidden = true;
  moreButton.setAttribute("aria-expanded", "false");
}

function closeFilesMenu() {
  filesMenu.hidden = true;
  filesButton.setAttribute("aria-expanded", "false");
}

// 1人が複数ファイルを提出している場合だけ、切り替えボタンを出す。
function renderFileSwitcher(files, activeIndex) {
  const list = Array.isArray(files) ? files : [];
  filesButton.hidden = list.length < 2;
  if (filesButton.hidden) {
    closeFilesMenu();
    return;
  }
  const current = activeIndex >= 0 ? activeIndex : 0;
  filesButton.textContent = `${current + 1}/${list.length} ▾`;
  filesButton.title = `この提出者のファイル（${list.length}件）を切り替える`;
  filesMenu.replaceChildren(...list.map((file, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.textContent = `${index + 1}. ${file.name}`;
    if (index === current) item.dataset.active = "true";
    item.addEventListener("click", () => {
      closeFilesMenu();
      send({ type: "cwr-show-file", index });
    });
    return item;
  }));
}

// 横幅が足りないとボタンの文字が折り返して読めなくなる。狭いときは記号表示へ。
function updateHeaderDensity() {
  const compact = headerElement.clientWidth < 620;
  headerElement.classList.toggle("compact", compact);
}

previousButton.addEventListener("click", () => send({ type: "cwr-navigate", direction: "previous" }));
nextButton.addEventListener("click", () => send({ type: "cwr-navigate", direction: "next" }));

moreButton.addEventListener("click", () => {
  const open = moreMenu.hidden;
  closeFilesMenu();
  moreMenu.hidden = !open;
  moreButton.setAttribute("aria-expanded", String(open));
});
filesButton.addEventListener("click", () => {
  const open = filesMenu.hidden;
  closeMoreMenu();
  filesMenu.hidden = !open;
  filesButton.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (!moreMenu.hidden && !event.target.closest("#more-wrap")) closeMoreMenu();
  if (!filesMenu.hidden && !event.target.closest("#files-wrap")) closeFilesMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeMoreMenu();
  closeFilesMenu();
});
window.addEventListener("message", (event) => {
  if (event.data?.type === "cwr-load-pdf") {
    loadPdf(event.data.pdfUrl, event.data.fileName, event.data.pageCount).catch(showError);
    return;
  }
  if (event.data?.type === "cwr-viewer-controls") {
    previousButton.disabled = event.data.previous === false;
    nextButton.disabled = event.data.next === false;
    wideButton.textContent = event.data.wide ? "Classroomの右側を表示" : "幅いっぱいに広げる";
    renderFileSwitcher(event.data.files, event.data.activeIndex ?? -1);
    return;
  }
  if (event.data?.type !== "cwr-viewer-status") return;
  const kind = event.data.kind || "idle";
  progressText = event.data.text || "";
  clearInterval(progressTimer);
  progressTimer = null;
  progressStartedAt = Date.now();
  progressElement.dataset.kind = kind;
  const updateProgress = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000));
    progressElement.textContent = kind === "working" || kind === "converting"
      ? `${progressText} ${seconds}秒`
      : progressText;
  };
  updateProgress();
  if (kind === "working" || kind === "converting") {
    progressTimer = setInterval(updateProgress, 1000);
  }
});

async function renderPages() {
  if (!pdfDocument) return;
  const generation = ++renderGeneration;
  const scrollRatio = mainElement.scrollHeight > mainElement.clientHeight
    ? mainElement.scrollTop / (mainElement.scrollHeight - mainElement.clientHeight)
    : 0;
  const availableWidth = Math.max(320, mainElement.clientWidth - 32);
  const availableHeight = Math.max(320, mainElement.clientHeight - 24);
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    if (generation !== renderGeneration) return;
    const original = page.getViewport({ scale: 1 });
    const fitScale = Math.min(2, availableWidth / original.width, availableHeight / original.height);
    const viewport = page.getViewport({ scale: fitScale * zoom });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);

    const wrapper = document.createElement("section");
    wrapper.className = "pdf-page";
    wrapper.setAttribute("aria-label", `${pageNumber}ページ目`);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    wrapper.appendChild(canvas);

    const context = canvas.getContext("2d", { alpha: false });
    await page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
    }).promise;

    if (generation !== renderGeneration) return;
    if (pageNumber === 1) {
      pagesElement.replaceChildren(wrapper);
      window.parent.postMessage({ type: "cwr-viewer-ready" }, "*");
    } else {
      pagesElement.appendChild(wrapper);
    }
  }

  if (generation !== renderGeneration) return;
  requestAnimationFrame(() => {
    const maximum = mainElement.scrollHeight - mainElement.clientHeight;
    mainElement.scrollTop = maximum > 0 ? maximum * scrollRatio : 0;
  });
}

async function changeZoom(amount) {
  zoom = Math.max(0.6, Math.min(2.6, Math.round((zoom + amount) * 10) / 10));
  updateToolbar();
  await renderPages();
}

zoomOutButton.addEventListener("click", () => changeZoom(-0.2));
zoomInButton.addEventListener("click", () => changeZoom(0.2));

function visiblePageIndex() {
  const pages = [...pagesElement.querySelectorAll(".pdf-page")];
  if (!pages.length) return -1;
  const center = mainElement.scrollTop + mainElement.clientHeight / 2;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  pages.forEach((page, index) => {
    const pageCenter = page.offsetTop + page.offsetHeight / 2;
    const distance = Math.abs(pageCenter - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function showPresentationPage(index) {
  const pages = [...pagesElement.querySelectorAll(".pdf-page")];
  if (!pages.length) return;
  const target = pages[Math.max(0, Math.min(pages.length - 1, index))];
  target.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() =>
      document.documentElement.requestFullscreen()
    );
  }
}

fullscreenButton.addEventListener("click", () => toggleFullscreen().catch(showError));
document.getElementById("reconvert").addEventListener("click", () => {
  closeMoreMenu();
  send({ type: "cwr-reconvert" });
});
document.getElementById("prepare").addEventListener("click", () => {
  closeMoreMenu();
  send({ type: "cwr-prepare-all" });
});
document.getElementById("cache").addEventListener("click", () => {
  closeMoreMenu();
  send({ type: "cwr-cache-manage" });
});
document.getElementById("disable").addEventListener("click", () => {
  closeMoreMenu();
  send({ type: "cwr-disable" });
});

document.addEventListener("fullscreenchange", () => {
  const active = Boolean(document.fullscreenElement);
  fullscreenButton.querySelector(".label").textContent = active ? "全画面終了" : "全画面";
  fullscreenButton.title = active ? "全画面終了" : "全画面";
  mainElement.classList.toggle("presentation-mode", active);
  renderPages().catch(showError);
});

document.addEventListener("keydown", (event) => {
  if (!document.fullscreenElement || event.altKey || event.ctrlKey || event.metaKey) return;
  const current = visiblePageIndex();
  if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
    event.preventDefault();
    showPresentationPage(current + 1);
  } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
    event.preventDefault();
    showPresentationPage(current - 1);
  } else if (event.key === "Home") {
    event.preventDefault();
    showPresentationPage(0);
  } else if (event.key === "End") {
    event.preventDefault();
    showPresentationPage((pdfDocument?.numPages || 1) - 1);
  }
});

document.getElementById("close").addEventListener("click", () => send({ type: "cwr-close" }));

window.addEventListener("resize", () => {
  updateHeaderDensity();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPages().catch(showError), 250);
});
updateHeaderDensity();

async function loadPdf(pdfUrl, targetFileName, targetPageCount) {
  try {
    if (!pdfUrl.startsWith("http://127.0.0.1:18765/file/")) {
      throw new Error("表示先が正しくありません。");
    }
    nameElement.textContent = targetFileName || "Office提出物";
    metaElement.textContent = targetPageCount ? `${targetPageCount}ページ・読み込み中…` : "読み込み中…";
    pagesElement.replaceChildren();

    const response = await fetch(pdfUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("表示用PDFを読み込めませんでした。");
    const data = new Uint8Array(await response.arrayBuffer());
    pdfDocument = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    updateToolbar();
    await renderPages();
  } catch (error) {
    showError(error);
  }
}
loadPdf(pdfUrl, fileName, params.get("pages")).catch(showError);
