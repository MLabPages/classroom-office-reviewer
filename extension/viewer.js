import * as pdfjsLib from "./vendor/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.mjs");

const params = new URLSearchParams(location.search);
const pdfUrl = params.get("pdf") || "";
const fileName = params.get("name") || "Office提出物";
const nameElement = document.getElementById("name");
const metaElement = document.getElementById("meta");
const mainElement = document.getElementById("main");
const pagesElement = document.getElementById("pages");
const zoomOutButton = document.getElementById("zoom-out");
const zoomInButton = document.getElementById("zoom-in");
const fullscreenButton = document.getElementById("fullscreen");
let pdfDocument = null;
let zoom = 1;
let renderGeneration = 0;
let resizeTimer = null;

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
}

async function renderPages() {
  if (!pdfDocument) return;
  const generation = ++renderGeneration;
  const scrollRatio = mainElement.scrollHeight > mainElement.clientHeight
    ? mainElement.scrollTop / (mainElement.scrollHeight - mainElement.clientHeight)
    : 0;
  const availableWidth = Math.max(320, mainElement.clientWidth - 32);
  const availableHeight = Math.max(320, mainElement.clientHeight - 24);
  const fragment = document.createDocumentFragment();

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
    fragment.appendChild(wrapper);

    const context = canvas.getContext("2d", { alpha: false });
    await page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
    }).promise;
  }

  if (generation !== renderGeneration) return;
  pagesElement.replaceChildren(fragment);
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
document.getElementById("disable").addEventListener("click", () => {
  window.parent.postMessage({ type: "cwr-disable" }, "*");
});

document.addEventListener("fullscreenchange", () => {
  const active = Boolean(document.fullscreenElement);
  fullscreenButton.textContent = active ? "全画面終了" : "全画面";
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

document.getElementById("close").addEventListener("click", () => {
  window.parent.postMessage({ type: "cwr-close" }, "*");
});

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPages().catch(showError), 250);
});

(async () => {
  try {
    if (!pdfUrl.startsWith("http://127.0.0.1:18765/file/")) {
      throw new Error("表示先が正しくありません。");
    }
    const response = await fetch(pdfUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("表示用PDFを読み込めませんでした。");
    const data = new Uint8Array(await response.arrayBuffer());
    pdfDocument = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    updateToolbar();
    await renderPages();
  } catch (error) {
    showError(error);
  }
})();
