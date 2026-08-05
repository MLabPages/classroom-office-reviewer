(() => {
  const isClassroomTop = location.hostname === "classroom.google.com" && window === window.top;
  const SUBMISSION_CATALOG_STORAGE_KEY = "classroomWordReviewerSubmissionCatalogV1";
  const SUBMISSION_CATALOG_MAXIMUM = 2000;
  const SUBMISSION_CATALOG_CONTEXT_MAXIMUM = 24;
  // 準備専用タブが背面のとき、Chromeはタイマーを最大1分まで遅らせる。
  // 進捗が途絶えたと判断するまでの余裕をここで一括管理する。
  const PROGRESS_TICK_MS = 2000;
  // 背面タブではChromeからの進捗通知が遅れる。短時間の無通信を停止と
  // 誤認しないよう、警告は自動再試行を十分続けた後にだけ出す。
  const STALL_WARNING_MS = 120000;
  const BACKGROUND_RETRY_MS = 10000;
  const BACKGROUND_STALLED_RETRY_MS = 30000;
  const BACKGROUND_RETRY_BEFORE_STALLED = 3;
  // 提出者の切替ボタンは、採点画面が出ていれば数百ミリ秒で見つかる。
  // 見つからない時間を長く待つと、先頭と末尾の判定でそのぶん待たされる。
  const SUBMISSION_BUTTON_WAIT_MS = 5000;
  // 表示要求の返事が返らないまま放置されると、次へ・前への操作が黙って
  // 効かなくなる。変換は長くても数十秒なので、これを過ぎたら操作を戻す。
  const DISPLAY_REQUEST_TIMEOUT_MS = 45000;
  // 「添付ファイルはありません」が描き直しの一瞬だけ出ることがある。
  // この時間だけ続けて見えたときに「添付なし」として確定する。
  const NO_ATTACHMENT_CONFIRM_MS = 1500;
  // 提出物の表示待ちを打ち切るまでの再試行回数。ここを超えたら、その提出者は
  // 一覧に記録して次へ進む。無期限に待つと一括準備全体が止まってしまう。
  const MAX_FILE_WAIT_RETRIES = 3;
  // 「添付ファイルはありません」の確認結果を一瞬だけ覚えておくための入れ物。
  const noAttachmentProbe = { checkedAt: 0, result: false };
  // 一括ZIPダウンロードで使う語句。提出者切替欄の表記から提出状態を読み取る。
  const ZIP_STATUS_WORDS = [
    "提出済み", "遅れて提出", "提出期限後に提出", "返却済み", "採点済み", "下書き", "割り当て済み", "未提出",
    "Turned in", "Done late", "Returned", "Graded", "Draft", "Assigned", "Missing"
  ];
  // 提出物を探しに行く価値がある状態。未提出の学生で待たないための判断に使う。
  const ZIP_SUBMITTED_STATUS = /提出済み|遅れて提出|提出期限後に提出|返却済み|採点済み|下書き|Turned in|Done late|Returned|Graded|Draft/;
  const ZIP_GOOGLE_URL = /docs\.google\.com\/(document|spreadsheets|presentation|drawings|forms)\/d\/(?:e\/)?([a-zA-Z0-9_-]{20,})/i;
  const ZIP_GOOGLE_TYPES = {
    document: "document",
    spreadsheets: "spreadsheet",
    presentation: "presentation",
    drawings: "drawing"
  };
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
    // 変換して表示できない提出（共有リンク・添付なし）を出しているときの内容。
    viewerNotice: null,
    timer: null,
    preparationTimer: null,
    progressTicker: null,
    watchdogTimer: null,
    lastRemoteProgressAt: 0,
    busyWatchdog: null,
    contextInvalidated: false,
    mutationObserver: null,
    contextWatcher: null,
    preparationCompact: true,
    preparationPanelHidden: false,
    preparationLedgerExpanded: false,
    preparationVisibilityWaiters: [],
    controlsCollapsed: true,
    controlsPosition: null,
    controlsDraggedAt: 0,
    preparationPosition: null,
    preparationDraggedAt: 0,
    wide: false,
    overlayBounds: null,
    activeFile: null,
    submissionCatalog: [],
    submissionCatalogContext: "",
    submissionCatalogStorage: {},
    submissionCatalogLoaded: false,
    submissionCatalogSaveTimer: null,
    catalogActiveKey: "",
    fileSwitching: false,
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
    delayed: false,
    stalled: false,
    paused: false,
    remote: false,
    ledger: []
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

  // Google形式のラベルには拡張子がなく、Officeのように境界で重複を取り除けない。
  // 文字列全体がちょうど半分ずつの繰り返しになっているときだけ、前半を採用する。
  function dedupeDoubledLabel(text) {
    const half = text.length / 2;
    if (Number.isInteger(half) && half > 0 && text.slice(0, half) === text.slice(half)) {
      return text.slice(0, half);
    }
    return text;
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

  // PDFはOffice変換が不要なので、Word／PowerPointとは別に検出する。
  function findPdfFileName() {
    return findFileName("pdf");
  }

  function findAnyAttachmentFileName() {
    return findFileName("docx?|pptx?|pdf|xlsx?|csv|txt|rtf|odt|ods|odp|jpe?g|png|gif|webp|zip");
  }

  // Classroom自身が「添付ファイルはありません」（英語版では"No attachments"）と
  // 表示している状態を検出する。これは「まだ描画中」ではなく、Classroomが
  // 添付なしと確定表示しているサインなので、ここが見えたら再試行を続ける
  // 必要はない。ただしテキストのみの提出や実際に未提出などの区別は
  // つかないため、呼び出し側では「未提出」と断定せず「添付ファイルなし」
  // として扱う。
  function findNoAttachmentMessage() {
    // 提出者を切り替えるたびに全要素の文字を読むと重くなる。文字を持つ末端の
    // 要素だけに絞り、短時間は前回の判定を使い回して通常の処理速度を保つ。
    const now = Date.now();
    if (now - noAttachmentProbe.checkedAt < 250) return noAttachmentProbe.result;
    let found = false;
    for (const node of document.querySelectorAll("div, span, p")) {
      if (node.children && node.children.length > 0) continue;
      if (!visible(node)) continue;
      const text = textOf(node);
      if (text.length > 40) continue;
      if (text === "添付ファイルはありません" || /^no attachments\.?$/i.test(text)) {
        found = true;
        break;
      }
    }
    noAttachmentProbe.checkedAt = now;
    noAttachmentProbe.result = found;
    return found;
  }

  // 共有リンクの提出は、Classroomでは「ファイル」ではなくURLとして届く。
  // Word/PowerPointらしい名前が付いていてもDrive上に実体が無いため、
  // 取得しようとすると失敗し、前の学生の表示が残ってしまう。
  const DOCUMENT_LINK_HOSTS = /(?:1drv\.ms|onedrive\.live\.com|sharepoint\.com|officeapps\.live\.com|office\.com|dropbox\.com|box\.com|icloud\.com|notion\.so|canva\.com|scribd\.com)/i;
  const IGNORED_LINK_URLS = /(?:classroom\.google\.com|accounts\.google\.com|support\.google\.com|myaccount\.google\.com|policies\.google\.com|google\.com\/(?:search|url|intl))/i;

  function isDriveUrl(value) {
    return /(?:drive|docs)\.google\.com/i.test(value || "");
  }

  // リンク添付に読める名前が付いていないときは、URLから短い見出しを作る。
  function linkLabelOf(url) {
    try {
      const parsed = new URL(url);
      const tail = decodeURIComponent(parsed.pathname).split("/").filter(Boolean).pop() || "";
      return tail ? `${parsed.hostname}/${tail}`.slice(0, 120) : parsed.hostname;
    } catch {
      return String(url || "").slice(0, 120);
    }
  }

  // Classroomの採点画面には案内用のリンクも並ぶ。提出物として扱ってよい
  // リンクだけを通し、無関係なリンクを提出物として数えない。
  function isLikelySubmittedLink(node, url) {
    if (!/^https?:\/\//i.test(url) || isDriveUrl(url) || IGNORED_LINK_URLS.test(url)) return false;
    if (!visible(node)) return false;
    if (DOCUMENT_LINK_HOSTS.test(url)) return true;
    if (/\.(?:docx?|pptx?|pdf|xlsx?)(?:$|[?#])/i.test(url)) return true;
    return /\.(?:docx?|pptx?|pdf|xlsx?)$/i.test(attachmentNameOf(node, "") || "");
  }

  // 共有リンクの提出は、変換して表示することができない。名前とURLだけを
  // 持たせ、あとで一覧とビューアーが「リンク提出」として扱えるようにする。
  function linkAttachmentInfoOf(node, url) {
    if (!url) return null;
    const label = attachmentNameOf(node, "") || textOf(node) || "";
    return {
      kind: "link",
      fileName: (label || linkLabelOf(url)).slice(0, 160),
      expectedName: "",
      expectedFileId: "",
      expectedGoogleType: "",
      sourceUrl: url
    };
  }

  // 画面に出ている「提出物として扱ってよいリンク」だけを集める。
  function findSubmittedLinks() {
    const links = [];
    const seen = new Set();
    for (const node of document.querySelectorAll("a[href]")) {
      const url = fileUrlOf(node);
      if (!isLikelySubmittedLink(node, url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const info = linkAttachmentInfoOf(node, url);
      if (info) links.push(info);
    }
    return links;
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
        // 先頭にアイコン用の見えない文字が入ることがあるため、^では固定しない。
        const match = source?.match(/Google\s*(ドキュメント|Docs?|スライド|Slides?)\s*[:：]\s*(.{1,160})$/i);
        if (!match) continue;
        labeledKind = /ドキュメント|docs?/i.test(match[1]) ? "google-document" : "google-presentation";
        labeledFileName = dedupeDoubledLabel(match[2].trim());
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
    // 同じ提出物にWordとPDFが添付されている場合、全体を検索すると
    // メニューの先頭にあるWordを、現在選択中のPDFと誤認してしまう。
    // Classroomの実DOMでは選択中のmenuitemが tabindex="0" になるため、
    // まず現在の選択項目を使い、Word/PDFの種別を確定する。
    const selectedAttachment = selectedSubmissionAttachment();
    if (selectedAttachment && ["office", "pdf"].includes(selectedAttachment.kind)) {
      return selectedAttachment;
    }
    const officeFileName = findOfficeFileName();
    if (officeFileName) {
      // Drive上のファイル番号を早い段階で確定させておく。ここを空のままにすると、
      // 背景側が名前だけでの代替検索に頼り、同じ名前で出す別の学生の
      // 準備済みPDFを取り違えることがある。
      return {
        kind: "office",
        fileName: officeFileName,
        expectedName: officeFileName,
        expectedFileId: findDisplayedFileId()
      };
    }
    // 提出物がすでにPDFの場合はOffice変換が不要。そのまま表示・カウント対象にする。
    const pdfFileName = findPdfFileName();
    if (pdfFileName) {
      return {
        kind: "pdf",
        fileName: pdfFileName,
        expectedName: pdfFileName,
        expectedFileId: findDisplayedFileId()
      };
    }
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
        // PDFはOffice変換が不要なため、そのまま添付名として拾う。
        const pdfName = matchFileName(source, "pdf");
        if (pdfName) return pdfName;
        // 先頭にアイコン用の見えない文字が入ることがあるため、^では固定しない。
        // また、Officeと違って拡張子がなく境界を作れないため、名前が2回続けて
        // 出ていたら（近大ゼミ2026…近大ゼミ2026… のように）前半だけを使う。
        const googleLabel = source?.match(/Google\s*(?:ドキュメント|Docs?|スライド|Slides?)\s*[:：]\s*(.{1,160})$/i);
        if (googleLabel) return dedupeDoubledLabel(googleLabel[1].trim());
        const attachmentName = matchFileName(source, "docx?|pptx?|pdf|xlsx?|csv|txt|rtf|odt|ods|odp|jpe?g|png|gif|webp|zip");
        if (attachmentName) return attachmentName;
      }
      current = current.parentElement;
    }
    if (!googleType) return "";
    const label = textOf(node).slice(0, 160);
    return label || (googleType === "document" ? "Googleドキュメント" : "Googleスライド");
  }

  function googleTypeOfLabel(value) {
    if (/Google\s*(?:ドキュメント|Docs?)/i.test(value || "")) return "document";
    if (/Google\s*(?:スライド|Slides?)/i.test(value || "")) return "presentation";
    return "";
  }

  function fileUrlOf(node) {
    return node?.href
      || node?.getAttribute("href")
      || node?.getAttribute("data-href")
      || node?.getAttribute("data-url")
      || node?.getAttribute("data-file-url")
      || node?.getAttribute("data-file-id")
      || "";
  }

  // 現行のClassroomでは、選ぶための項目には data-cursor-id だけがあり、
  // 実際のDrive URLは同じ data-selection-id を持つ「新しいウィンドウで開く」
  // 側に置かれている。両方を結び付けないと、同名の複数提出を区別できない。
  function menuSelectionIdOf(node) {
    const selectionId = node?.getAttribute?.("data-selection-id") || "";
    if (selectionId) return selectionId;
    const cursorId = node?.getAttribute?.("data-cursor-id") || "";
    return cursorId.match(/^[io]:(.+)$/)?.[1] || "";
  }

  function submissionFileUrlOf(node) {
    const directUrl = fileUrlOf(node);
    if (directUrl) return directUrl;
    // 2件目以降は「新しいウィンドウで開く」リンクが選択項目の内側へ
    // 入ることがある。この形は対応する兄弟要素を持たないため、先に
    // 自身の子孫からDrive URLを拾う。
    const nestedLink = node?.querySelector?.(
      "a[href], [data-href], [data-url], [data-file-url], [data-file-id]"
    );
    const nestedUrl = fileUrlOf(nestedLink);
    if (nestedUrl) return nestedUrl;
    const selectionId = menuSelectionIdOf(node);
    if (!selectionId) return "";
    const candidates = document.querySelectorAll(
      "[data-selection-id], [data-cursor-id], [data-url], [data-file-url], [data-file-id], a[href]"
    );
    for (const candidate of candidates) {
      if (candidate === node) continue;
      if (menuSelectionIdOf(candidate) !== selectionId) continue;
      const url = fileUrlOf(candidate);
      if (url) return url;
    }
    return "";
  }

  // Classroomのファイル選択欄は、通常のリンクではなく role=menuitem の
  // span として描画されることがある。2件目以降も同じ欄から拾う。
  // 選択欄が閉じているあいだ項目は隠れているだけでDOMには残るため、
  // 見えているかどうかで絞り込まない。絞り込むと2件目を見落とす。
  function findSubmissionFileMenuItems() {
    const items = [...document.querySelectorAll("[role='menuitem']")].filter((node) => {
      if (node.getAttribute?.("role") !== "menuitem") return false;
      const text = textOf(node);
      if (!text || /新しいウィンドウ|new window/i.test(text)) return false;
      const menu = node.closest?.("[role='menu']");
      const menuLabel = menu?.getAttribute("aria-label") || "";
      return !menu || /ファイル|file|submission/i.test(menuLabel) || Boolean(attachmentNameOf(node, googleTypeOfLabel(text)));
    });
    if (items.length < 2) return items;
    // 画面には別の提出者のメニューが残っていることがある。表示中のファイルが
    // 含まれるメニューが見つかったら、その1つだけを使う。
    const displayedId = findDisplayedFileId() || state.activeFile?.id || "";
    const displayedName = normalizedFileName(findOfficeFileName() || findPdfFileName() || state.activeFile?.name || "");
    if (!displayedId && !displayedName) return items;
    const groups = new Map();
    for (const node of items) {
      const menu = node.closest?.("[role='menu']") || null;
      if (!groups.has(menu)) groups.set(menu, []);
      groups.get(menu).push(node);
    }
    if (groups.size < 2) return items;
    if (displayedId) {
      for (const group of groups.values()) {
        if (group.some((node) => attachmentInfoOf(node)?.expectedFileId === displayedId)) return group;
      }
    }
    for (const group of groups.values()) {
      const matched = group.some((node) => {
        const attachment = attachmentInfoOf(node);
        return attachment && fileNamesLikelyMatch(normalizedFileName(attachment.fileName), displayedName);
      });
      if (matched) return group;
    }
    return items;
  }

  function attachmentInfoOf(node) {
    const url = submissionFileUrlOf(node);
    const label = [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-tooltip"), textOf(node)]
      .filter(Boolean)
      .join(" ");
    const googleType = googleTypeOfUrl(url) || googleTypeOfLabel(label);
    const fileName = attachmentNameOf(node, googleType);
    const fileId = parseDriveId(url);
    const sourceUrl = /^https?:\/\//i.test(url) ? url : "";
    if (!fileName || (!googleType && !/\.(?:docx?|pptx?|pdf|xlsx?|csv|txt|rtf|odt|ods|odp|jpe?g|png|gif|webp|zip)$/i.test(fileName))) return null;
    const isPdf = !googleType && /\.pdf$/i.test(fileName);
    const isOffice = !googleType && /\.(?:docx?|pptx?)$/i.test(fileName);
    return {
      kind: googleType
        ? (googleType === "document" ? "google-document" : "google-presentation")
        : (isPdf ? "pdf" : (isOffice ? "office" : "unknown")),
      fileName,
      expectedName: googleType ? "" : fileName,
      expectedFileId: fileId,
      expectedGoogleType: googleType,
      sourceUrl
    };
  }

  function selectedSubmissionAttachment() {
    const selectedItem = findSubmissionFileMenuItems().find((node) => {
      const selected = [
        node.getAttribute("aria-selected"),
        node.getAttribute("aria-current"),
        node.getAttribute("data-selected")
      ].some((value) => value === "true") || node.getAttribute("tabindex") === "0";
      return selected;
    });
    const attachment = selectedItem ? attachmentInfoOf(selectedItem) : null;
    if (!attachment) return null;
    const displayedId = findDisplayedFileId();
    if (displayedId) attachment.expectedFileId = displayedId;
    return attachment;
  }

  // 1人が複数ファイルを提出することがある。リンクだけでなく、
  // Classroomのファイル選択欄も拾い、2件目以降を落とさない。
  function findSubmissionAttachments() {
    const attachments = [];
    const seen = new Set();
    const linkNodes = [...document.querySelectorAll("a[href]")].filter((node) =>
      typeof node.matches === "function" ? node.matches("a[href]") : Boolean(node.href));
    // Classroomのファイル選択欄の順番を先に採用する。2件目の内側にある
    // Driveリンクを先に並べると、一覧が「2件目→1件目」に逆転し、
    // 現在の1件目が末尾扱いになって右ボタンが効かなくなる。
    const nodes = [...findSubmissionFileMenuItems(), ...linkNodes];
    for (const node of nodes) {
      const url = fileUrlOf(node);
      const isMenuItem = node.getAttribute?.("role") === "menuitem";
      // 選択欄の項目は閉じていると見えない。さらに新しいClassroomでは、
      // 提出ファイルへのDriveリンク自体が画面に出ない作りになったため、
      // 「見えないリンク」を捨てると添付が1件も見つからず、表示が
      // 前の提出者のまま固まる。リンクの見た目ではなく、Driveの
      // ファイルを指しているかどうかで判断する。
      if (!isMenuItem && !/(?:drive|docs)\.google\.com/i.test(url) && !visible(node)) continue;
      // Drive上のファイルでも選択欄の項目でもないが、Word/PowerPointなどを
      // 指す共有リンクとして提出されていることがある。これを捨てると
      // 「提出物なし」と誤って扱ってしまうため、リンクとして取り込む。
      const sharedLink = !isMenuItem && !isDriveUrl(url) && isLikelySubmittedLink(node, url);
      if (!isDriveUrl(url) && !isMenuItem && !sharedLink) continue;
      const attachment = sharedLink ? linkAttachmentInfoOf(node, url) : attachmentInfoOf(node);
      if (!attachment) continue;
      const identity = attachment.expectedFileId
        ? `id:${attachment.expectedFileId}`
        : (attachment.kind === "link"
          ? `url:${(attachment.sourceUrl || "").trim().toLowerCase()}`
          : `name:${attachment.fileName.trim().toLowerCase()}`);
      const duplicate = seen.has(identity) || attachments.some((item) => sameFile(item, attachment));
      if (duplicate) continue;
      seen.add(identity);
      attachments.push(attachment);
    }
    return attachments;
  }

  function sameFile(left, right) {
    if (!left || !right) return false;
    // 共有リンクの提出はファイル番号を持たないため、URLで見分ける。
    // 名前だけで比べると、似た名前の別リンクを同じものとして落としてしまう。
    if (left.kind === "link" || right.kind === "link") {
      if (left.kind !== right.kind) return false;
      return Boolean(left.sourceUrl) && left.sourceUrl === right.sourceUrl;
    }
    if (left.expectedFileId && right.expectedFileId) return left.expectedFileId === right.expectedFileId;
    // 表示位置によって選択欄の名前が途中で切られることがあるため、
    // 完全一致だけで比べると同じファイルを別物として重複計上してしまう。
    return fileNamesLikelyMatch(normalizedFileName(left.fileName), normalizedFileName(right.fileName));
  }

  // Classroomのファイル選択欄に並ぶ順番を、そのまま拡張の順番として使う。
  // 表示中の1件を必ず先頭へ置くと、2件目を見ているときに順番が入れ替わり、
  // Classroomの表示と左右ボタンの進み方がずれてしまう。
  function listSubmissionFiles(primary = findSupportedFileInfo()) {
    const current = primary && !primary.unsupported && !primary.waiting ? { ...primary } : null;
    if (current && !current.expectedFileId) {
      current.expectedFileId = findDisplayedFileId();
    }
    const files = [];
    for (const attachment of findSubmissionAttachments()) {
      if (files.some((item) => sameFile(item, attachment))) continue;
      files.push({ ...attachment });
    }
    if (!current) return files;
    const matched = files.find((item) => sameFile(item, current));
    if (!matched) return [current, ...files];
    // 選択欄からは番号が取れないことがあるので、表示中の番号で補う。
    if (!matched.expectedFileId && current.expectedFileId) {
      matched.expectedFileId = current.expectedFileId;
    }
    // 選択欄の名前は途中で切られていることがあるので、より長く読み取れた
    // 表示中の名前のほうを採用する。
    if (current.fileName && current.fileName.length > (matched.fileName || "").length) {
      matched.fileName = current.fileName;
    }
    return files;
  }

  // Classroomで利用者が右側の添付を直接選んだときは、拡張が前回覚えた
  // activeFile より、いま表示されているプレビューiframeのファイルIDを優先する。
  // ここを逆にすると、2件目を選んでも1件目のキーとキャッシュを再利用してしまう。
  function currentDisplayedFileInfo() {
    const displayedId = findDisplayedFileId();
    const detected = findSupportedFileInfo();
    const selectedAttachment = displayedId
      ? findSubmissionAttachments().find((file) => file.expectedFileId === displayedId)
      : null;
    // Drive上のファイルが1つも表示されていないのに、共有リンクだけが
    // 置かれている提出物がある。名前がWordらしくてもファイルとして扱わず、
    // リンクとして返す。ここを誤ると取得に失敗して前の表示が残る。
    if (!displayedId && !selectedAttachment) {
      const submittedLinks = findSubmittedLinks();
      if (submittedLinks.length) return { ...submittedLinks[0] };
    }
    const current = selectedAttachment || detected;
    if (!current) return null;
    return {
      ...current,
      expectedFileId: displayedId || current.expectedFileId || ""
    };
  }

  function inspectSubmissionFile() {
    const supportedFile = findSupportedFileInfo();
    if (supportedFile?.kind?.startsWith("google-") && !supportedFile.expectedFileId) return { waiting: true };
    // 共有リンクの提出は「レポート.docx」のような名前が付いていることが多く、
    // 名前だけを見るとWordファイルに見える。しかしDrive上に実体が無いため、
    // ファイルとして扱うと取得に失敗し、前の学生の表示が残ってしまう。
    // Drive上のファイル番号を確認できないときだけ、リンクとして扱う。
    const submittedLinks = findSubmittedLinks();
    const looksLikeDriveFile = Boolean(supportedFile?.expectedFileId) || Boolean(findDisplayedFileId());
    if (submittedLinks.length && !looksLikeDriveFile) {
      return { ...submittedLinks[0], linkOnly: true };
    }
    if (supportedFile) return supportedFile;
    if (findAnyAttachmentFileName()) return { unsupported: true };
    // Classroomが「添付ファイルはありません」を確定表示しているなら、
    // これ以上待っても添付は出てこない。次の提出者へ進めてよい合図として
    // 区別できる状態を返す（＝再試行ループの対象から外す）。
    if (findNoAttachmentMessage()) return { noAttachment: true };
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

  function findDisplayedFileId() {
    const frames = [...document.querySelectorAll("iframe[src]")]
      .filter((frame) => visible(frame) && /(?:drive|docs)\.google\.com/i.test(frame.src || ""));
    for (const frame of frames) {
      const fileId = parseDriveId(frame.src || "");
      if (fileId) return fileId;
    }
    return "";
  }

  function normalizedFileName(name) {
    return (name || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Classroomの選択欄では、同じファイルの名前が場所によって異なる形に
  // 途中で切られて表示されることがある。完全一致だけで比べると、表示中の
  // ファイルを含むメニューを見失い、前の提出者の残骸ごと混ぜてしまう。
  function fileNamesLikelyMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
  }

  function findSubmissionFileMenuItem(file) {
    const target = normalizedFileName(typeof file === "string" ? file : file?.fileName);
    const targetId = typeof file === "string" ? "" : (file?.expectedFileId || "");
    const items = findSubmissionFileMenuItems().map((node) => ({ node, attachment: attachmentInfoOf(node) }));
    if (targetId) {
      const byId = items.find((item) => item.attachment?.expectedFileId === targetId);
      if (byId) return byId.node;
    }
    return items.find((item) => item.attachment && fileNamesLikelyMatch(normalizedFileName(item.attachment.fileName), target))?.node || null;
  }

  // 選択欄が閉じていると項目を押しても効かない。開くボタンを押してから
  // 項目が実際に見えるまで待つ。
  function findFileMenuOpener() {
    return [...document.querySelectorAll("[aria-haspopup='true'], [aria-haspopup='menu'], button, [role='button']")]
      .find((node) => {
        if (!visible(node)) return false;
        if (node.getAttribute("aria-haspopup") !== "true" && node.getAttribute("aria-haspopup") !== "menu") return false;
        const label = [node.getAttribute("aria-label"), node.getAttribute("title"), textOf(node)].join(" ");
        return /\.(?:docx?|pptx?|pdf)|ファイル|file|Google\s*(?:ドキュメント|Docs?|スライド|Slides?)/i.test(label);
      }) || null;
  }

  async function openFileMenu(file, timeoutMs = 4000) {
    let item = findSubmissionFileMenuItem(file);
    if (item && visible(item)) return item;
    const opener = findFileMenuOpener();
    if (!opener) return item;
    opener.click();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      item = findSubmissionFileMenuItem(file);
      if (item && visible(item)) return item;
      await wait(120);
    }
    return item;
  }

  async function waitForDisplayedFileChange(previousId, expectedId = "", timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const currentId = findDisplayedFileId();
      if (expectedId && currentId === expectedId) return currentId;
      if (!expectedId && currentId && currentId !== previousId) return currentId;
      await wait(150);
    }
    return "";
  }

  async function selectSubmissionFile(file) {
    const previousId = findDisplayedFileId();
    const targetName = normalizedFileName(file?.fileName);
    const activeName = normalizedFileName(state.activeFile?.name);
    const alreadyShown = file?.expectedFileId
      ? file.expectedFileId === previousId
      : Boolean(targetName) && targetName === activeName;
    if (alreadyShown) {
      return { ...file, expectedFileId: file.expectedFileId || state.activeFile?.id || previousId };
    }
    const menuItem = await openFileMenu(file);
    if (!menuItem) return null;
    menuItem.click();
    const selectedId = await waitForDisplayedFileChange(previousId, file?.expectedFileId || "");
    if (!selectedId) return null;
    return { ...file, expectedFileId: file.expectedFileId || selectedId || previousId };
  }

  function describeDocument() {
    let downloadUrl = "";
    let fileId = parseDriveId(location.href);
    const classroomGoogleInfo = isClassroomTop ? findGoogleFileInfo() : null;
    const currentFileInfo = findSupportedFileInfo();
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
      fileName: currentFileInfo?.fileName || classroomGoogleInfo?.fileName || findOfficeFileName() || findPdfFileName() || (googleType === "document" ? "Googleドキュメント" : googleType === "presentation" ? "Googleスライド" : ""),
      fileId: currentFileInfo?.expectedFileId || fileId,
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
      findNoAttachmentMessage,
      findSubmittedLinks,
      isLikelySubmittedLink,
      linkAttachmentInfoOf,
      findGoogleFileInfo,
      findSupportedFileInfo,
      inspectSubmissionFile,
      describeDocument,
      isSubmissionView,
      formatDuration,
      preparationCountText,
      findSubmissionAttachments,
      attachmentInfoOf,
      selectedSubmissionAttachment,
      listSubmissionFiles,
      findSubmissionFileMenuItems,
      findSubmissionFileMenuItem,
      normalizedFileName,
      studentDisplayName,
      getStudentLabel,
      getSubmissionKey,
      currentDisplayedFileInfo,
      matchesRequestedFile,
      setActiveFile,
      saveSetting,
      loadSettings,
      extensionContextLost,
      sameSubmissionStudent,
      submissionStateKind,
      submissionChangeReady,
      preparationDocumentState,
      preparationDocumentVisible,
      getStudentIdFromUrl,
      getStudentKey,
      navigationStudentKey,
      zipStudentKey,
      zipCollectionCompletion,
      dedupeDoubledLabel,
      fileTypeLabel,
      submissionCatalogKey,
      zipStudentName,
      zipStatusOf,
      zipDecodeStudentId,
      readClassroomRoster,
      zipAttachmentLabel,
      collectExtraGoogleAttachments,
      zipFilesForCurrentStudent,
      splitRosterCsvLine,
      zipRosterNameKey,
      zipAbbreviatedNumber,
      zipDisplayIdentity,
      parseRosterCsv,
      applyRosterStudentNumbers,
      zipAssignmentName
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
        paused: false,
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
        // 表示中の1件は既にキャッシュにあるため、そこを起点に次の3人分まで低優先度で準備する。
        prepareAllSubmissions({ dedicated: true, limit: message.prefetch ? 4 : 0, startAtCurrent: message.prefetch === true });
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
      if (!sameSubmissionStudent(message.submissionKey)) return false;
      setStatus(message.text, message.state);
      if (message.state === "error") endDisplayRequest();
    }
    if (message?.type === "cwr-show-pdf") {
      if (!state.enabled) {
        endDisplayRequest();
        safeSendMessage({ type: "cwr-release-pdf", pdfUrl: message.pdfUrl }).catch(() => undefined);
        return false;
      }
      if (!sameSubmissionStudent(message.submissionKey)) {
        endDisplayRequest();
        safeSendMessage({ type: "cwr-release-pdf", pdfUrl: message.pdfUrl }).catch(() => undefined);
        setStatus("提出者が切り替わったため、古い表示を破棄しました。", "idle");
        return false;
      }
      // 同じ提出者でも、切り替えの途中で前のファイルの変換結果が遅れて
      // 届くことがある。今表示すべきファイル番号と違うPDFをそのまま出すと、
      // 画面が一瞬点滅して同じ内容に戻ったように見える。番号が食い違う結果は
      // 受け取らず、あとから届く正しい結果を待つ。
      if (!matchesRequestedFile(message)) {
        safeSendMessage({ type: "cwr-release-pdf", pdfUrl: message.pdfUrl }).catch(() => undefined);
        return false;
      }
      endDisplayRequest();
      state.convertedKey = getSubmissionKey();
      state.catalogActiveKey = "";
      renderPdf(message.pdfUrl, message.fileName, message.pageCount);
      rememberDisplayedPdf(message.pdfUrl, message.fileName, message.pageCount);
      setStatus("提出物を表示中", "ready");
      // 採点中の画面を動かさず、別タブで次の3人分だけ低優先度に準備する。
      // 一括準備中は同じ学生切替・待機処理を二重に走らせない。完了または
      // 中止後の次回表示から、通常どおり先読みを再開する。
      if (!state.preparing && !state.remotePreparing) {
        safeSendMessage({ type: "cwr-prefetch-next" }).catch(() => undefined);
      }
    }
    return false;
  });

  if (!isClassroomTop) return;

  function getStudentLabel() {
    const markers = ["提出済み", "Turned in", "返却済み", "Returned", "割り当て済み", "Assigned", "遅れて提出", "Done late", "不足", "Missing"];
    
    // Classroomの新しいUI：ドロップダウン内で現在選択されている生徒 (aria-checked="true")
    // data-value 属性を持つ項目は生徒リストである可能性が高い。ステータス絞り込みメニュー等の場合はマーカーが含まれるため除外される。
    const checkedItems = document.querySelectorAll("[aria-checked='true'][data-value], [aria-selected='true'][data-value]");
    for (const item of checkedItems) {
      // 画面に出ていない項目（メニューを閉じている間の控えの要素など）は
      // 「名」のような断片しか持たず、名前として使うと誤表示になる。
      if (!visible(item)) continue;
      const text = textOf(item);
      if (text && text.length >= 2 && text.length < 220) {
        return text;
      }
    }

    // 従来のUI：提出状況マーカーを含むボタンなどから抽出
    const elements = document.querySelectorAll("button, [role='button'], [role='combobox'], [role='listbox'], [aria-haspopup], [aria-label]");
    for (const element of elements) {
      if (!visible(element)) continue;
      const value = textOf(element);
      if (value.length > 220 || !markers.some((marker) => value.includes(marker))) continue;
      const parent = element.closest("button, [role='button'], [role='combobox']") || element.parentElement || element;
      const label = textOf(parent);
      if (label) return label.slice(0, 220);
    }

    // 最後の手立て：提出ファイル名は「26_0259 森本（Morimoto） - 課題名.docx」の
    // 形をとることが多い。ここから提出者名だけを取り出す。
    const fileInfo = currentDisplayedFileInfo();
    const separated = (fileInfo?.fileName || "").split(/\s-\s/);
    if (separated.length >= 2 && separated[0].trim().length >= 2) {
      return separated[0].trim().slice(0, 220);
    }
    return "";
  }

  // 一覧表示用に、提出状況の文言を除いた読みやすい名前へ整える。
  function studentDisplayName(label) {
    return (label || "").replace(/提出済み|返却済み|割り当て済み|遅れて提出|不足|Turned in|Returned|Assigned|Done late|Missing/gi, "").trim() || label || "";
  }

  // Classroomは表示中の提出者をURLの #u=... で表す。画面から名前を読み取るより
  // 確実で、描画が間に合っていなくても取得できる。
  function getStudentIdFromUrl() {
    return location.href.match(/[#&?]u=([^&]+)/)?.[1] || "";
  }

  function getStudentKey() {
    if (!isSubmissionView()) return "";
    // URLで提出者が分かるときは、それだけを鍵にする。画面から読んだ名前を
    // 混ぜると、描画の途中で鍵が変わり、変換結果が「別の提出者のもの」と
    // 誤判定されて捨てられてしまう。
    const studentId = getStudentIdFromUrl();
    if (studentId) return `u:${studentId}`;
    return [location.href, getStudentLabel()].join("|");
  }

  // 学生切替の判定では、画面の矢印が描画途中でもURLの学生IDを優先する。
  // URLにIDが無い画面だけ、通常レビューと同じ判定へ戻す。
  function navigationStudentKey() {
    const studentId = getStudentIdFromUrl();
    return studentId ? `u:${studentId}` : getStudentKey();
  }

  // ZIP巡回では、未提出者の画面で前後ボタンや添付欄が一時的に消えても、URLに
  // 出ている提出者IDを優先して処理を続ける。通常表示用の getStudentKey() は
  // 採点画面かどうかも確認するため、そのまま使う。
  function zipStudentKey() {
    return navigationStudentKey();
  }

  // 正常終了は、実際に「次へ」ボタンが無効だった場合だけにする。途中で画面が
  // 読めなくなった場合や同じ学生へ戻った場合を添付なし・末尾と混同しない。
  function zipCollectionCompletion({ rosterTotal = 0, collectedCount = 0, stopReason = "" } = {}) {
    if (stopReason === "end") {
      if (rosterTotal > 0 && collectedCount < rosterTotal) {
        return {
          complete: false,
          message: `Classroomは最終学生を示しましたが、${rosterTotal}名中${collectedCount}名しか確認できませんでした。途中停止としてZIP作成を中止しました。`
        };
      }
      return { complete: true, message: "" };
    }
    const reason = {
      "student-key-missing": "現在の学生を識別できませんでした",
      "duplicate-student": "同じ学生を再び検出しました",
      missing: "次へボタンを取得できませんでした",
      stuck: "学生切替の画面更新を確認できませんでした",
      "context-lost": "拡張機能の画面連携が切れました"
    }[stopReason] || "巡回を完了できませんでした";
    return {
      complete: false,
      message: `${reason}。${rosterTotal ? `${rosterTotal}名中${collectedCount}名` : `${collectedCount}名`}まで確認したため、途中停止としてZIP作成を中止しました。`
    };
  }

  // 保存先は表示名ではなく、ClassroomのURLと提出者・Driveファイル番号で決める。
  // 同姓同名や同じファイル名でも、別の授業・課題・提出者のPDFを取り違えない。
  function getCacheIdentity(fileInfo = null) {
    const match = location.pathname.match(/\/c\/([^/]+)\/a\/([^/]+)/);
    const currentFile = fileInfo || currentDisplayedFileInfo() || state.activeFile || {};
    return {
      courseId: match?.[1] || "unknown-course",
      assignmentId: match?.[2] || "unknown-assignment",
      submissionId: getStudentIdFromUrl() || getStudentKey() || "unknown-submission",
      fileId: currentFile.expectedFileId || currentFile.id || findDisplayedFileId() || "unknown-file"
    };
  }

  function getSubmissionKey(fileInfo = null) {
    const studentKey = getStudentKey();
    if (!studentKey) return "";
    const currentFile = fileInfo || currentDisplayedFileInfo() || (state.activeFile?.name
      ? { fileName: state.activeFile.name, expectedFileId: state.activeFile.id }
      : null);
    // 同じ名前のファイルを複数提出することがある。名前だけを鍵にすると、
    // Classroom側で別ファイルを選んでも変化なしと誤認して古いPDFを残してしまう。
    return [studentKey, currentFile?.expectedFileId || currentFile?.id || currentFile?.fileName || ""].join("|");
  }

  function fileTypeLabel(file = {}) {
    if (file.kind === "pdf") return "PDF";
    if (file.kind === "office") return /\.pptx?$/i.test(file.fileName || "") ? "PowerPoint" : "Word";
    if (file.kind === "google-document") return "Googleドキュメント";
    if (file.kind === "google-presentation") return "Googleスライド";
    if (file.kind === "link") return "共有リンク";
    if (file.kind === "no-attachment") return "添付ファイルなし";
    const extension = (file.fileName || "").match(/\.([a-z0-9]+)$/i)?.[1];
    return extension ? extension.toUpperCase() : "不明";
  }

  function submissionCatalogContext() {
    const path = location.pathname || (location.href || "").split(/[?#]/)[0];
    return path.replace(/\/u\/\d+(?=\/)/i, "/u/*");
  }

  function ensureSubmissionCatalogContext() {
    const context = submissionCatalogContext();
    if (state.submissionCatalogContext === context) return;
    state.submissionCatalogContext = context;
    state.submissionCatalog = [];
  }

  function localPdfUrl(value) {
    return typeof value === "string" && /^http:\/\/127\.0\.0\.1:18765\/file\/[a-f0-9]{24}\.pdf$/i.test(value)
      ? value
      : "";
  }

  function submissionCatalogKey(file = {}) {
    const student = String(file.studentKey || file.studentId || (file.studentSeq ? `seq:${file.studentSeq}` : file.studentName || "unknown-student"));
    // 共有リンクはファイル番号を持たないため、URLで見分ける。名前で見分けると、
    // 同じ提出者の複数リンクが1件にまとまってしまう。
    const identity = file.expectedFileId
      || file.fileId
      || (file.kind === "link" && file.sourceUrl ? `url:${file.sourceUrl}` : "")
      || (file.kind === "no-attachment" ? "no-attachment" : "")
      || normalizedFileName(file.fileName || "")
      || "unknown-file";
    return `${student}|${identity}`;
  }

  function sourceUrlForFile(file) {
    if (file?.sourceUrl && /^https?:\/\//i.test(file.sourceUrl)) return file.sourceUrl;
    const matched = findSubmissionAttachments().find((item) => sameFile(item, file));
    if (matched?.sourceUrl) return matched.sourceUrl;
    const frames = [...document.querySelectorAll("iframe[src]")];
    return frames
      .map((frame) => frame.src || "")
      .find((value) => {
        if (!value || !/(?:drive|docs)\.google\.com/i.test(value)) return false;
        if (file?.expectedFileId && parseDriveId(value) === file.expectedFileId) return true;
        return file?.expectedGoogleType === googleTypeOfUrl(value);
      }) || "";
  }

  function scheduleSubmissionCatalogSave() {
    if (!state.submissionCatalogLoaded || !state.submissionCatalogContext) return;
    clearTimeout(state.submissionCatalogSaveTimer);
    state.submissionCatalogSaveTimer = setTimeout(() => {
      if (!contextAvailable()) return;
      const stored = { ...(state.submissionCatalogStorage || {}) };
      stored[state.submissionCatalogContext] = state.submissionCatalog
        .slice(-SUBMISSION_CATALOG_MAXIMUM)
        .map((entry) => ({
          studentKey: entry.studentKey || "",
          studentName: entry.studentName || "",
          studentSeq: entry.studentSeq || 0,
          fileSeq: entry.fileSeq || 0,
          fileCount: entry.fileCount || 0,
          fileName: entry.fileName || "提出物",
          fileType: fileTypeLabel(entry),
          kind: entry.kind || "unknown",
          expectedName: entry.expectedName || entry.fileName || "",
          expectedFileId: entry.expectedFileId || "",
          expectedGoogleType: entry.expectedGoogleType || "",
          sourceUrl: entry.sourceUrl || "",
          cachedPdfUrl: localPdfUrl(entry.cachedPdfUrl || entry.pdfUrl),
          pageCount: entry.pageCount || null,
          status: entry.status || "available"
        }));
      const contexts = Object.entries(stored).slice(-SUBMISSION_CATALOG_CONTEXT_MAXIMUM);
      state.submissionCatalogStorage = Object.fromEntries(contexts);
      saveSetting({ [SUBMISSION_CATALOG_STORAGE_KEY]: state.submissionCatalogStorage });
      state.submissionCatalogSaveTimer = null;
    }, 250);
  }

  function mergeSubmissionCatalog(entries = [], { persist = true } = {}) {
    ensureSubmissionCatalogContext();
    for (const raw of entries) {
      if (!raw || (!raw.fileName && !raw.sourceUrl)) continue;
      const entry = {
        ...raw,
        studentName: raw.studentName || raw.studentLabel || "",
        fileName: raw.fileName || "提出物",
        kind: raw.kind || "unknown",
        status: raw.status
          || (raw.kind === "link" ? "link" : "")
          || (raw.kind === "no-attachment" ? "no-attachment" : "")
          || (raw.kind === "unknown" ? "unsupported" : "available"),
        sourceUrl: raw.sourceUrl || raw.fileUrl || "",
        cachedPdfUrl: localPdfUrl(raw.cachedPdfUrl || raw.pdfUrl),
        pageCount: raw.pageCount || null
      };
      entry.fileType = fileTypeLabel(entry);
      const key = submissionCatalogKey(entry);
      const index = state.submissionCatalog.findIndex((item) => submissionCatalogKey(item) === key);
      if (index < 0) {
        state.submissionCatalog.push(entry);
        continue;
      }
      const previous = state.submissionCatalog[index];
      const merged = { ...previous, ...entry };
      for (const field of ["studentName", "sourceUrl", "expectedFileId", "expectedName", "expectedGoogleType", "kind", "fileType", "cachedPdfUrl", "pageCount"]) {
        if (!entry[field] && previous[field]) merged[field] = previous[field];
      }
      merged.fileType = fileTypeLabel(merged);
      state.submissionCatalog[index] = merged;
    }
    if (persist) scheduleSubmissionCatalogSave();
  }

  async function loadSubmissionCatalog() {
    if (!contextAvailable()) return;
    ensureSubmissionCatalogContext();
    try {
      const stored = await loadSettings([SUBMISSION_CATALOG_STORAGE_KEY]);
      state.submissionCatalogStorage = stored[SUBMISSION_CATALOG_STORAGE_KEY]
        && typeof stored[SUBMISSION_CATALOG_STORAGE_KEY] === "object"
        ? stored[SUBMISSION_CATALOG_STORAGE_KEY]
        : {};
      const savedEntries = state.submissionCatalogStorage[state.submissionCatalogContext];
      if (Array.isArray(savedEntries)) mergeSubmissionCatalog(savedEntries, { persist: false });
    } catch (error) {
      state.submissionCatalogStorage = {};
    } finally {
      state.submissionCatalogLoaded = true;
      syncSubmissionCatalogFromLedger();
      if (isSubmissionView()) syncCurrentSubmissionCatalog(listSubmissionFiles());
      sendViewerControls();
    }
  }

  function syncSubmissionCatalogFromLedger() {
    if (!Array.isArray(progress.ledger) || progress.ledger.length === 0) return;
    mergeSubmissionCatalog(progress.ledger.map((entry) => ({
      ...entry,
      studentName: entry.studentName || entry.studentLabel || "",
      sourceUrl: entry.sourceUrl || entry.fileUrl || "",
      expectedFileId: entry.expectedFileId || entry.fileId || "",
      expectedGoogleType: entry.expectedGoogleType || "",
      cachedPdfUrl: entry.cachedPdfUrl || entry.pdfUrl || "",
      status: entry.status === "ok" ? "available" : (entry.status || "unavailable")
    })));
  }

  function syncCurrentSubmissionCatalog(files = []) {
    if (!isSubmissionView() || !files.length) return;
    const studentKey = getStudentKey();
    if (!studentKey) return;
    const studentName = studentDisplayName(getStudentLabel());
    mergeSubmissionCatalog(files.map((file, index) => ({
      ...file,
      studentKey,
      studentName,
      fileSeq: index + 1,
      fileCount: files.length,
      sourceUrl: sourceUrlForFile(file)
    })));
  }

  function rememberDisplayedPdf(pdfUrl, fileName, pageCount) {
    const cachedPdfUrl = localPdfUrl(pdfUrl);
    if (!cachedPdfUrl || !getStudentKey()) return;
    const current = state.activeFile || currentDisplayedFileInfo() || {};
    mergeSubmissionCatalog([{
      ...current,
      studentKey: getStudentKey(),
      studentName: studentDisplayName(getStudentLabel()),
      fileName: fileName || current.fileName || "提出物",
      expectedFileId: current.expectedFileId || current.id || findDisplayedFileId(),
      cachedPdfUrl,
      pageCount: pageCount || null,
      status: "available"
    }]);
  }

  // 届いたPDFを捨てるかどうかは「提出者が変わったか」だけで決める。
  // ファイル名はClassroomの描画途中で二重連結や省略が起き、要求時と
  // 受信時で一致しないことがある。名前まで含めて突き合わせると、
  // 同じ提出者の正しいPDFまで破棄され、画面が真っ黒のまま止まる。
  function sameSubmissionStudent(submissionKey) {
    if (!submissionKey) return true;
    const currentStudent = getStudentKey();
    if (!currentStudent) return true;
    return submissionKey.split("|")[0] === currentStudent;
  }

  function findSubmissionButton(direction) {
    // Classroomの新しいUIでは data-focus-id="next" / "previous" が付与されている
    const explicitButton = document.querySelector(`[data-focus-id="${direction}"]`);
    if (explicitButton && visible(explicitButton)) return explicitButton;

    const labelPattern = direction === "next"
      ? /^(?:次|次の(?:生徒|学生|ユーザー|提出者)(?:を選択)?|Select next student|Next student|Next)(?:[:：\s]|$)/i
      : /^(?:前|前の(?:生徒|学生|ユーザー|提出者)(?:を選択)?|Select previous student|Previous student|Previous)(?:[:：\s]|$)/i;
    return [...document.querySelectorAll("button, [role='button'], [role='link'], [aria-label], [title], [data-tooltip]")].find((element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 250 || rect.width > 120 || rect.height > 120) return false;
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
    let pausedMilliseconds = 0;
    while (Date.now() - startedAt - pausedMilliseconds < timeoutMs) {
      const pauseStartedAt = Date.now();
      if (!await waitForPreparationVisibility()) return false;
      pausedMilliseconds += Date.now() - pauseStartedAt;
      if (Date.now() - startedAt - pausedMilliseconds >= timeoutMs) return false;
      if (isSubmissionView()) return true;
      await wait(250);
    }
    return false;
  }

  // 提出者が変わっても、Classroomはしばらく前の提出物を表示したままになる。
  // 学生IDの変化後に提出状態が安定するまで待ち、ファイルIDが取れる場合だけ
  // 前の提出物が残っていないことの補助確認に使う。
  function submissionStateKind(fileState = null) {
    if (!fileState || fileState.waiting) return "";
    return fileState.noAttachment === true ? "no-attachment" : "attachment";
  }

  // 学生が変わったことと、その学生の提出状態が安定したことを切替完了の軸にする。
  // ファイルIDは、古い提出物が残ったままの誤読を防ぐ補助情報としてだけ使う。
  function submissionChangeReady({
    studentChanged = false,
    fileState = null,
    previousFileId = "",
    displayedFileId = "",
    studentChangedForMs = 0,
    noAttachmentForMs = 0
  } = {}) {
    if (!studentChanged) return false;
    const stateKind = submissionStateKind(fileState);
    if (!stateKind) return false;
    if (stateKind === "no-attachment") return noAttachmentForMs >= NO_ATTACHMENT_CONFIRM_MS;
    if (displayedFileId && displayedFileId !== previousFileId) return true;
    if (displayedFileId && previousFileId && displayedFileId === previousFileId) return false;
    return studentChangedForMs >= NO_ATTACHMENT_CONFIRM_MS;
  }

  async function waitForSubmissionChange(previousKey, timeoutMs = 20000, previousFileId = "") {
    const startedAt = Date.now();
    let pausedMilliseconds = 0;
    let studentChangedAt = 0;
    let noAttachmentSince = 0;
    while (Date.now() - startedAt - pausedMilliseconds < timeoutMs) {
      const pauseStartedAt = Date.now();
      if (!await waitForPreparationVisibility()) return false;
      pausedMilliseconds += Date.now() - pauseStartedAt;
      if (Date.now() - startedAt - pausedMilliseconds >= timeoutMs) return false;
      const currentKey = navigationStudentKey();
      const studentChanged = Boolean(currentKey) && currentKey !== previousKey;
      const fileState = inspectSubmissionFile();
      if (studentChanged) {
        if (!studentChangedAt) studentChangedAt = Date.now();
        // 未提出者には新しいDriveファイルIDが存在しない。直前の提出済み学生の
        // ファイルIDと違うことを待つと必ずタイムアウトするため、「添付なし」の
        // 表示が一定時間続いた時点で学生切替は完了したものとして次へ進める。
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
          noAttachmentForMs: noAttachmentSince ? Date.now() - noAttachmentSince : 0
        })) return true;
      }
      await wait(150);
    }
    return false;
  }

  function localWait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // 拡張機能が裏で再読み込み・更新されたタブでは、chrome.runtime.sendMessageが
  // Promiseを返さず同期的に例外を投げる。呼び出し側ごとにtry/catchを書き忘れると
  // そこで処理全体が止まって画面が固まって見えるため、ここでまとめて吸収する。
  function safeSendMessage(message) {
    if (!contextAvailable()) return Promise.resolve({ ok: false, contextInvalidated: true });
    try {
      return chrome.runtime.sendMessage(message);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // 拡張機能を更新・再読み込みすると、既に開いていたページに残った
  // このスクリプトは拡張本体から切り離される（chrome.runtime.id が消える）。
  // 画面上のボタンはそのまま残るのに、押しても本体へ届かないので
  // 「まったく反応しない」状態になる。表示中のPDFも前の提出者のまま固まる。
  function extensionContextLost() {
    try {
      return !(chrome && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return true;
    }
  }

  // 更新で切り離された古いスクリプトは、後から届くClassroomのDOM更新や
  // 変換完了を受け取れない。各タイマーを個別に残すと同じ例外が何度も出るため、
  // ここで一度だけ監視・待機をまとめて止める。
  function contextAvailable() {
    if (!state.contextInvalidated && !extensionContextLost()) return true;
    state.contextInvalidated = true;
    clearTimeout(state.timer);
    clearTimeout(state.busyWatchdog);
    clearInterval(state.preparationTimer);
    clearInterval(state.progressTicker);
    clearInterval(state.watchdogTimer);
    clearInterval(state.contextWatcher);
    state.mutationObserver?.disconnect();
    resolvePreparationVisibilityWaiters(false);
    return false;
  }

  // 切り離された状態で操作されたときは、黙って何もしないのではなく
  // 「なぜ効かないのか」と「どうすれば直るのか」をそのまま画面に出す。
  function reportContextLostIfNeeded() {
    if (!extensionContextLost()) return false;
    setStatus("この画面は拡張機能の更新前に開かれたため、操作を受け取れません。Classroomのタブを再読み込み（F5）してください。", "error");
    return true;
  }

  // 設定の保存は「できたら嬉しい」程度の処理で、失敗しても操作は続けられる。
  // 拡張機能を更新した直後の古いタブでは chrome.storage 自体が切り離され、
  // ここが例外を投げてコンソールに赤いエラーが出る。保存の失敗で操作を
  // 止めないよう、この関数を通してまとめて受け止める。
  // 設定の読み出しも、切り離されたタブでは同期的に例外を投げる。
  // 読めなかった場合は既定値のまま動かし、操作自体は止めない。
  function loadSettings(keys) {
    if (!contextAvailable()) return Promise.resolve({});
    try {
      const loading = chrome.storage.local.get(keys);
      return loading && typeof loading.then === "function" ? loading : Promise.reject(new Error("設定を読み取れません。"));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function saveSetting(values) {
    if (!contextAvailable()) return;
    try {
      const saving = chrome.storage.local.set(values);
      if (saving && typeof saving.catch === "function") saving.catch(() => undefined);
    } catch (error) {
      // 切り離されたタブでは保存できない。再読み込みの案内は操作側で出す。
    }
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
      try {
        safeSendMessage({ type: "cwr-sleep", ms: milliseconds }).then(finish, () => undefined);
      } catch (error) {
        // Ignore extension context invalidated error
      }
    });
  }

  function submissionButtonDisabled(button) {
    return button.disabled || button.getAttribute("aria-disabled") === "true";
  }

  async function waitForSubmissionButton(direction, timeoutMs = SUBMISSION_BUTTON_WAIT_MS) {
    const startedAt = Date.now();
    let pausedMilliseconds = 0;
    while (Date.now() - startedAt - pausedMilliseconds < timeoutMs) {
      const pauseStartedAt = Date.now();
      if (!await waitForPreparationVisibility()) return null;
      pausedMilliseconds += Date.now() - pauseStartedAt;
      if (Date.now() - startedAt - pausedMilliseconds >= timeoutMs) return null;
      const button = findSubmissionButton(direction);
      if (button) return button;
      await wait(250);
    }
    return null;
  }

  async function waitForSubmissionFile(timeoutMs = 20000) {
    const startedAt = Date.now();
    let pausedMilliseconds = 0;
    let noAttachmentSince = 0;
    while (Date.now() - startedAt - pausedMilliseconds < timeoutMs) {
      const pauseStartedAt = Date.now();
      if (!await waitForPreparationVisibility()) return null;
      pausedMilliseconds += Date.now() - pauseStartedAt;
      if (Date.now() - startedAt - pausedMilliseconds >= timeoutMs) return null;
      const fileState = inspectSubmissionFile();
      if (fileState && !fileState.waiting) {
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
    return inspectSubmissionFile()?.noAttachment ? { noAttachment: true } : null;
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

  const PREPARATION_BACKGROUND_PAUSE_MESSAGE = "Classroomタブがバックグラウンドのため一時停止しています。Classroomタブを表示すると自動的に再開します。";

  function preparationDocumentState() {
    return {
      visibilityState: document.visibilityState,
      hidden: document.hidden === true,
      hasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : false
    };
  }

  function preparationDocumentVisible() {
    const visibility = preparationDocumentState();
    // hasFocus() は別ウィンドウを前面にしただけでも false になるため、
    // Classroomタブ自体が背景化した判定には使わない。復帰通知には使う。
    return visibility.visibilityState === "visible" && !visibility.hidden;
  }

  function resolvePreparationVisibilityWaiters(value) {
    const waiters = state.preparationVisibilityWaiters.splice(0);
    for (const resolve of waiters) resolve(value);
  }

  function pausePreparationForBackground() {
    if (!state.isPreparationTab || isPreparationFinished() || preparationDocumentVisible()) return;
    setPreparationProgress({
      paused: true,
      delayed: false,
      stalled: false,
      detailText: PREPARATION_BACKGROUND_PAUSE_MESSAGE
    });
  }

  function waitForPreparationVisibility() {
    if (!state.isPreparationTab || isPreparationFinished() || preparationDocumentVisible()) {
      return Promise.resolve(true);
    }
    pausePreparationForBackground();
    return new Promise((resolve) => {
      state.preparationVisibilityWaiters.push(resolve);
      if (state.prepareCancelled || state.contextInvalidated) resolvePreparationVisibilityWaiters(false);
    });
  }

  function resumePreparationAfterForeground() {
    if (!state.isPreparationTab || isPreparationFinished() || !preparationDocumentVisible()) return;
    if (progress.paused) {
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

  function preparationNote() {
    if (isPreparationFinished()) {
      return state.isPreparationTab
        ? "このタブは閉じても構いません。準備した表示用PDFは採点タブでそのまま使えます。"
        : "学生を切り替えると、準備済みのPDFがすぐ表示されます。";
    }
    if (progress.stalled) {
      return "Classroomの画面更新を待っています。正しい学生・ファイルを確認できるまで、30秒ごとに自動で再試行します。";
    }
    if (progress.paused) return PREPARATION_BACKGROUND_PAUSE_MESSAGE;
    if (progress.delayed) {
      return "準備タブは背面ですが、正しい学生・ファイルを確認しながら自動で再試行しています。";
    }
    return state.isPreparationTab
      ? "このタブは自動で操作します。完了まで触らずにお待ちください。終わると採点タブへ自動で戻ります。"
      : "準備専用タブで処理中です。この採点タブはそのまま採点に使えます。";
  }

  function applyPreparationPosition(panel) {
    if (!panel) return;
    const position = state.preparationPosition;
    if (!position || !Number.isFinite(position.xRatio) || !Number.isFinite(position.yRatio)) return;
    panel.style.right = "auto";
    panel.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - 12, position.xRatio * window.innerWidth)))}px`;
    panel.style.top = `${Math.round(Math.max(12, Math.min(window.innerHeight - 12, position.yRatio * window.innerHeight)))}px`;
  }

  function attachPreparationDrag(panel) {
    const grip = panel.querySelector("#cwr-preparation-drag");
    if (!grip) return;
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const left = rect.left;
      const top = rect.top;
      grip.setPointerCapture?.(event.pointerId);
      panel.classList.add("cwr-preparation-dragging");
      const move = (moveEvent) => {
        const nextLeft = Math.max(12, Math.min(window.innerWidth - Math.min(rect.width, 48), left + moveEvent.clientX - startX));
        const nextTop = Math.max(12, Math.min(window.innerHeight - Math.min(rect.height, 48), top + moveEvent.clientY - startY));
        state.preparationPosition = {
          xRatio: nextLeft / Math.max(1, window.innerWidth),
          yRatio: nextTop / Math.max(1, window.innerHeight)
        };
        panel.style.right = "auto";
        panel.style.left = `${Math.round(nextLeft)}px`;
        panel.style.top = `${Math.round(nextTop)}px`;
      };
      const end = () => {
        panel.classList.remove("cwr-preparation-dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        if (state.preparationPosition) saveSetting({ cwrPreparationPosition: state.preparationPosition });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
    });
  }

  function ensurePreparationPanel() {
    if (state.preparationPanelHidden) return null;
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
          <button id="cwr-preparation-drag" type="button" title="パネルをドラッグして移動" aria-label="パネルをドラッグして移動"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg></button>
          <button id="cwr-preparation-compact" type="button" title="最小化" aria-label="最小化" aria-pressed="false"><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg></button>
        </div>
        <p id="cwr-preparation-count">準備を開始しています…</p>
        <div id="cwr-preparation-bar" aria-hidden="true"><span></span></div>
        <p id="cwr-preparation-detail">先頭の提出者を確認中です。</p>
        <p id="cwr-preparation-elapsed">経過 0秒</p>
        <p id="cwr-preparation-note"></p>
        <div id="cwr-preparation-ledger-wrap">
          <button id="cwr-preparation-ledger-toggle" type="button" aria-expanded="false">準備した提出物の一覧</button>
          <div id="cwr-preparation-ledger-list" hidden></div>
        </div>
        <div id="cwr-preparation-actions">
          <button id="cwr-preparation-cancel" type="button">現在の処理後に中止</button>
          <button id="cwr-preparation-focus" type="button">準備タブを開く</button>
        </div>
      </div>
    `;
    panel.querySelector("#cwr-preparation-cancel").addEventListener("click", handlePreparationCancelClick);
    panel.querySelector("#cwr-preparation-focus").addEventListener("click", handlePreparationFocusClick);
    panel.querySelector("#cwr-preparation-ledger-toggle").addEventListener("click", () => {
      state.preparationLedgerExpanded = !state.preparationLedgerExpanded;
      renderPreparation();
    });
    panel.querySelector("#cwr-preparation-compact").addEventListener("click", () => {
      state.preparationCompact = !state.preparationCompact;
      saveSetting({ cwrPreparationCompact: state.preparationCompact });
      renderPreparation();
    });
    document.body.appendChild(panel);
    applyPreparationPosition(panel);
    attachPreparationDrag(panel);
    return panel;
  }

  function closePreparationPanel() {
    clearInterval(state.preparationTimer);
    state.preparationTimer = null;
    state.preparationPanelHidden = true;
    document.getElementById("cwr-preparation")?.remove();
    updateUiLabels();
  }

  function showPreparationPanel() {
    state.preparationPanelHidden = false;
    ensurePreparationPanel();
    renderPreparation();
    updateUiLabels();
  }

  function handlePreparationCancelClick() {
    if (isPreparationFinished()) {
      closePreparationPanel();
      return;
    }
    if (state.isPreparationTab && state.preparing) {
      state.prepareCancelled = true;
      resolvePreparationVisibilityWaiters(false);
      setPreparationProgress({ detailText: "現在の1件が終わったら中止します。", cancelRequested: true });
      return;
    }
    setPreparationProgress({ detailText: "準備専用タブへ中止を伝えています。", cancelRequested: true });
    safeSendMessage({ type: "cwr-cancel-bulk-preparation" }).then((response) => {
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
    safeSendMessage({ type }).then((response) => {
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
    panel.classList.toggle("cwr-preparation-paused", Boolean(progress.paused));
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
    cancelButton.textContent = finished ? "通知を閉じる" : "現在の処理後に中止";
    cancelButton.disabled = running && progress.cancelRequested === true;

    const focusButton = panel.querySelector("#cwr-preparation-focus");
    focusButton.hidden = finished || !(progress.remote || state.isPreparationTab);
    focusButton.textContent = state.isPreparationTab ? "採点タブに戻る" : "準備タブを開く";
    focusButton.classList.toggle("cwr-preparation-urgent", Boolean(progress.stalled));

    const compactButton = panel.querySelector("#cwr-preparation-compact");
    compactButton.setAttribute("title", state.preparationCompact ? "展開" : "最小化"); compactButton.setAttribute("aria-label", state.preparationCompact ? "展開" : "最小化");
    compactButton.setAttribute("aria-pressed", String(state.preparationCompact));

    renderLedger(panel);

    // 経過時間は動いている間だけ数える。
    if (finished) {
      clearInterval(state.preparationTimer);
      state.preparationTimer = null;
    } else if (!state.preparationTimer) {
      state.preparationTimer = setInterval(renderPreparation, 1000);
    }
  }

  // 同じファイル名の学生がいても取り違えていないか確認できるよう、
  // 提出者・ファイルごとの通し番号つきで一覧を残す。
  function renderLedger(panel) {
    const entries = progress.ledger || [];
    const toggle = panel.querySelector("#cwr-preparation-ledger-toggle");
    const list = panel.querySelector("#cwr-preparation-ledger-list");
    toggle.hidden = entries.length === 0;
    toggle.textContent = `準備した提出物の一覧（${entries.length}件）`;
    toggle.setAttribute("aria-expanded", String(state.preparationLedgerExpanded));
    list.hidden = !state.preparationLedgerExpanded || entries.length === 0;

    // 新しい一括準備が始まって件数が減っていたら、前回分の行を作り直す。
    if (entries.length < list.childElementCount) list.replaceChildren();
    for (let index = list.childElementCount; index < entries.length; index += 1) {
      const entry = entries[index];
      const row = document.createElement("div");
      row.className = "cwr-preparation-ledger-row";
      row.dataset.status = ["ok", "link", "no-attachment"].includes(entry.status) ? entry.status : "failed";

      const seq = document.createElement("span");
      seq.className = "cwr-preparation-ledger-seq";
      seq.textContent = `No.${entry.seq}`;

      const student = document.createElement("span");
      student.className = "cwr-preparation-ledger-student";
      student.textContent = `${entry.studentSeq}人目 ${entry.studentLabel || "(名前を取得できず)"}`;

      const file = document.createElement("span");
      file.className = "cwr-preparation-ledger-file";
      file.textContent = entry.fileCount > 1
        ? `ファイル${entry.fileSeq}/${entry.fileCount}：${entry.fileName}`
        : entry.fileName;

      row.append(seq, student, file);

      if (entry.status === "ok" && entry.pdfUrl) {
        const link = document.createElement("a");
        link.href = entry.pdfUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "cwr-preparation-ledger-link";
        link.textContent = entry.cached ? "PDFを開く（再利用）" : "PDFを開く";
        row.append(link);
      } else if (entry.status === "link") {
        // 共有リンクは取り込めないが、その場で開けるようにしておく。
        if (entry.sourceUrl) {
          const link = document.createElement("a");
          link.href = entry.sourceUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.className = "cwr-preparation-ledger-link";
          link.textContent = "共有リンクを開く";
          row.append(link);
        } else {
          const note = document.createElement("span");
          note.className = "cwr-preparation-ledger-note";
          note.textContent = "共有リンクの提出";
          row.append(note);
        }
      } else if (entry.status === "no-attachment") {
        const note = document.createElement("span");
        note.className = "cwr-preparation-ledger-note";
        note.textContent = "添付ファイルを確認できず";
        row.append(note);
      } else {
        const failed = document.createElement("span");
        failed.className = "cwr-preparation-ledger-failed";
        failed.textContent = "準備できず";
        row.append(failed);
      }
      list.appendChild(row);
    }
  }

  function endRemoteTracking() {
    state.remotePreparing = false;
    stopStallWatchdog();
    updateUiLabels();
  }

  function setPreparationProgress(patch = {}) {
    Object.assign(progress, patch);
    syncSubmissionCatalogFromLedger();
    if (!progress.startedAt) progress.startedAt = Date.now();
    if (!state.preparationPanelHidden) {
      ensurePreparationPanel();
      renderPreparation();
    }
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
    try {
      safeSendMessage({
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
          delayed: progress.delayed === true,
          stalled: progress.stalled === true,
          paused: progress.paused === true,
          cancelRequested: progress.cancelRequested === true,
          ledger: progress.ledger
        }
      }).catch(() => undefined);
    } catch (error) {
      if (error.message && error.message.includes("Extension context invalidated")) {
        stopProgressTicker();
      }
    }
  }

  function finishPreparation(title, countText, detailText, status = "done") {
    stopProgressTicker();
    setPreparationProgress({
      phase: status,
      title,
      countText,
      detailText,
      delayed: false,
      stalled: false,
      paused: false,
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
      progress.delayed = false;
      progress.detailText = "準備専用タブからの進捗を待っています。復旧すれば自動で表示を更新します。";
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
      delayed: running && message.delayed === true,
      stalled: running && message.stalled === true,
      paused: running && message.paused === true,
      phase: running ? "running" : message.status,
      title: message.title || progress.title,
      countText: message.countText || progress.countText,
      detailText: message.detailText || progress.detailText,
      done: message.done ?? progress.done,
      skipped: message.skipped ?? progress.skipped,
      current: message.current ?? progress.current,
      startedAt: message.startedAt || progress.startedAt,
      cancelRequested: message.cancelRequested === true,
      ledger: message.ledger || progress.ledger
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
    state.preparationPanelHidden = false;
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
      paused: false,
      cancelRequested: false
    });
    startStallWatchdog();
    try {
      const response = await safeSendMessage({ type: "cwr-start-bulk-preparation" });
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
  async function moveSubmission(direction, transition = null) {
    if (!contextAvailable()) return { status: "stuck", transition };
    if (!await waitForPreparationVisibility()) return { status: "stuck", transition };
    // すでに押した矢印の結果待ちでは、再クリックしない。遅れてDOMだけ
    // 更新された瞬間にもう一度押すと、1人飛ばしてしまうためである。
    if (transition) {
      if (!await waitForSubmissionChange(transition.before, BACKGROUND_RETRY_MS, transition.beforeFileId)) {
        return { status: "stuck", transition };
      }
      await wait(direction === "next" ? 650 : 180);
      return { status: "moved" };
    }
    const button = await waitForSubmissionButton(direction);
    // 「押せない状態で見つかった」なら本当に端。「見つからない」だけのときは、
    // 背面で止まっているか描き直し中の可能性があるので端と決めつけない。
    if (!button) return { status: document.hidden ? "stuck" : "missing" };
    if (submissionButtonDisabled(button)) return { status: "end" };
    const before = getStudentKey();
    // 一括準備でも、学生の番号だけでは切替完了とみなさない。Classroomは
    // URLを先に更新し、数秒間は前の学生のファイルを表示し続けることがある。
    // ここを確認しないと、2人目のPDFを3人目以降として繰り返し保存してしまう。
    const beforeFileId = findDisplayedFileId();
    button.click();
    const pendingTransition = { before, beforeFileId };
    if (!await waitForSubmissionChange(before, 20000, beforeFileId)) {
      return { status: "stuck", transition: pendingTransition };
    }
    await wait(direction === "next" ? 650 : 180);
    return { status: "moved" };
  }

  // 背面であることは停止理由ではない。Classroomが学生とファイルを入れ替える
  // まで、同じ移動を安全に確認し直す。前のファイルIDを必ず渡すため、再試行で
  // 別学生へ誤って進んだり、前の学生のPDFを保存したりしない。
  async function moveWithRecovery(direction) {
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
            detailText: "Classroomの画面更新を確認しました。準備を続けます。"
          });
        }
        return status;
      }

      if (status === "missing" && findSubmissionButton(direction === "next" ? "previous" : "next")) return "end";
      // クリック済みの遷移は、Classroomが遅れて更新する可能性があるため
      // そのまま保持する。遷移情報を捨てて同じ矢印を押し直すと、復帰時に
      // 学生を1人飛ばすため、確認に失敗した時点で安全に止める。
      if (status === "stuck" && (transition || result.transition)) return "stuck";
      transition = result.transition || null;
      retries += 1;
      const stalled = retries > BACKGROUND_RETRY_BEFORE_STALLED;
      setPreparationProgress({
        delayed: !stalled && document.hidden,
        stalled,
        detailText: stalled
          ? "Classroomの画面更新を待っています。正しい学生・ファイルを確認するため、30秒後に自動で再試行します。"
          : document.hidden
            ? `背面で画面更新を待っています（${retries}/${BACKGROUND_RETRY_BEFORE_STALLED}回目の自動再試行）。`
            : `画面更新を確認中です（${retries}/${BACKGROUND_RETRY_BEFORE_STALLED}回目の自動再試行）。`
      });
      await wait(stalled ? BACKGROUND_STALLED_RETRY_MS : BACKGROUND_RETRY_MS);
    }
    return "stuck";
  }

  async function waitForSubmissionFileWithRecovery(timeoutMs = 15000) {
    let retries = 0;
    while (!state.prepareCancelled && contextAvailable()) {
      const fileInfo = await waitForSubmissionFile(timeoutMs);
      if (fileInfo) {
        if (retries) setPreparationProgress({ delayed: false, stalled: false, detailText: "提出物を確認しました。準備を続けます。" });
        return fileInfo;
      }
      retries += 1;
      // 待ち続けても提出物が出てこない提出者がいる。無期限に再試行すると
      // 一括準備がそこで止まってしまうため、上限を決めて次へ進める。
      // 通常の提出物は1回目の確認で見つかるので、ここは速度に影響しない。
      if (retries > MAX_FILE_WAIT_RETRIES) {
        setPreparationProgress({
          delayed: false,
          stalled: false,
          detailText: "提出物を確認できませんでした。一覧に記録して次の提出者へ進みます。"
        });
        return null;
      }
      const stalled = retries > BACKGROUND_RETRY_BEFORE_STALLED;
      setPreparationProgress({
        delayed: !stalled && document.hidden,
        stalled,
        detailText: stalled
          ? "提出物の表示を待っています。正しいファイルを確認するため、30秒後に自動で再試行します。"
          : document.hidden
            ? `背面で提出物の表示を待っています（${retries}/${BACKGROUND_RETRY_BEFORE_STALLED}回目の自動再試行）。`
            : `提出物の表示を確認中です（${retries}/${BACKGROUND_RETRY_BEFORE_STALLED}回目の自動再試行）。`
      });
      await wait(stalled ? BACKGROUND_STALLED_RETRY_MS : BACKGROUND_RETRY_MS);
    }
    return null;
  }

  // 実行中は内訳を分けず「未準備」でまとめ、終了時の要約で対象外と失敗を分ける。
  function preparationCountText(done, notReady, current) {
    const base = done ? `${done}件を準備しました` : "準備中…";
    const currentPart = current ? `（${current}人目を処理中）` : "";
    const notReadyPart = notReady ? `・未準備 ${notReady}件` : "";
    return `${base}${notReadyPart}${currentPart}`;
  }

  async function prepareAllSubmissions({ dedicated = false, limit = 0, startAtCurrent = false } = {}) {
    if (!contextAvailable()) return;
    if (state.preparing) return;
    if (!await waitForSubmissionView()) {
      throw new Error("提出物を個別に開いてから一括準備を開始してください。");
    }
    state.preparing = true;
    state.dedicatedPreparation = dedicated;
    state.prepareCancelled = false;
    endDisplayRequest();
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
      delayed: false,
      stalled: false,
      paused: false,
      cancelRequested: false,
      ledger: []
    });
    startProgressTicker();

    let preparedCount = 0;
    let cachedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let linkCount = 0;
    let noAttachmentCount = 0;
    let forwardMoves = 0;
    const failedNames = [];
    const seen = new Set();
    const preparedDocumentKeys = new Set();

    try {
      if (!startAtCurrent) {
        updatePreparation("先頭の提出者へ移動中…", "提出者リストの最初まで戻っています。");
        for (let attempts = 0; attempts < 1000 && !state.prepareCancelled; attempts += 1) {
          if (await moveWithRecovery("previous") !== "moved") break;
          updatePreparation("先頭の提出者へ移動中…", `${attempts + 1}人分戻りました。`);
        }
      }

      updatePreparation("最初の提出物を確認中…", "Classroomのファイルプレビューを待っています。");
      const initialFileInfo = await waitForSubmissionFileWithRecovery(20000);
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
          : await waitForSubmissionFileWithRecovery(15000);
        const studentKey = getStudentKey();
        if (!studentKey || seen.has(studentKey)) break;
        seen.add(studentKey);

        // 1人が複数ファイルを出していることがあるので、全部まとめて準備する。
        const files = fileInfo && !fileInfo.unsupported && !fileInfo.noAttachment
          ? listSubmissionFiles(fileInfo.linkOnly ? undefined : fileInfo)
          : [];
        if (files.length) {
          const displayedIndex = Math.max(0, activeFileIndex(files));
          // 学生名だけで見分けがつかないことがあるため、提出者ごと・ファイルごとの
          // 通し番号を持つ一覧を作り、あとで画面から確認できるようにする。
          // 提出状況の表示が間に合っていないことがあるので、一度だけ待って取り直す。
          let studentLabelForLedger = studentDisplayName(getStudentLabel());
          if (!studentLabelForLedger) {
            await wait(300);
            studentLabelForLedger = studentDisplayName(getStudentLabel());
          }
          const addLedgerEntry = (fileIndex, file, extra) => {
            setPreparationProgress({
              ledger: [...progress.ledger, {
                seq: progress.ledger.length + 1,
                studentSeq: sequence,
                studentLabel: studentLabelForLedger,
                studentName: studentLabelForLedger,
                studentKey: getStudentKey(),
                fileSeq: fileIndex + 1,
                fileCount: files.length,
                fileName: file.fileName,
                kind: file.kind || "unknown",
                expectedName: file.expectedName || file.fileName || "",
                expectedFileId: file.expectedFileId || "",
                expectedGoogleType: file.expectedGoogleType || "",
                sourceUrl: file.sourceUrl || "",
                status: "failed",
                cached: false,
                pdfUrl: "",
                ...extra
              }]
            });
          };
          for (const [fileIndex, file] of files.entries()) {
            if (state.prepareCancelled) break;
            // 共有リンクの提出は取り込めない。失敗として数えず、一覧には
            // 「共有リンク」として残し、あとからリンクを開けるようにする。
            if (file.kind === "link") {
              linkCount += 1;
              addLedgerEntry(fileIndex, file, { status: "link" });
              setPreparationProgress({
                countText: preparationCountText(preparedCount + cachedCount, skippedCount + failedCount, sequence),
                detailText: `${file.fileName} は共有リンクの提出です。`,
                fileName: file.fileName
              });
              continue;
            }
            // 画面に出ている1件はそのまま使い、それ以外は番号があれば
            // 画面を切り替えずに取得する。番号が無いときだけ選択欄を操作する。
            const onScreen = fileIndex === displayedIndex;
            const preparedFile = onScreen || file.expectedFileId
              ? file
              : await selectSubmissionFile(file);
            if (!preparedFile) {
              failedCount += 1;
              failedNames.push(file.fileName);
              addLedgerEntry(fileIndex, file);
              continue;
            }
            const fileName = preparedFile.fileName;
            const submissionKey = getSubmissionKey(preparedFile);
            const ofFiles = files.length > 1 ? `（${fileIndex + 1}/${files.length}件目）` : "";
            setPreparationProgress({
              countText: preparationCountText(preparedCount + cachedCount, skippedCount + failedCount, sequence),
              detailText: `${fileName}${ofFiles} の準備済みPDFを確認しています。`,
              fileName
            });
            let response = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              response = await safeSendMessage({
                // 1件目は表示中のファイルなので、画面と突き合わせる確実な経路を使う。
                // 2件目以降は画面に出ていないため、ファイル番号を直接指定して取得する。
                type: preparedFile.expectedFileId && !onScreen ? "cwr-prepare-attachment" : "cwr-prepare-one",
                submissionKey,
                primary: onScreen,
                fileName,
                expectedName: preparedFile.expectedName || "",
                expectedFileId: preparedFile.expectedFileId || "",
                expectedGoogleType: preparedFile.expectedGoogleType || "",
                cacheIdentity: getCacheIdentity(preparedFile)
              });
              // 画面と突き合わせる1件目だけ、前の提出者と同じ結果なら画面更新待ちとみなす。
              const repeatedDocument = onScreen && response?.ok && preparedDocumentKeys.has(response.documentKey);
              if ((response?.ok && !repeatedDocument) || attempt === 2) break;
              response = repeatedDocument ? { ok: false, error: "画面更新を待っています。" } : response;
              await wait(900);
            }
            if (response?.ok) {
              preparedDocumentKeys.add(response.documentKey);
              if (response.cached) cachedCount += 1;
              else preparedCount += 1;
              setPreparationProgress({
                detailText: response.cached
                  ? `${fileName}${ofFiles} は準備済みPDFを再利用しています。`
                  : `${fileName}${ofFiles} のPDF準備が完了しました。`,
                fileName
              });
              addLedgerEntry(fileIndex, preparedFile, {
                status: "ok",
                cached: response.cached === true,
                pdfUrl: response.pdfUrl || ""
              });
            } else {
              if (/補助アプリ|Start-Reviewer|古い版|起動していません/.test(response?.error || "")) {
                addLedgerEntry(fileIndex, preparedFile);
                throw new Error(response.error);
              }
              failedCount += 1;
              failedNames.push(fileName);
              addLedgerEntry(fileIndex, preparedFile);
            }
          }
          // 画面を動かした場合だけ、元の表示へ戻す。
          if (files.length > 1 && !state.prepareCancelled && files.some((file) => !file.expectedFileId)) {
            await selectSubmissionFile(files[displayedIndex]);
          }
        } else {
          skippedCount += 1;
          // 添付が1件も無い提出者も一覧に残す。ここを飛ばすと、確認が
          // 必要な提出者だけが一覧から消えてしまう。
          let emptyStudentLabel = studentDisplayName(getStudentLabel());
          if (!emptyStudentLabel) {
            await wait(300);
            emptyStudentLabel = studentDisplayName(getStudentLabel());
          }
          noAttachmentCount += 1;
          setPreparationProgress({
            detailText: "添付ファイルを確認できませんでした。一覧に記録して次へ進みます。",
            ledger: [...progress.ledger, {
              seq: progress.ledger.length + 1,
              studentSeq: sequence,
              studentLabel: emptyStudentLabel,
              studentName: emptyStudentLabel,
              studentKey: getStudentKey(),
              fileSeq: 1,
              fileCount: 1,
              fileName: "添付ファイルを確認できません",
              kind: "no-attachment",
              expectedName: "",
              expectedFileId: "",
              expectedGoogleType: "",
              sourceUrl: "",
              status: "no-attachment",
              cached: false,
              pdfUrl: ""
            }]
          });
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
          break;
        }
        if (moved === "end") break;
        forwardMoves += 1;
        if (limit > 0 && seen.size >= limit) break;
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
        linkCount ? `共有リンク ${linkCount}件` : "",
        noAttachmentCount ? `添付なし ${noAttachmentCount}件` : "",
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
            ? `準備できるWord／PowerPoint／PDF／Google形式の提出物がありませんでした。${failedNote}`
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
      resolvePreparationVisibilityWaiters(false);
      updateUiLabels();
    }
  }

  // ============================================================
  // 提出物のZIP一括ダウンロード
  // 採点用の変換・表示とは別経路にする。ここで集めるのは「画面に出ている
  // 提出物の情報」だけで、取得とZIP作成は拡張機能側のページ（bulk-zip.html）
  // が行う。採点中の表示処理には手を入れない。
  // ============================================================
  const zipRun = {
    running: false,
    collecting: false,
    cancelled: false,
    phase: "idle",
    frame: null,
    framePromise: null,
    jobId: "",
    layout: "flat",
    tokenRule: "name-number",
    fileNameStyle: "with-original",
    rosterText: "",
    students: [],
    assignmentName: "",
    failures: [],
    summary: null,
    startedAt: 0,
    counts: { studentsDone: 0, studentsTotal: 0, filesDone: 0, filesFailed: 0, filesTotal: 0 },
    detail: "",
    title: "提出物の一括ダウンロード"
  };

  function zipStudentName(label) {
    let text = String(label || "");
    for (const word of ZIP_STATUS_WORDS) text = text.split(word).join(" ");
    return text.replace(/\s+/g, " ").trim();
  }

  function zipStatusOf(label) {
    const text = String(label || "");
    const found = ZIP_STATUS_WORDS.find((word) => text.endsWith(word))
      || ZIP_STATUS_WORDS.find((word) => text.includes(word));
    if (!found) return "";
    if (["割り当て済み", "Assigned", "Missing", "未提出"].includes(found)) return "未提出";
    return found;
  }

  // Classroomは提出者をURLでは base64、一覧では10進の番号で表す。
  // 同じ提出者だと確かめるため、10進へそろえてから比べる。
  function zipDecodeStudentId(value) {
    const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    if (!text) return "";
    try {
      const decoded = atob(text.padEnd(Math.ceil(text.length / 4) * 4, "="));
      return /^\d{4,}$/.test(decoded) ? decoded : "";
    } catch {
      return "";
    }
  }

  // 提出者の切替欄から、クラス全員と提出状態を読み取る。未提出の学生も
  // ここで分かるので、提出物の表示を待たずに次へ進める。
  function readClassroomRoster() {
    const roster = new Map();
    for (const node of document.querySelectorAll("[data-value]")) {
      const id = node.getAttribute("data-value") || "";
      if (!/^\d{6,}$/.test(id)) continue;
      if (node.getAttribute("aria-checked") === null && node.getAttribute("aria-selected") === null) continue;
      const label = textOf(node);
      if (!label || label.length > 220) continue;
      const name = zipStudentName(label);
      if (!name) continue;
      const entry = { studentId: id, studentName: name, status: zipStatusOf(label) || "提出済み" };
      const previous = roster.get(id);
      if (!previous || (!previous.status && entry.status)) roster.set(id, entry);
    }
    return [...roster.values()];
  }

  // 添付カードに出ている名前を読む。Classroomは
  // 「添付ファイル: Microsoft Word: レポート.docx」のような形で持っている。
  function zipAttachmentLabel(node) {
    let current = node;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      const title = current.getAttribute?.("title");
      if (title && title.length <= 160 && !/新しいウィンドウ|new window/i.test(title)) return title.trim();
      for (const source of labelSourcesOf(current)) {
        const attachment = String(source || "").match(/添付ファイル\s*[:：]\s*(?:[^:：]{1,40}\s*[:：]\s*)?(.{1,160})$/);
        if (attachment) return dedupeDoubledLabel(attachment[1].trim());
        const google = String(source || "").match(/Google\s*(?:ドキュメント|スプレッドシート|スライド|図形描画|フォーム|Docs?|Sheets?|Slides?|Drawings?|Forms?)\s*[:：]\s*(.{1,160})$/i);
        if (google) return dedupeDoubledLabel(google[1].trim());
      }
      current = current.parentElement;
    }
    return "";
  }

  // 採点表示では扱わないGoogle形式（スプレッドシート・図形描画・フォーム）は、
  // ここでZIP用にだけ拾う。既存の判定には手を入れない。
  function collectExtraGoogleAttachments() {
    const found = [];
    for (const node of document.querySelectorAll("a[href], [role='menuitem']")) {
      const url = fileUrlOf(node) || node.getAttribute?.("href") || "";
      const match = String(url).match(ZIP_GOOGLE_URL);
      if (!match) continue;
      const googleType = ZIP_GOOGLE_TYPES[match[1].toLowerCase()] || "";
      const label = zipAttachmentLabel(node) || textOf(node);
      if (!googleType) {
        // Googleフォームなどは取り込めない。開くためのURLとして残す。
        found.push({ kind: "link", fileName: (label || "Googleフォーム").slice(0, 160), sourceUrl: url });
        continue;
      }
      // ドキュメントとスライドは既存の判定で拾えるため、ここでは補助に留める。
      found.push({
        kind: `google-${googleType}`,
        googleType,
        fileId: match[2],
        fileName: (label || `Google${googleType}`).slice(0, 160),
        sourceUrl: url
      });
    }
    return found;
  }

  function zipFileIdentity(file) {
    if (file.fileId) return `id:${file.fileId}`;
    if (file.sourceUrl) return `url:${String(file.sourceUrl).trim().toLowerCase()}`;
    return `name:${normalizedFileName(file.fileName)}`;
  }

  // いま表示している提出者の添付を、ZIP用の形へそろえる。
  function zipFilesForCurrentStudent() {
    const files = [];
    const seen = new Set();
    const add = (file) => {
      if (!file || (!file.fileId && !file.sourceUrl)) return;
      const identity = zipFileIdentity(file);
      if (seen.has(identity)) return;
      seen.add(identity);
      files.push(file);
    };
    for (const file of listSubmissionFiles()) {
      if (file.kind === "no-attachment") continue;
      add({
        kind: file.kind || "",
        fileName: file.fileName || "提出物",
        fileId: file.expectedFileId || "",
        googleType: file.expectedGoogleType || "",
        sourceUrl: file.sourceUrl || sourceUrlForFile(file) || ""
      });
    }
    for (const extra of collectExtraGoogleAttachments()) add(extra);
    return files;
  }

  function setZipProgress(patch = {}) {
    // counts は一部だけ渡すことがある。Object.assign より先に前の値と混ぜて
    // おかないと、渡さなかった項目（総人数など）が消えてしまう。
    const counts = patch.counts ? { ...zipRun.counts, ...patch.counts } : zipRun.counts;
    Object.assign(zipRun, patch);
    zipRun.counts = counts;
    renderZipPanel();
  }

  async function zipMoveNext() {
    let transition = null;
    for (let attempt = 0; attempt < 4 && !zipRun.cancelled && contextAvailable(); attempt += 1) {
      const result = await moveSubmission("next", transition);
      if (result.status === "moved" || result.status === "end") return result.status;
      transition = result.transition || null;
      setZipProgress({ detail: `Classroomの画面更新を待っています（${attempt + 1}回目の再確認）。` });
      await wait(BACKGROUND_RETRY_MS);
    }
    return "stuck";
  }

  async function zipMovePrevious() {
    const result = await moveSubmission("previous", null);
    return result.status;
  }

  // Classroomを先頭から順にたどり、提出者ごとの添付情報を集める。
  // 取得やZIP作成はここでは行わない。
  async function collectZipSubmissions() {
    const roster = readClassroomRoster();
    const rosterById = new Map(roster.map((entry) => [entry.studentId, entry]));
    const collected = [];
    const seenKeys = new Set();
    const startStudentKey = getStudentKey();
    let forwardMoves = 0;
    let stopReason = "";

    setZipProgress({
      phase: "collect",
      counts: { studentsDone: 0, studentsTotal: roster.length, filesDone: 0, filesFailed: 0, filesTotal: 0 },
      detail: "先頭の提出者へ移動しています…"
    });
    for (let attempts = 0; attempts < 1000 && !zipRun.cancelled; attempts += 1) {
      if (await zipMovePrevious() !== "moved") break;
      setZipProgress({ detail: `先頭の提出者へ移動しています（${attempts + 1}人分）…` });
    }

    while (!zipRun.cancelled && contextAvailable()) {
      const studentKey = zipStudentKey();
      if (!studentKey) {
        stopReason = "student-key-missing";
        break;
      }
      if (seenKeys.has(studentKey)) {
        stopReason = "duplicate-student";
        break;
      }
      seenKeys.add(studentKey);
      const decimalId = zipDecodeStudentId(getStudentIdFromUrl());
      const rosterEntry = rosterById.get(decimalId) || null;
      const label = getStudentLabel();
      const studentName = rosterEntry?.studentName || zipStudentName(label) || `提出者${seenKeys.size}`;
      const status = rosterEntry?.status || zipStatusOf(label) || "";

      setZipProgress({
        counts: { studentsDone: seenKeys.size - 1, studentsTotal: Math.max(roster.length, seenKeys.size) },
        detail: `${studentName} の提出物を確認しています…`
      });

      let files = [];
      // 未提出と分かっている提出者では、表示を待たずに次へ進む。ここで
      // 待つと、未提出者の多いクラスで一括処理が何分も止まってしまう。
      if (!status || ZIP_SUBMITTED_STATUS.test(status)) {
        const fileState = await waitForSubmissionFile(status ? 12000 : 8000);
        if (fileState && !fileState.unsupported && !fileState.noAttachment) {
          files = zipFilesForCurrentStudent();
        } else if (fileState?.unsupported) {
          files = zipFilesForCurrentStudent();
        }
      }

      collected.push({
        studentKey,
        studentId: decimalId,
        studentName,
        status: status || (files.length ? "提出済み" : "未提出"),
        email: "",
        files
      });
      setZipProgress({
        counts: { studentsDone: seenKeys.size, filesTotal: collected.reduce((total, student) => total + student.files.length, 0) },
        detail: files.length
          ? `${studentName}：${files.length}件の提出物を確認しました。`
          : `${studentName}：対象の提出物はありません。`
      });

      if (zipRun.cancelled) break;
      const moved = await zipMoveNext();
      if (moved !== "moved") {
        stopReason = moved;
        break;
      }
      forwardMoves += 1;
    }

    if (!zipRun.cancelled && !stopReason && !contextAvailable()) stopReason = "context-lost";

    // 採点していた提出者の位置へ戻す。ここを省くと、一括処理のあとに
    // まったく違う提出者が開いたままになる。移動した回数ではなく、実際に
    // 元の提出者へ戻れたかどうかで判断する（1回でも取りこぼすとずれるため）。
    if (forwardMoves > 0 && startStudentKey) {
      setZipProgress({ detail: "元の提出者へ戻しています…" });
      for (let index = 0; index <= forwardMoves + 2; index += 1) {
        if (getStudentKey() === startStudentKey) break;
        if (await zipMovePrevious() !== "moved") break;
      }
    }
    return {
      collected,
      roster,
      completion: zipCollectionCompletion({
        rosterTotal: roster.length,
        collectedCount: collected.length,
        stopReason: zipRun.cancelled ? "cancelled" : stopReason
      })
    };
  }

  function ensureZipFrame() {
    if (zipRun.frame && document.body.contains(zipRun.frame)) return zipRun.framePromise;
    const frame = document.createElement("iframe");
    frame.id = "cwr-zip-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.title = "提出物のZIP作成";
    frame.src = chrome.runtime.getURL("bulk-zip.html");
    zipRun.framePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ZIP作成用のページを読み込めませんでした。Classroomを再読み込みしてください。")), 15000);
      const onReady = (event) => {
        if (event.source !== frame.contentWindow || event.data?.type !== "cwr-zip-ready") return;
        clearTimeout(timer);
        window.removeEventListener("message", onReady);
        resolve(frame);
      };
      window.addEventListener("message", onReady);
    });
    document.body.appendChild(frame);
    zipRun.frame = frame;
    return zipRun.framePromise;
  }

  // 取得が終わったら作業用フレームは片付ける。採点中のページに、使い終えた
  // 隠しフレームを残さない。再試行のときは作り直す。
  function releaseZipFrame() {
    zipRun.frame?.remove();
    zipRun.frame = null;
    zipRun.framePromise = null;
  }

  function zipFrameOrigin() {
    try {
      return new URL(chrome.runtime.getURL("bulk-zip.html")).origin;
    } catch {
      return "*";
    }
  }

  function postToZipFrame(message) {
    zipRun.frame?.contentWindow?.postMessage(message, zipFrameOrigin());
  }

  function splitRosterCsvLine(line) {
    const columns = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === "," && !quoted) {
        columns.push(value.trim());
        value = "";
      } else {
        value += character;
      }
    }
    columns.push(value.trim());
    return columns;
  }

  // 姓名間の空白、全半角、括弧内のローマ字表記をそろえ、完全一致だけに使う。
  // 姓だけ・部分一致では照合しない。
  function zipRosterNameKey(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[\s　]+/g, "")
      .toLocaleLowerCase();
  }

  function zipAbbreviatedNumber(studentNumber) {
    const number = String(studentNumber || "").normalize("NFKC").replace(/[\s　]+/g, "");
    if (!/^\d{6,15}$/.test(number)) return "";
    return `${number.slice(0, 2)}_${number.slice(-4)}`;
  }

  function zipDisplayIdentity(studentName) {
    const normalized = String(studentName || "").normalize("NFKC").replace(/[\s　]+/g, " ").trim();
    const matched = normalized.match(/^(\d{2}_\d{4,})\s+(.+)$/);
    return {
      abbreviatedNumber: matched?.[1] || "",
      nameKey: zipRosterNameKey(matched?.[2] || normalized)
    };
  }

  // 基本形式は「学籍番号,氏名」。Classroomの並び順へ合わせる必要はない。
  function parseRosterCsv(text) {
    const roster = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [studentNumber, studentName = ""] = splitRosterCsvLine(line);
      const number = String(studentNumber || "").normalize("NFKC").replace(/[\s　]+/g, "");
      const nameKey = zipRosterNameKey(studentName);
      const abbreviatedNumber = zipAbbreviatedNumber(number);
      if (!abbreviatedNumber) continue;
      roster.push({ studentNumber: number, studentName: String(studentName || "").trim(), abbreviatedNumber, nameKey });
    }
    return roster;
  }

  function applyRosterStudentNumbers(students, rosterText) {
    const roster = parseRosterCsv(rosterText);
    return students.map((student) => {
      const identity = zipDisplayIdentity(student.studentName);
      const candidates = roster.filter((entry) => entry.abbreviatedNumber === identity.abbreviatedNumber);
      if (candidates.length === 1) return { ...student, studentNumber: candidates[0].studentNumber };
      const matched = identity.nameKey
        ? candidates.filter((entry) => entry.nameKey && entry.nameKey === identity.nameKey)
        : [];
      if (matched.length === 1) return { ...student, studentNumber: matched[0].studentNumber };
      const rosterWarning = !roster.length
        ? "名簿CSVを読み取れないため、表示名を代替として使いました。"
        : candidates.length > 1
          ? "名簿CSVで同じ省略番号に複数の学籍番号があるため、表示名を代替として使いました。"
          : "名簿CSVと省略番号を照合できないため、表示名を代替として使いました。";
      return { ...student, rosterWarning };
    });
  }

  function downloadZipBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    // 取り消しが早すぎると保存が始まらないことがあるため、少し待って片付ける。
    setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 60000);
  }

  function handleZipFrameMessage(event) {
    if (!zipRun.frame || event.source !== zipRun.frame.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== "object" || !String(message.type || "").startsWith("cwr-zip-")) return;
    if (message.jobId && zipRun.jobId && message.jobId !== zipRun.jobId) return;

    if (message.type === "cwr-zip-progress") {
      setZipProgress({
        phase: message.phase === "packing" ? "packing" : "download",
        counts: {
          studentsDone: message.studentsDone ?? zipRun.counts.studentsDone,
          studentsTotal: message.studentsTotal ?? zipRun.counts.studentsTotal,
          filesDone: message.filesDone ?? 0,
          filesFailed: message.filesFailed ?? 0,
          filesTotal: message.filesTotal ?? zipRun.counts.filesTotal
        },
        detail: message.currentLabel || zipRun.detail
      });
      return;
    }
    if (message.type === "cwr-zip-done") {
      zipRun.running = false;
      zipRun.failures = Array.isArray(message.failures) ? message.failures : [];
      zipRun.summary = message.summary || null;
      downloadZipBlob(message.blob, message.fileName || "提出物.zip");
      releaseZipFrame();
      setZipProgress({
        phase: "done",
        title: message.retried ? "失敗した項目の再取得が終わりました" : "ZIPのダウンロードを開始しました",
        detail: `${message.fileName} をダウンロードフォルダーへ保存します。`
      });
      setStatus(`提出物ZIP（${message.fileName}）を作成しました。`, "ready");
      updateUiLabels();
      return;
    }
    if (message.type === "cwr-zip-cancelled") {
      zipRun.running = false;
      releaseZipFrame();
      setZipProgress({ phase: "cancelled", title: "一括ダウンロードを中止しました", detail: "作成中のZIPは保存していません。" });
      updateUiLabels();
      return;
    }
    if (message.type === "cwr-zip-error") {
      zipRun.running = false;
      releaseZipFrame();
      setZipProgress({ phase: "error", title: "ZIPを作成できませんでした", detail: message.message || "処理中にエラーが発生しました。" });
      setStatus(message.message || "ZIPを作成できませんでした。", "error");
      updateUiLabels();
    }
  }

  async function startZipDownload({ layout, tokenRule, fileNameStyle, rosterText }) {
    if (zipRun.running) return;
    if (reportContextLostIfNeeded()) return;
    if (state.preparing || state.remotePreparing) {
      setStatus("一括準備の実行中はZIPを作成できません。準備の完了後にお試しください。", "error");
      return;
    }
    if (!isSubmissionView()) {
      setStatus("提出物を個別に開いてから、ZIPの一括ダウンロードを実行してください。", "error");
      return;
    }
    zipRun.running = true;
    zipRun.cancelled = false;
    zipRun.collecting = true;
    zipRun.layout = layout;
    zipRun.tokenRule = tokenRule;
    zipRun.fileNameStyle = fileNameStyle;
    zipRun.rosterText = rosterText || "";
    zipRun.failures = [];
    zipRun.summary = null;
    zipRun.startedAt = Date.now();
    zipRun.jobId = `zip-${Date.now()}`;
    zipRun.assignmentName = zipAssignmentName();
    endDisplayRequest();
    removeOverlay();
    setZipProgress({ phase: "collect", title: "提出物を一括ダウンロード", detail: "提出者の一覧を確認しています…" });
    updateUiLabels();

    try {
      const { collected, completion } = await collectZipSubmissions();
      zipRun.collecting = false;
      if (zipRun.cancelled) {
        zipRun.running = false;
        releaseZipFrame();
        setZipProgress({ phase: "cancelled", title: "一括ダウンロードを中止しました", detail: "提出物の確認を途中で止めました。" });
        updateUiLabels();
        return;
      }
      if (!collected.length) {
        throw new Error("提出者を読み取れませんでした。Classroomの採点画面で提出物を1件開いてから、もう一度お試しください。");
      }
      if (!completion?.complete) throw new Error(completion?.message || "提出者の巡回が途中で止まったため、ZIP作成を中止しました。");
      zipRun.students = applyRosterStudentNumbers(collected, zipRun.rosterText);
      // 取得用のフレームは、Classroomの確認が終わってから読み込む。
      await ensureZipFrame();
      setZipProgress({ phase: "download", detail: "提出物の取得を開始しています…" });
      postToZipFrame({
        type: "cwr-zip-run",
        jobId: zipRun.jobId,
        assignmentName: zipRun.assignmentName,
        layout: zipRun.layout,
        tokenRule: zipRun.tokenRule,
        fileNameStyle: zipRun.fileNameStyle,
        authuser: zipAuthUser(),
        students: zipRun.students
      });
    } catch (error) {
      zipRun.running = false;
      zipRun.collecting = false;
      releaseZipFrame();
      setZipProgress({
        phase: "error",
        title: "ZIPを作成できませんでした",
        detail: error?.message || "処理中にエラーが発生しました。"
      });
      setStatus(error?.message || "ZIPを作成できませんでした。", "error");
      updateUiLabels();
    }
  }

  function retryFailedZipItems() {
    if (zipRun.running || !zipRun.failures.length || !zipRun.students.length) return;
    zipRun.running = true;
    zipRun.cancelled = false;
    zipRun.jobId = `zip-${Date.now()}`;
    setZipProgress({ phase: "download", title: "失敗した項目を再取得しています", detail: "取得できなかった提出物だけをもう一度取得します。" });
    updateUiLabels();
    postToZipFrame({
      type: "cwr-zip-run",
      jobId: zipRun.jobId,
      assignmentName: zipRun.assignmentName,
      layout: zipRun.layout,
      tokenRule: zipRun.tokenRule,
      fileNameStyle: zipRun.fileNameStyle,
      authuser: zipAuthUser(),
      students: zipRun.students,
      onlyKeys: zipRun.failures.map((failure) => failure.key)
    });
  }

  function cancelZipDownload() {
    if (!zipRun.running) {
      closeZipPanel();
      return;
    }
    zipRun.cancelled = true;
    setZipProgress({ detail: "中止しています。現在の取得が終わり次第停止します。" });
    postToZipFrame({ type: "cwr-zip-cancel", jobId: zipRun.jobId });
    // 取得側が応答しなくても、画面が「処理中」のまま残らないようにする。
    setTimeout(() => {
      if (!zipRun.running) return;
      zipRun.running = false;
      zipRun.collecting = false;
      setZipProgress({ phase: "cancelled", title: "一括ダウンロードを中止しました", detail: "作成中のZIPは保存していません。" });
      updateUiLabels();
    }, 20000);
  }

  // 課題名は採点画面の見出し（＝タブの題名）から取る。読めないときも
  // ZIPを作れるよう、既定の名前へ落とす。
  function zipAssignmentName() {
    const title = (document.title || "").replace(/\s*[-–—]\s*Classroom\s*$/i, "").trim();
    if (title && title.length <= 120) return title;
    const heading = [...document.querySelectorAll("h1, [role='heading']")]
      .map((node) => textOf(node))
      .find((text) => text && text.length <= 120);
    return heading || "提出物";
  }

  function zipAuthUser() {
    const match = location.href.match(/\/u\/(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : 0;
  }

  function closeZipPanel() {
    document.getElementById("cwr-zip-panel")?.remove();
  }

  function closeZipDialog() {
    document.getElementById("cwr-zip-dialog")?.remove();
  }

  function showZipDialog() {
    if (reportContextLostIfNeeded()) return;
    if (zipRun.running) {
      renderZipPanel();
      return;
    }
    closeZipDialog();
    const dialog = document.createElement("section");
    dialog.id = "cwr-zip-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "提出物を一括ダウンロード");
    dialog.innerHTML = `
      <div id="cwr-zip-card">
        <button id="cwr-zip-close" type="button" aria-label="閉じる">×</button>
        <h2>提出物を一括ダウンロード</h2>
        <p class="cwr-zip-note">この課題の提出物をまとめて1つのZIPにして保存します。課題名：<strong id="cwr-zip-assignment"></strong></p>
        <fieldset class="cwr-zip-group">
          <legend>整理方法</legend>
          <label><input type="radio" name="cwr-zip-layout" value="flat"> 全員のファイルを同じフォルダに保存</label>
          <label><input type="radio" name="cwr-zip-layout" value="per-student"> 学生ごとのフォルダに分けて保存</label>
        </fieldset>
        <fieldset class="cwr-zip-group">
          <legend>学生の識別名</legend>
          <label><input type="radio" name="cwr-zip-rule" value="name-number"> <span>表示名の先頭番号を使う<small>例：26_0001</small></span></label>
          <label><input type="radio" name="cwr-zip-rule" value="display-name"> <span>表示名をそのまま使う<small>例：26_0001 学生A（Student A）</small></span></label>
          <label><input type="radio" name="cwr-zip-rule" value="roster-number"> <span>名簿と照合して正式な学籍番号を使う<small>例：2610170001</small></span></label>
        </fieldset>
        <fieldset class="cwr-zip-group">
          <legend>ファイル名の構成</legend>
          <label><input type="radio" name="cwr-zip-file-name" value="with-original"> <span>学生の識別名＋課題名＋元のファイル名<small>例：26_0001 学生A（Student A）_課題名_提出ファイル.docx</small></span></label>
          <label><input type="radio" name="cwr-zip-file-name" value="without-original"> <span>学生の識別名＋課題名<small>例：26_0001 学生A（Student A）_課題名.docx</small></span></label>
        </fieldset>
        <div id="cwr-zip-roster-wrap">
          <label for="cwr-zip-roster">名簿CSV（学籍番号。氏名列は任意）</label>
          <textarea id="cwr-zip-roster" rows="4" placeholder="学籍番号&#10;2610170001&#10;2610170002"></textarea>
          <p class="cwr-zip-note">正式な学籍番号から省略番号（例：26_0001）を作り、表示名の先頭番号と一意に一致した場合に使用します。氏名列は任意です。入力内容は保存しません。照合できない学生は表示名で保存し、一覧に警告を残します。</p>
        </div>
        <div id="cwr-zip-actions">
          <button id="cwr-zip-start" type="button">ZIPを作成してダウンロード</button>
          <button id="cwr-zip-cancel-dialog" type="button">閉じる</button>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    dialog.querySelector("#cwr-zip-assignment").textContent = zipAssignmentName();
    const applyRosterVisibility = () => {
      const rule = dialog.querySelector("input[name='cwr-zip-rule']:checked")?.value || "name-number";
      dialog.querySelector("#cwr-zip-roster-wrap").hidden = rule !== "roster-number";
    };
    dialog.querySelector("#cwr-zip-close").addEventListener("click", closeZipDialog);
    dialog.querySelector("#cwr-zip-cancel-dialog").addEventListener("click", closeZipDialog);
    dialog.querySelectorAll("input[name='cwr-zip-rule']").forEach((input) =>
      input.addEventListener("change", applyRosterVisibility));
    dialog.querySelector("#cwr-zip-start").addEventListener("click", () => {
      const layout = dialog.querySelector("input[name='cwr-zip-layout']:checked")?.value || "flat";
      const tokenRule = dialog.querySelector("input[name='cwr-zip-rule']:checked")?.value || "name-number";
      const fileNameStyle = dialog.querySelector("input[name='cwr-zip-file-name']:checked")?.value || "with-original";
      const rosterText = dialog.querySelector("#cwr-zip-roster").value;
      // 次回も同じ設定から始められるようにする。毎回変更できる。
      saveSetting({ cwrZipLayout: layout, cwrZipTokenRule: tokenRule, cwrZipFileNameStyle: fileNameStyle });
      closeZipDialog();
      startZipDownload({ layout, tokenRule, fileNameStyle, rosterText });
    });

    const layoutInput = dialog.querySelector(`input[name='cwr-zip-layout'][value='${zipRun.layout}']`)
      || dialog.querySelector("input[name='cwr-zip-layout']");
    layoutInput.checked = true;
    const ruleInput = dialog.querySelector(`input[name='cwr-zip-rule'][value='${zipRun.tokenRule}']`)
      || dialog.querySelector("input[name='cwr-zip-rule'][value='name-number']");
    ruleInput.checked = true;
    const fileNameInput = dialog.querySelector(`input[name='cwr-zip-file-name'][value='${zipRun.fileNameStyle}']`)
      || dialog.querySelector("input[name='cwr-zip-file-name'][value='with-original']");
    fileNameInput.checked = true;
    applyRosterVisibility();
    dialog.querySelector("#cwr-zip-start").focus();
  }

  function zipCountText() {
    const { studentsDone, studentsTotal, filesDone, filesFailed } = zipRun.counts;
    if (zipRun.phase === "collect") {
      return studentsTotal
        ? `${studentsTotal}名中 ${studentsDone}名を確認`
        : `${studentsDone}名を確認`;
    }
    const files = `取得済み ${filesDone}ファイル`;
    const failed = filesFailed ? `・失敗 ${filesFailed}ファイル` : "";
    return `${studentsTotal}名中 ${studentsDone}名を処理中／${files}${failed}`;
  }

  function zipSummaryLines() {
    const summary = zipRun.summary;
    if (!summary) return [];
    return [
      `提出者：${summary.submitted}名`,
      `取得成功：${summary.succeededStudents}名・${summary.files}ファイル`,
      `未提出：${summary.notSubmitted}名`,
      `取得失敗：${summary.failedStudents}名・${summary.failedFiles}ファイル`
    ];
  }

  function renderZipPanel() {
    if (zipRun.phase === "idle") return;
    let panel = document.getElementById("cwr-zip-panel");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "cwr-zip-panel";
      panel.setAttribute("role", "status");
      panel.setAttribute("aria-live", "polite");
      panel.innerHTML = `
        <div id="cwr-zip-panel-card">
          <h2 id="cwr-zip-title">提出物を一括ダウンロード</h2>
          <p id="cwr-zip-count"></p>
          <div id="cwr-zip-bar" aria-hidden="true"><span></span></div>
          <p id="cwr-zip-detail"></p>
          <div id="cwr-zip-summary" hidden></div>
          <div id="cwr-zip-failures" hidden></div>
          <div id="cwr-zip-panel-actions">
            <button id="cwr-zip-retry" type="button" hidden>失敗した項目だけ再取得</button>
            <button id="cwr-zip-stop" type="button">中止</button>
          </div>
        </div>`;
      document.body.appendChild(panel);
      panel.querySelector("#cwr-zip-stop").addEventListener("click", cancelZipDownload);
      panel.querySelector("#cwr-zip-retry").addEventListener("click", retryFailedZipItems);
    }
    const finished = ["done", "error", "cancelled"].includes(zipRun.phase);
    panel.dataset.phase = zipRun.phase;
    panel.querySelector("#cwr-zip-title").textContent = zipRun.title;
    panel.querySelector("#cwr-zip-count").textContent = finished ? "" : zipCountText();
    panel.querySelector("#cwr-zip-count").hidden = finished;
    panel.querySelector("#cwr-zip-bar").hidden = finished;
    panel.querySelector("#cwr-zip-detail").textContent = zipRun.detail;

    const summaryBox = panel.querySelector("#cwr-zip-summary");
    const lines = finished ? zipSummaryLines() : [];
    summaryBox.hidden = lines.length === 0;
    summaryBox.textContent = "";
    for (const line of lines) {
      const row = document.createElement("p");
      row.textContent = line;
      summaryBox.appendChild(row);
    }

    const failureBox = panel.querySelector("#cwr-zip-failures");
    failureBox.textContent = "";
    const showFailures = finished && zipRun.failures.length > 0;
    failureBox.hidden = !showFailures;
    if (showFailures) {
      const heading = document.createElement("p");
      heading.className = "cwr-zip-failure-heading";
      heading.textContent = `取得できなかった提出物（${zipRun.failures.length}件）`;
      failureBox.appendChild(heading);
      for (const failure of zipRun.failures.slice(0, 12)) {
        const row = document.createElement("p");
        row.className = "cwr-zip-failure";
        row.textContent = `${failure.studentName || "提出者不明"}：${failure.fileName || "提出物"} — ${failure.note || "取得に失敗しました。"}`;
        failureBox.appendChild(row);
      }
      if (zipRun.failures.length > 12) {
        const more = document.createElement("p");
        more.className = "cwr-zip-failure";
        more.textContent = `ほか ${zipRun.failures.length - 12}件。詳しくはZIP内の「提出物一覧.csv」をご覧ください。`;
        failureBox.appendChild(more);
      }
    }

    const retryButton = panel.querySelector("#cwr-zip-retry");
    retryButton.hidden = !(finished && zipRun.failures.length > 0 && zipRun.students.length > 0);
    const stopButton = panel.querySelector("#cwr-zip-stop");
    stopButton.textContent = finished ? "閉じる" : "中止";
  }

  function isPowerPoint(fileName = findOfficeFileName()) {
    return /\.pptx?$/i.test(fileName);
  }

  function updateUiLabels() {
    // 拡張機能を再読み込みした直後は、この古いスクリプトだけがページに残る。
    // DOM監視や準備用タイマーからここへ入ると、Chromeが文脈切れの例外を
    // コンソールへ出すことがあるため、以降の画面更新を止める。
    if (!contextAvailable()) return;
    const root = state.ui;
    if (!root) return;
    const submissionView = isSubmissionView();
    const fileInfo = submissionView ? currentDisplayedFileInfo() : null;
    const googleDocument = fileInfo?.kind === "google-document";
    const googlePresentation = fileInfo?.kind === "google-presentation";
    const pdfAttachment = fileInfo?.kind === "pdf";
    const powerpoint = submissionView && isPowerPoint(fileInfo?.fileName || "");
    const openButton = root.querySelector("#cwr-open");
    const officeButton = root.querySelector("#cwr-open-window");
    const reconvertButton = root.querySelector("#cwr-reconvert");
    const prepareButton = root.querySelector("#cwr-prepare");
    const zipButton = root.querySelector("#cwr-zip");
    const showPreparationButton = root.querySelector("#cwr-show-preparation");
    const autoInput = root.querySelector("#cwr-auto");
    if (!submissionView) {
      openButton.textContent = "提出物を開くと表示できます";
      officeButton.textContent = "提出物を開くと操作できます";
      openButton.disabled = true;
      officeButton.disabled = true;
      reconvertButton.disabled = true;
      prepareButton.disabled = true;
      zipButton.disabled = true;
      showPreparationButton.hidden = !state.preparationPanelHidden;
      autoInput.disabled = true;
      return;
    }
    openButton.textContent = "PDFで表示";
    officeButton.textContent = googleDocument || googlePresentation
      ? "Google形式はPDF表示のみ"
      : pdfAttachment
        ? "PDFはPDF表示のみ"
      : powerpoint
        ? "PowerPointで発表"
        : "Word別窓で表示";
    openButton.disabled = !fileInfo;
    officeButton.disabled = !fileInfo || googleDocument || googlePresentation || pdfAttachment;
    reconvertButton.disabled = !fileInfo;
    const busyPreparing = state.remotePreparing || state.preparing;
    prepareButton.textContent = busyPreparing ? "一括準備を実行中…" : "全員分を一括準備";
    prepareButton.disabled = busyPreparing || zipRun.running;
    zipButton.textContent = zipRun.running ? "ZIPを作成中…" : "提出物をZIPで一括ダウンロード";
    zipButton.disabled = busyPreparing || zipRun.running;
    showPreparationButton.hidden = !state.preparationPanelHidden;
    autoInput.disabled = false;
  }

  function applyControlsLayout() {
    if (!state.ui) return;
    state.ui.classList.toggle("cwr-controls-collapsed", state.controlsCollapsed);
    const launcher = state.ui.querySelector("#cwr-controls-toggle");
    launcher?.setAttribute("aria-expanded", String(!state.controlsCollapsed));
    if (launcher) {
      const compact = state.controlsCollapsed;
      launcher.textContent = compact ? "CWR" : "最小化";
      launcher.title = compact ? "操作パネルを開く（ドラッグして移動）" : "操作パネルを最小化";
      launcher.setAttribute("aria-label", launcher.title);
    }
    const ratio = state.controlsPosition?.ratio;
    const top = Number.isFinite(ratio) ? Math.max(0.08, Math.min(0.92, ratio)) * window.innerHeight : window.innerHeight / 2;
    state.ui.style.top = `${Math.round(top)}px`;
  }

  function setControlsCollapsed(value, persist = true) {
    state.controlsCollapsed = Boolean(value);
    if (persist) saveSetting({ cwrControlsCollapsed: state.controlsCollapsed });
    applyControlsLayout();
  }

  function attachControlsDrag(root) {
    const grip = root.querySelector("#cwr-controls-drag");
    const launcher = root.querySelector("#cwr-controls-toggle");
    if (!grip || !launcher) return;
    const beginDrag = (event, allowWhenCollapsed) => {
      if (event.button !== 0) return;
      if (!allowWhenCollapsed && state.controlsCollapsed) return;
      const startTop = root.getBoundingClientRect().top + root.getBoundingClientRect().height / 2;
      const startY = event.clientY;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      root.classList.add("cwr-controls-dragging");
      let dragged = false;
      const move = (moveEvent) => {
        if (Math.abs(moveEvent.clientY - startY) > 4) dragged = true;
        const top = Math.max(28, Math.min(window.innerHeight - 28, startTop + moveEvent.clientY - startY));
        state.controlsPosition = { ratio: top / Math.max(1, window.innerHeight) };
        root.style.top = `${Math.round(top)}px`;
      };
      const end = () => {
        root.classList.remove("cwr-controls-dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        if (dragged && state.controlsPosition) {
          state.controlsDraggedAt = Date.now();
          saveSetting({ cwrControlsPositionV2: state.controlsPosition });
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end, { once: true });
    };
    grip.addEventListener("pointerdown", (event) => beginDrag(event, false));
    launcher.addEventListener("pointerdown", (event) => beginDrag(event, true));
  }

  function makeUi() {
    // 準備専用タブでは自動操作の邪魔になるため、採点用の操作パネルは出さない。
    if (state.isPreparationTab && !isPreparationFinished()) return;
    if (document.getElementById("cwr-controls")) return;
    const root = document.createElement("section");
    root.id = "cwr-controls";
    root.setAttribute("aria-label", "Classroom Office Reviewer");
    root.innerHTML = `
      <button id="cwr-controls-toggle" type="button" title="操作パネルを開く（ドラッグして移動）" aria-label="操作パネルを開く（ドラッグして移動）" aria-expanded="false">CWR</button>
      <button id="cwr-controls-drag" type="button" title="ドラッグして位置を変える" aria-label="ドラッグして位置を変える">移動</button>
      <button id="cwr-open" type="button">PDFで表示</button>
      <button id="cwr-open-window" type="button">Word別窓で表示</button>
      <button id="cwr-reconvert" type="button">このファイルを再変換</button>
      <button id="cwr-prepare" type="button">全員分を一括準備</button>
      <button id="cwr-zip" type="button">提出物をZIPで一括ダウンロード</button>
      <button id="cwr-show-preparation" type="button" hidden>準備状況を表示</button>
      <button id="cwr-cache" type="button">キャッシュ管理</button>
      <label id="cwr-auto-label">
        <input id="cwr-auto" type="checkbox">
        次の提出物を自動表示
      </label>
      <button id="cwr-toggle" type="button">機能OFF</button>
      <span id="cwr-status" role="status">待機中</span>
    `;
    document.body.appendChild(root);
    state.ui = root;
    root.querySelector("#cwr-controls-toggle").addEventListener("click", () => {
      if (Date.now() - state.controlsDraggedAt < 350) return;
      setControlsCollapsed(!state.controlsCollapsed);
    });
    attachControlsDrag(root);

    root.querySelector("#cwr-open").addEventListener("click", () => {
      if (reportContextLostIfNeeded()) return;
      state.mode = "pdf";
      saveSetting({ cwrMode: state.mode });
      safeSendMessage({ type: "cwr-close-office" }).catch(() => undefined);
      startConversion(false);
    });
    root.querySelector("#cwr-open-window").addEventListener("click", () => {
      if (reportContextLostIfNeeded()) return;
      state.mode = "office";
      saveSetting({ cwrMode: state.mode });
      removeOverlay();
      startOfficeWindow(false);
    });
    root.querySelector("#cwr-reconvert").addEventListener("click", reconvertCurrentFile);
    root.querySelector("#cwr-prepare").addEventListener("click", () => {
      if (reportContextLostIfNeeded()) return;
      startDedicatedPreparation();
    });
    root.querySelector("#cwr-zip").addEventListener("click", showZipDialog);
    root.querySelector("#cwr-show-preparation").addEventListener("click", showPreparationPanel);
    root.querySelector("#cwr-cache").addEventListener("click", showCachePanel);
    root.querySelector("#cwr-auto").addEventListener("change", (event) => {
      state.auto = event.target.checked;
      saveSetting({ cwrAuto: state.auto });
      if (reportContextLostIfNeeded()) return;
      setStatus(state.auto ? "自動表示オン" : "自動表示オフ", "idle");
    });
    root.querySelector("#cwr-toggle").addEventListener("click", () => setEnabled(!state.enabled));
    updateUiLabels();
    applyControlsLayout();
    loadSettings(["cwrAuto", "cwrMode", "cwrEnabled", "cwrControlsCollapsed", "cwrControlsPositionV2", "cwrZipLayout", "cwrZipTokenRule", "cwrZipFileNameStyle"]).then(({
      cwrAuto, cwrMode, cwrEnabled, cwrControlsCollapsed, cwrControlsPositionV2, cwrZipLayout, cwrZipTokenRule, cwrZipFileNameStyle
    }) => {
      if (!contextAvailable()) return;
      // 前回選んだ整理方法と学籍番号の決め方を初期値にする。毎回変更できる。
      zipRun.layout = cwrZipLayout === "per-student" ? "per-student" : "flat";
      zipRun.tokenRule = ["name-number", "display-name", "roster-number"].includes(cwrZipTokenRule)
        ? cwrZipTokenRule
        : cwrZipTokenRule === "email" ? "roster-number" : "name-number";
      zipRun.fileNameStyle = cwrZipFileNameStyle === "without-original" ? "without-original" : "with-original";
      state.auto = state.isPreparationTab ? false : Boolean(cwrAuto);
      state.mode = ["word", "office"].includes(cwrMode) ? "office" : "pdf";
      state.enabled = cwrEnabled !== false;
      state.controlsCollapsed = cwrControlsCollapsed !== false;
      // v0.8.7以前のpx座標は画面サイズが変わると下部へずれてしまうため使わない。
      state.controlsPosition = cwrControlsPositionV2 && Number.isFinite(cwrControlsPositionV2.ratio)
        ? cwrControlsPositionV2
        : null;
      root.querySelector("#cwr-auto").checked = state.auto;
      applyEnabledUi();
      applyControlsLayout();
    }, () => undefined);
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
    if (persist) saveSetting({ cwrEnabled: state.enabled });
    if (!state.enabled) {
      endDisplayRequest();
      removeOverlay();
      safeSendMessage({ type: "cwr-close-office" }).catch(() => undefined);
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
      status.title = text;
      status.setAttribute("aria-label", text);
    }
    if (state.preparing && !isPreparationFinished()) setPreparationProgress({ detailText: text });
    state.overlay?.querySelector("iframe")?.contentWindow?.postMessage({ type: "cwr-viewer-status", text, kind }, "*");
  }

  // 表示要求の開始と終了は必ずこの2つを通す。busyを直接書き換えると、
  // 返事が来ない経路が1つでもあるとフラグが立ちっぱなしになり、以降の
  // 「次へ」「前へ」がエラーも出さずに無反応になる。
  function beginDisplayRequest() {
    state.busy = true;
    clearTimeout(state.busyWatchdog);
    state.busyWatchdog = setTimeout(() => {
      if (!state.busy) return;
      state.busy = false;
      state.busyWatchdog = null;
      setStatus("表示の準備が終わりませんでした。もう一度「次へ」または「表示」を押してください。", "error");
      sendViewerControls();
    }, DISPLAY_REQUEST_TIMEOUT_MS);
  }

  function endDisplayRequest() {
    state.busy = false;
    clearTimeout(state.busyWatchdog);
    state.busyWatchdog = null;
  }

  // 変換して表示できない提出かどうかを判定し、ビューアーに出す内容を作る。
  // 「未提出」とは断定できないため、確認できた事実だけを言葉にする。
  function noticeForSubmission(fileInfo) {
    if (fileInfo?.kind === "no-attachment") {
      return {
        kind: "no-attachment",
        fileName: "添付ファイルなし",
        url: "",
        title: "添付ファイルを確認できません",
        body: "Classroomがこの提出者の添付ファイルを表示していません。未提出のほか、本文だけの提出や提出物の取り消しなども考えられます。Classroomの提出状況を確認してください。",
        status: "添付ファイルを確認できませんでした。"
      };
    }
    if (fileInfo?.kind === "link") {
      return {
        kind: "link",
        fileName: fileInfo.fileName || "共有リンクの提出",
        url: fileInfo.sourceUrl || "",
        title: "共有リンクで提出されています",
        body: "このリンク先はGoogle Classroom外にあるため、拡張機能では内容を取り込めません。リンクを開いて内容を確認してください。",
        status: "共有リンクの提出です。リンクを開いて確認してください。"
      };
    }
    const linkOnly = !fileInfo ? findSubmittedLinks() : [];
    if (linkOnly.length) {
      return {
        kind: "link",
        fileName: linkOnly[0].fileName || "共有リンクの提出",
        url: linkOnly[0].sourceUrl || "",
        title: "共有リンクで提出されています",
        body: "このリンク先はGoogle Classroom外にあるため、拡張機能では内容を取り込めません。リンクを開いて内容を確認してください。",
        status: "共有リンクの提出です。リンクを開いて確認してください。"
      };
    }
    if (!fileInfo && findNoAttachmentMessage()) {
      return {
        kind: "no-attachment",
        fileName: "添付ファイルなし",
        url: "",
        title: "添付ファイルを確認できません",
        body: "Classroomがこの提出者の添付ファイルを表示していません。未提出のほか、本文だけの提出や提出物の取り消しなども考えられます。Classroomの提出状況を確認してください。",
        status: "添付ファイルを確認できませんでした。"
      };
    }
    return null;
  }

  // 届いたPDFが「今開いているファイル」のものかを、Drive上のファイル番号で確かめる。
  // 番号を確認できない場合だけ、これまでどおり受け入れる。
  function matchesRequestedFile(message) {
    const requestedId = state.activeFile?.id || "";
    if (!requestedId) return true;
    const deliveredId = String(message?.submissionKey || "").split("|")[1] || "";
    if (!deliveredId) return true;
    return deliveredId === requestedId;
  }

  async function startConversion(isAutomatic, requestedFile = null) {
    if (!contextAvailable()) return;
    if (!state.enabled) return;
    // 自動表示のときだけ、進行中の要求を尊重して二重に走らせない。
    // 手動操作は必ず受け付け、前の要求を捨てて新しい表示を優先する。
    if (isAutomatic && state.busy) return;
    if (!isSubmissionView()) {
      if (!isAutomatic) setStatus("提出物を個別に開いてから操作してください。", "error");
      return;
    }
    // Classroomの添付を切り替えた直後は、タイトルとiframeが少しずれて更新される。
    // 手動・自動ともに現在のiframeを基準に待ち、前回のactiveFileを使い回さない。
    const detectedFileInfo = requestedFile || await waitForCurrentDisplayedFile(isAutomatic ? 3500 : 1200);
    const fileInfo = requestedFile || detectedFileInfo || (state.activeFile?.name
      ? { kind: "office", fileName: state.activeFile.name, expectedName: state.activeFile.name, expectedFileId: state.activeFile.id }
      : null);
    // 共有リンクの提出と添付なしは、変換して表示できるファイルが無い。
    // ここで打ち切らないと取得に失敗し、前の学生のPDFが残ったままになる。
    const notice = noticeForSubmission(fileInfo);
    if (notice) {
      endDisplayRequest();
      setActiveFile(fileInfo || null);
      state.catalogActiveKey = "";
      state.currentKey = getSubmissionKey(fileInfo || undefined);
      state.convertedKey = state.currentKey;
      showViewerNotice(notice);
      setStatus(notice.status, "idle");
      return true;
    }
    if (!fileInfo) {
      const detail = logCurrentFileContext("表示対象を特定できませんでした");
      if (!isAutomatic) setStatus(`表示中のWord／PowerPoint／PDF／Google形式のファイルを特定できませんでした。表示ファイルID: ${detail.displayedFileId || "取得待ち"}`, "error");
      return;
    }

    beginDisplayRequest();
    setActiveFile(fileInfo);
    state.catalogActiveKey = "";
    const key = getSubmissionKey(fileInfo);
    logCurrentFileContext(isAutomatic ? "自動表示を開始" : "PDF表示を開始", fileInfo);
    setStatus("提出物を取得中…", "working");
    try {
      const response = await safeSendMessage({
        type: "cwr-start",
        submissionKey: key,
        expectedName: fileInfo.expectedName || "",
        expectedFileId: fileInfo.expectedFileId || "",
        expectedGoogleType: fileInfo.expectedGoogleType || "",
        cacheIdentity: getCacheIdentity(fileInfo),
        force: requestedFile?.force === true
      });
      if (!response?.ok) throw new Error(response?.error || "処理を開始できませんでした。");
      if (!response.completed) {
        setStatus(`${response.fileName} を一時取得中…`, "working");
      }
      return true;
    } catch (error) {
      endDisplayRequest();
      setStatus(error.message || "処理を開始できませんでした。", "error");
      return false;
    }
  }

  async function startOfficeWindow(isAutomatic) {
    if (!contextAvailable()) return;
    if (!state.enabled) return;
    // 手動操作は必ず受け付ける（startConversionと同じ考え方）。
    if (isAutomatic && state.busy) return;
    if (!isSubmissionView()) {
      if (!isAutomatic) setStatus("提出物を個別に開いてから操作してください。", "error");
      return;
    }
    const fileInfo = await waitForCurrentDisplayedFile(isAutomatic ? 3500 : 1200);
    const fileName = fileInfo?.fileName || "";
    if (!fileInfo || fileInfo.kind !== "office" || !/\.(?:docx?|pptx?)$/i.test(fileName)) {
      if (!isAutomatic) setStatus("表示中のWord／PowerPointファイルが見つかりません。", "error");
      return;
    }

    beginDisplayRequest();
    const key = getSubmissionKey(fileInfo);
    logCurrentFileContext(isAutomatic ? "別窓の自動表示を開始" : "別窓表示を開始", fileInfo);
    setStatus(isPowerPoint(fileName) ? "PowerPoint発表画面を準備中…" : "Word別ウィンドウを準備中…", "working");
    try {
      const response = await safeSendMessage({
        type: "cwr-open-office",
        submissionKey: key,
        expectedName: fileInfo.expectedName || "",
        expectedFileId: fileInfo.expectedFileId || ""
      });
      if (!response?.ok) throw new Error(response?.error || "別ウィンドウを開けませんでした。");
      endDisplayRequest();
      setStatus(isPowerPoint(response.fileName) ? `${response.fileName} を発表中` : `${response.fileName} をWord別窓で表示中`, "ready");
    } catch (error) {
      endDisplayRequest();
      setStatus(error.message || "別ウィンドウを開けませんでした。", "error");
    }
  }

  async function reconvertCurrentFile() {
    if (reportContextLostIfNeeded()) return;
    const fileInfo = await waitForCurrentDisplayedFile(1200);
    if (!fileInfo) {
      setStatus("再変換する提出物を個別に開いてください。", "error");
      return;
    }
    setStatus(fileInfo.kind === "pdf" ? "このファイルを再取得しています…" : "このファイルを再変換しています…", "converting");
    await startConversion(false, { ...fileInfo, force: true });
  }

  function formatCacheBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  function closeCachePanel() {
    document.getElementById("cwr-cache-panel")?.remove();
  }

  async function showCachePanel() {
    if (reportContextLostIfNeeded()) return;
    setStatus("キャッシュ使用量を確認中…", "working");
    let summary;
    try {
      summary = await safeSendMessage({ type: "cwr-cache-summary" });
      if (!summary?.ok) throw new Error(summary?.error || "キャッシュ使用量を確認できませんでした。");
    } catch (error) {
      setStatus(error.message || "キャッシュ使用量を確認できませんでした。", "error");
      return;
    }
    closeCachePanel();
    const current = getCacheIdentity();
    const currentAssignment = (summary.assignments || []).find((item) =>
      item.courseId === current.courseId && item.assignmentId === current.assignmentId);
    const panel = document.createElement("section");
    panel.id = "cwr-cache-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "キャッシュ管理");
    panel.innerHTML = `
      <div id="cwr-cache-card">
        <button id="cwr-cache-close" type="button" aria-label="閉じる">×</button>
        <h2>キャッシュ管理</h2>
        <p><strong>${formatCacheBytes(summary.totalBytes)}</strong>・${summary.files}件をこのPCに保持しています。</p>
        <p>${currentAssignment ? `この課題：${formatCacheBytes(currentAssignment.bytes)}・${currentAssignment.files}件` : "この課題の保存済みPDFはまだありません。"}</p>
        <p class="cwr-cache-note">通常は自動削除しません。10 GBを超えた場合のみ通知します。</p>
        <div id="cwr-cache-actions">
          <button data-cwr-clean="temporary" type="button">破損・一時ファイルを整理</button>
          <button data-cwr-clean="unused" type="button">1年以上未使用を削除</button>
          <button data-cwr-clean="assignment" type="button">この課題を削除</button>
          <button data-cwr-clean="all" type="button" class="cwr-danger">すべて削除…</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector("#cwr-cache-close").addEventListener("click", closeCachePanel);
    panel.querySelectorAll("[data-cwr-clean]").forEach((button) => button.addEventListener("click", async () => {
      const mode = button.dataset.cwrClean;
      const labels = { temporary: "破損・一時ファイルを整理", unused: "1年以上使っていないPDFを削除", assignment: "この課題のPDFを削除", all: "保存済みPDFをすべて削除" };
      if (!window.confirm(`${labels[mode]}しますか？ この操作は元に戻せません。`)) return;
      try {
        const result = await safeSendMessage({ type: "cwr-cache-cleanup", mode, cacheIdentity: current, olderThanDays: mode === "unused" ? 365 : undefined });
        if (!result?.ok) throw new Error(result?.error || "キャッシュを整理できませんでした。");
        closeCachePanel();
        setStatus(`キャッシュを整理しました（${formatCacheBytes(result.totalBytes)}・${result.files}件）。`, "ready");
      } catch (error) {
        setStatus(error.message || "キャッシュを整理できませんでした。", "error");
      }
    }));
    setStatus(summary.warning ? "キャッシュが10 GBを超えています。" : "キャッシュを保持しています。", summary.warning ? "working" : "ready");
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
    saveSetting({ cwrOverlayBounds: state.overlayBounds || null });
  }

  function setWideLayout(value) {
    state.wide = Boolean(value);
    // 幅の指定が残っていると「幅いっぱい」が効かないので、横方向だけ手動値を捨てる。
    if (state.overlayBounds) delete state.overlayBounds.right;
    saveSetting({ cwrWide: state.wide });
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
    state.activeFile = file ? {
      id: file.expectedFileId || "",
      name: file.fileName || "",
      kind: file.kind || "",
      sourceUrl: file.sourceUrl || "",
      expectedGoogleType: file.expectedGoogleType || ""
    } : null;
  }

  function logCurrentFileContext(reason, fileInfo = null) {
    const current = fileInfo || currentDisplayedFileInfo() || {};
    const details = {
      displayedFileId: findDisplayedFileId(),
      expectedFileId: current.expectedFileId || "",
      fileName: current.fileName || "",
      submissionKey: getSubmissionKey(current),
      cacheIdentity: getCacheIdentity(current)
    };
    console.info("[Classroom Office Reviewer]", reason, details);
    return details;
  }

  async function waitForCurrentDisplayedFile(timeoutMs = 3000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const fileInfo = currentDisplayedFileInfo();
      if (fileInfo?.expectedFileId || fileInfo?.fileName) return fileInfo;
      await wait(120);
    }
    return currentDisplayedFileInfo();
  }

  // Classroomが実際に表示しているファイルを最優先で正とする。拡張が独自に
  // 覚えた位置を優先すると、Classroom側の表示と番号がずれる。
  function activeFileIndex(files) {
    if (!files.length) return -1;
    const displayedId = findDisplayedFileId();
    if (displayedId) {
      const byDisplayed = files.findIndex((file) => file.expectedFileId === displayedId);
      if (byDisplayed >= 0) return byDisplayed;
    }
    if (state.activeFile?.id) {
      const byId = files.findIndex((file) => file.expectedFileId === state.activeFile.id);
      if (byId >= 0) return byId;
    }
    if (state.activeFile?.name) {
      const byName = files.findIndex((file) =>
        fileNamesLikelyMatch(normalizedFileName(file.fileName), normalizedFileName(state.activeFile.name)));
      if (byName >= 0) return byName;
    }
    return 0;
  }

  function sendViewerControls() {
    const previousButton = findSubmissionButton("previous");
    const nextButton = findSubmissionButton("next");
    const submissionView = isSubmissionView();
    const files = submissionView ? listSubmissionFiles() : [];
    if (submissionView) syncCurrentSubmissionCatalog(files);
    syncSubmissionCatalogFromLedger();
    const frame = state.overlay?.querySelector("iframe");
    if (!frame) return;
    const activeIndex = activeFileIndex(files);
    const activeFile = files[activeIndex] || currentDisplayedFileInfo();
    const activeSubmissionKey = state.catalogActiveKey || (activeFile
      ? submissionCatalogKey({ ...activeFile, studentKey: getStudentKey() })
      : "");
    const hasEarlierFile = activeIndex > 0;
    const hasLaterFile = activeIndex >= 0 && activeIndex < files.length - 1;
    // Classroomのボタンが一瞬見つからないだけで矢印を無効化すると、押しても
    // 何も起きない状態になる。「端であることが確実に分かる」ときだけ無効にし、
    // 見つからないときは押せるままにして、押した時点で判定・案内する。
    const atFirst = Boolean(previousButton) && submissionButtonDisabled(previousButton);
    const atLast = Boolean(nextButton) && submissionButtonDisabled(nextButton);
    frame.contentWindow?.postMessage({
      type: "cwr-viewer-controls",
      previous: hasEarlierFile || !atFirst,
      next: hasLaterFile || !atLast,
      wide: state.wide,
      files: files.map((file) => ({ name: file.fileName })),
      activeIndex,
      submissions: state.submissionCatalog.map((entry) => ({
        catalogKey: submissionCatalogKey(entry),
        studentName: entry.studentName || "",
        fileName: entry.fileName || "提出物",
        fileType: fileTypeLabel(entry),
        status: entry.status || "available",
        sourceUrl: entry.kind === "link" ? (entry.sourceUrl || "") : ""
      })),
      activeSubmissionKey
    }, "*");
  }

  // 同じ提出者のファイルを表示する。ファイル番号が見える場合は直接取得し、
  // Classroomが番号をDOMに出さない場合はファイル選択欄を押してから取得する。
  async function showSubmissionFile(index) {
    // ここで busy を理由に黙って戻ると、ボタンが完全に無反応に見える。
    // 手動操作は常に受け付け、進行中の表示要求は捨てて上書きする。
    if (!state.enabled) return;
    if (reportContextLostIfNeeded()) return;
    const files = listSubmissionFiles();
    const file = files[index];
    if (!file) {
      setStatus("選んだファイルが見つかりませんでした。Classroomを再読み込みしてください。", "error");
      return;
    }
    state.fileSwitching = true;
    try {
      setStatus(`${file.fileName} を選択しています…`, "working");
      const selected = await selectSubmissionFile(file);
      if (!selected) throw new Error("Classroomのファイル選択欄から対象ファイルを確認できませんでした。");
      setActiveFile(selected);
      state.catalogActiveKey = "";
      state.currentKey = getSubmissionKey(selected);
      sendViewerControls();
      const started = await startConversion(false, selected);
      if (started === false && file.kind?.startsWith("google-")) openExternalSubmission(file);
      return started !== false;
    } catch (error) {
      endDisplayRequest();
      setStatus(error.message || "このファイルを表示できませんでした。", "error");
      return false;
    } finally {
      // Classroom側のDOM更新が落ち着くまで、学生切替とみなさない。
      setTimeout(() => {
        state.fileSwitching = false;
      }, 600);
    }
  }

  function viewerCanDisplaySubmission(file) {
    return ["pdf", "office", "google-document", "google-presentation"].includes(file?.kind);
  }

  function externalSubmissionUrl(file) {
    const url = file?.sourceUrl || file?.fileUrl || "";
    return /^https:\/\/(?:drive|docs)\.google\.com\//i.test(url) ? url : "";
  }

  function openExternalSubmission(file) {
    const url = externalSubmissionUrl(file);
    if (!url) return false;
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      setStatus("Google側の画面を新しいタブで開けませんでした。ポップアップを許可してください。", "error");
      return false;
    }
    try { opened.opener = null; } catch (error) { /* noop */ }
    setStatus(`${file.fileName || "提出物"} をGoogle側で開きました。`, "ready");
    return true;
  }

  function catalogStudentKeys() {
    const groups = new Map();
    for (const entry of state.submissionCatalog) {
      const key = entry.studentKey || (entry.studentSeq ? `seq:${entry.studentSeq}` : "");
      if (!key) continue;
      const sequence = Number.isFinite(Number(entry.studentSeq)) ? Number(entry.studentSeq) : Number.POSITIVE_INFINITY;
      const previous = groups.get(key);
      if (!previous || sequence < previous.sequence) groups.set(key, { key, sequence, order: previous?.order ?? groups.size });
    }
    return [...groups.values()]
      .sort((left, right) => left.sequence - right.sequence || left.order - right.order)
      .map((group) => group.key);
  }

  async function moveToCatalogStudent(target) {
    const targetKey = target?.studentKey || "";
    if (!targetKey || targetKey === getStudentKey()) return targetKey === getStudentKey();
    const students = catalogStudentKeys();
    const currentKey = getStudentKey();
    const targetIndex = students.indexOf(targetKey);
    const currentIndex = students.indexOf(currentKey);
    const direction = targetIndex >= 0 && currentIndex >= 0 && targetIndex < currentIndex ? "previous" : "next";

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (getStudentKey() === targetKey) return true;
      const button = findSubmissionButton(direction);
      if (!button || submissionButtonDisabled(button)) return false;
      const before = getStudentKey();
      const beforeFileId = findDisplayedFileId();
      button.click();
      if (!await waitForSubmissionChange(before, 8000, beforeFileId)) return false;
      await waitForSubmissionFile(5000);
      state.activeFile = null;
      state.catalogActiveKey = "";
      state.convertedKey = "";
      state.currentKey = getSubmissionKey();
      sendViewerControls();
    }
    return false;
  }

  function catalogFileMatches(left, right) {
    if (!left || !right) return false;
    if (left.expectedFileId && right.expectedFileId) return left.expectedFileId === right.expectedFileId;
    return fileNamesLikelyMatch(normalizedFileName(left.fileName), normalizedFileName(right.fileName));
  }

  async function showCatalogSubmission(entry) {
    if (!entry) return;
    // 共有リンクと添付なしは変換できないので、一覧から選ばれたらその場で
    // 内容を切り替える。ここを通さないと前の学生の表示が残ってしまう。
    const notice = noticeForSubmission(entry);
    if (notice) {
      setActiveFile(entry);
      state.catalogActiveKey = submissionCatalogKey({ ...entry, studentKey: getStudentKey() });
      state.currentKey = getSubmissionKey(entry);
      state.convertedKey = state.currentKey;
      showViewerNotice(notice);
      setStatus(notice.status, "idle");
      return;
    }
    const files = listSubmissionFiles();
    const index = files.findIndex((file) => catalogFileMatches(file, entry));
    if (index >= 0) {
      const opened = await showSubmissionFile(index);
      if (!opened && localPdfUrl(entry.cachedPdfUrl)) {
        setActiveFile(entry);
        state.catalogActiveKey = submissionCatalogKey({ ...entry, studentKey: getStudentKey() });
        state.currentKey = getSubmissionKey(entry);
        renderPdf(entry.cachedPdfUrl, entry.fileName, entry.pageCount);
        setStatus(`${entry.fileName || "提出物"} の保存済みPDFを表示中`, "ready");
      } else if (!opened && entry.kind?.startsWith("google-")) {
        openExternalSubmission(entry);
      }
      return;
    }

    if (localPdfUrl(entry.cachedPdfUrl)) {
      setActiveFile(entry);
      state.catalogActiveKey = submissionCatalogKey({ ...entry, studentKey: getStudentKey() });
      state.currentKey = getSubmissionKey(entry);
      renderPdf(entry.cachedPdfUrl, entry.fileName, entry.pageCount);
      setStatus(`${entry.fileName || "提出物"} の保存済みPDFを表示中`, "ready");
      return;
    }

    if (!viewerCanDisplaySubmission(entry)) {
      if (!openExternalSubmission(entry)) {
        setStatus(`${entry.fileName || "提出物"} はこのビューアーで表示できず、開くためのURLも取得できません。`, "error");
      }
      return;
    }

    const selected = await selectSubmissionFile({
      ...entry,
      expectedName: entry.expectedName || entry.fileName || ""
    });
    if (!selected) {
      if (entry.kind?.startsWith("google-") && openExternalSubmission(entry)) return;
      throw new Error("Classroomのファイル選択欄から対象ファイルを確認できませんでした。");
    }
    setActiveFile(selected);
    state.catalogActiveKey = "";
    state.currentKey = getSubmissionKey(selected);
    sendViewerControls();
    const started = await startConversion(false, selected);
    if (started === false && entry.kind?.startsWith("google-")) openExternalSubmission(entry);
  }

  async function selectSubmissionFromCatalog(catalogKey) {
    if (!contextAvailable() || !state.enabled) return;
    const entry = state.submissionCatalog.find((item) => submissionCatalogKey(item) === catalogKey);
    if (!entry) {
      setStatus("一覧から選んだ提出物が見つかりません。Classroomを再読み込みしてください。", "error");
      return;
    }
    state.fileSwitching = true;
    try {
      setStatus(`${entry.studentName || "提出者"}：${entry.fileName} を選択しています…`, "working");
      if (entry.studentKey && entry.studentKey !== getStudentKey()) {
        const moved = await moveToCatalogStudent(entry);
        if (!moved) throw new Error("Classroomで対象の提出者へ移動できませんでした。Classroomを再読み込みしてください。");
      }
      await showCatalogSubmission(entry);
    } catch (error) {
      setStatus(error.message || "一覧から提出物を開けませんでした。", "error");
    } finally {
      setTimeout(() => { state.fileSwitching = false; }, 600);
    }
  }

  async function moveToAdjacentSubmission(direction) {
    if (!state.enabled) return;
    if (reportContextLostIfNeeded()) return;
    const files = listSubmissionFiles();
    const currentIndex = activeFileIndex(files);
    if (direction === "next" && currentIndex >= 0 && currentIndex < files.length - 1) {
      await showSubmissionFile(currentIndex + 1);
      return;
    }
    if (direction === "previous" && currentIndex > 0) {
      await showSubmissionFile(currentIndex - 1);
      return;
    }
    const button = findSubmissionButton(direction);
    if (!button || submissionButtonDisabled(button)) {
      setStatus(direction === "next" ? "最後の提出者です。" : "最初の提出者です。", "idle");
      return;
    }
    const before = getStudentKey();
    const beforeFileId = findDisplayedFileId();
    setStatus(direction === "next" ? "次の提出者へ移動しています…" : "前の提出者へ移動しています…", "working");
    state.fileSwitching = false;
    button.click();
    if (!await waitForSubmissionChange(before, 8000, beforeFileId)) {
      setStatus("提出者を切り替えられませんでした。Classroomを再読み込みしてください。", "error");
      return;
    }
    await waitForSubmissionFile(5000);
    state.activeFile = null;
    // ここで前の表示情報を残すと、次の一覧を作るときに前のファイルへ
    // 引き戻されてしまう。表示中の番号を正として作り直す。
    state.convertedKey = "";
    const nextFiles = listSubmissionFiles();
    // 前へ戻るときは、その提出者の最後のファイルから見るほうが自然につながる。
    const targetIndex = direction === "previous" ? Math.max(0, nextFiles.length - 1) : 0;
    if (nextFiles[targetIndex]) await showSubmissionFile(targetIndex);
    else {
      sendViewerControls();
      await startConversion(false);
    }
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
    state.viewerNotice = null;
    state.ui?.classList.remove("cwr-hidden");
  }

  // 変換して表示できない提出（共有リンク・添付なし）でも、前の学生の
  // PDFを残さない。ビューアーの中身を差し替え、リンクならそのまま開ける
  // ようにする。ビューアーがまだ無いときは、無理に開かず状況表示だけ行う。
  function showViewerNotice(notice) {
    state.viewerNotice = notice;
    state.displayedPdfUrl = "";
    const iframe = state.overlay?.querySelector("iframe");
    if (!iframe || !document.body.contains(state.overlay)) return false;
    state.pendingOverlay?.remove();
    state.pendingOverlay = null;
    iframe.title = `${notice.fileName || "提出物"} の内容`;
    iframe.contentWindow?.postMessage({ type: "cwr-show-notice", ...notice }, "*");
    const bounds = findPreviewBounds();
    state.overlay.style.top = `${bounds.top}px`;
    state.overlay.style.right = `${bounds.right}px`;
    sendViewerControls();
    return true;
  }

  function renderPdf(pdfUrl, fileName, pageCount) {
    if (!contextAvailable()) return;
    state.pendingOverlay?.remove();
    state.pendingOverlay = null;
    state.viewerNotice = null;

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
        safeSendMessage({ type: "cwr-release-pdf", pdfUrl: previousPdfUrl }).catch(() => undefined);
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
        if (state.viewerStatus) iframe.contentWindow?.postMessage({ type: "cwr-viewer-status", ...state.viewerStatus }, "*");
        sendViewerControls();
        if (previousPdfUrl && previousPdfUrl !== pdfUrl) {
          safeSendMessage({ type: "cwr-release-pdf", pdfUrl: previousPdfUrl }).catch(() => undefined);
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
    if (event.data?.type === "cwr-reconvert") reconvertCurrentFile();
    if (event.data?.type === "cwr-prepare-all") startDedicatedPreparation();
    if (event.data?.type === "cwr-cache-manage") showCachePanel();
    if (event.data?.type === "cwr-navigate") moveToAdjacentSubmission(event.data.direction === "previous" ? "previous" : "next");
    if (event.data?.type === "cwr-toggle-wide") setWideLayout(!state.wide);
    if (event.data?.type === "cwr-reset-size") resetOverlayBounds();
    if (event.data?.type === "cwr-show-file") showSubmissionFile(Number(event.data.index) || 0);
    if (event.data?.type === "cwr-select-submission") selectSubmissionFromCatalog(String(event.data.catalogKey || ""));
  });

  // ZIP作成用ページ（拡張機能のオリジン）からの進捗・完了だけを受け取る。
  window.addEventListener("message", handleZipFrameMessage);

  function handlePossibleSubmissionChange() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (!contextAvailable()) return;
      // 準備専用タブは自動操作中なので、採点用の表示処理は動かさない。
      if (state.isPreparationTab && state.preparing) return;
      // 同じ提出者の別ファイルを選択中は、学生切替として扱わない。
      if (state.fileSwitching) return;
      // ZIP用に提出者をたどっている間は、変換や自動表示を走らせない。
      if (zipRun.collecting) return;
      makeUi();
      const submissionView = isSubmissionView();
      if (!submissionView) {
        const changedFromSubmission = state.submissionView;
        state.submissionView = false;
        state.currentKey = "";
        endDisplayRequest();
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
      const previousStudentKey = state.currentKey.split("|")[0] || "";
      const fileChangedWithinStudent = Boolean(previousStudentKey && previousStudentKey === getStudentKey());
      const hadPrevious = Boolean(state.currentKey);
      state.currentKey = key;
      endDisplayRequest();
      state.activeFile = null;
      state.catalogActiveKey = "";
      if (state.preparing) return;
      sendViewerControls();
      if (hadPrevious) {
        // Do not blank the projector while Office is converting the next file.
        // The previous PDF remains visible until the replacement is ready.
        setStatus(state.overlay
          ? "次の提出物へ切り替えています。表示は切替まで維持します。"
          : "提出者が切り替わりました。", "idle");
      }
      // Classroom上で利用者が同じ学生の別ファイルを選んだ場合は、
      // 自動表示の設定にかかわらず、その明示操作に表示を追従させる。
      // 学生を前後に移動したときだけは、従来どおり自動表示の設定を尊重する。
      // 共有リンクや添付なしの提出には、表示中のファイルが存在しない。
      // これも切替対象に含めないと、前の学生のPDFが残ったままになる。
      const hasDisplayableSubmission = Boolean(currentDisplayedFileInfo())
        || Boolean(noticeForSubmission(currentDisplayedFileInfo()));
      if (state.enabled && hadPrevious && (state.auto || fileChangedWithinStudent) && isSubmissionView() && hasDisplayableSubmission) {
        setTimeout(() => {
          if (state.mode === "office" && currentDisplayedFileInfo()?.kind === "office") startOfficeWindow(true);
          else startConversion(true);
        }, 120);
      }
    }, 200);
  }

  // 拡張機能を再読み込みしても、このタブが準備専用タブかどうかを取り戻す。
  safeSendMessage({ type: "cwr-preparation-role" }).then((response) => {
    if (response?.role === "preparation" && !response.interrupted) becomePreparationTab();
    if (response?.role === "source" && response.progress) handleRemotePreparationProgress(response.progress);
  }, () => undefined);
  loadSettings(["cwrPreparationCompact", "cwrWide", "cwrOverlayBounds"]).then((stored) => {
    if (!contextAvailable()) return;
    // 既存利用者も、次の一括準備からは本文を覆わない1行表示を既定にする。
    state.preparationCompact = stored.cwrPreparationCompact !== false;
    state.wide = Boolean(stored.cwrWide);
    state.overlayBounds = stored.cwrOverlayBounds || null;
    renderPreparation();
    if (state.overlay) applyOverlayBounds();
  }, () => undefined);

  makeUi();
  state.submissionView = isSubmissionView();
  state.currentKey = state.submissionView ? getSubmissionKey() : "";
  loadSubmissionCatalog();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!contextAvailable()) return;
    if (areaName === "local" && changes.cwrEnabled) {
      const enabled = changes.cwrEnabled.newValue !== false;
      if (enabled !== state.enabled) setEnabled(enabled, false);
    }
  });
  state.mutationObserver = new MutationObserver(handlePossibleSubmissionChange);
  state.mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
  // 拡張機能を更新すると、開いたままのタブは操作を受け取れなくなる。
  // 押してから気づくのでは遅いので、切り離しを見つけた時点で知らせ、
  // 監視も止めて無駄な処理を続けないようにする。
  state.contextWatcher = setInterval(() => {
    if (contextAvailable()) return;
    reportContextLostIfNeeded();
  }, 4000);
  document.addEventListener("visibilitychange", handlePreparationVisibilityEvent);
  window.addEventListener("focus", handlePreparationVisibilityEvent);
  window.addEventListener("pageshow", handlePreparationVisibilityEvent);
  window.addEventListener("resize", () => {
    if (!contextAvailable()) return;
    if (state.overlay) applyOverlayBounds();
  });
  // タブを閉じるときはWord／PowerPoint側の窓も片付ける。
  // `unload`はChromeで廃止予定になり、画面に警告が出るうえ、
  // 将来は呼ばれなくなって後片付けごと動かなくなる。`pagehide`は
  // 同じ場面で確実に呼ばれる後継の合図なので、こちらを使う。
  window.addEventListener("pagehide", () => {
    if (!contextAvailable()) return;
    if (state.mode === "office") {
      safeSendMessage({ type: "cwr-close-office" }).catch(() => undefined);
    }
  });
})();
