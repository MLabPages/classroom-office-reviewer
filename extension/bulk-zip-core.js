// 一括ZIPダウンロードの「名前と記録」を決める部分。画面やネットワークに
// 触れない純粋な関数だけを置き、Node からもそのままテストできるようにする。

// Windowsで使えない文字。制御文字も併せて置き換える。
const WINDOWS_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g;
// Windowsが特別扱いする名前。拡張子を付けても開けないことがある。
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
// 1つのフォルダー名・ファイル名の上限。長い提出物名でもパスが破綻しないようにする。
const SEGMENT_MAX = 110;
// 元ファイル名として残す部分の上限。学籍番号と課題名は必ず残す。
const ORIGINAL_MAX = 60;
const ASSIGNMENT_MAX = 40;
// 1つのファイル名の上限。Windowsのパス長（260文字）に収まるようにする。
// 「ZIP直下のフォルダー＋学生フォルダー＋ファイル名」で約215文字が上限。
const ENTRY_NAME_MAX = 110;
const ROOT_FOLDER_MAX = 60;

// ZIPへ入れる文字列は、Windowsのメモ帳でも読めるCRLFに揃える。
const CRLF = "\r\n";

export function normalizeSpace(value) {
  return String(value ?? "").replace(/[\s　]+/g, " ").trim();
}

// ファイル名に使える形へ整える。空になった場合は呼び出し側で代替名を付ける。
export function sanitizeNamePart(value, { max = SEGMENT_MAX } = {}) {
  let text = normalizeSpace(value).replace(WINDOWS_FORBIDDEN, "_");
  // 連続した置換文字は1つにまとめ、見た目の崩れを抑える。
  text = text.replace(/_{3,}/g, "__").replace(/\s{2,}/g, " ");
  // Windowsは末尾の空白とピリオドを落とすため、先に取り除く。
  text = text.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (text.length > max) text = text.slice(0, max).replace(/[\s.]+$/, "");
  if (WINDOWS_RESERVED.test(text)) text = `_${text}`;
  return text;
}

// 拡張子を「本体」と「.ext」に分ける。拡張子が無いものは本体だけを返す。
function splitExtensionRaw(fileName) {
  const text = String(fileName ?? "").trim();
  const match = text.match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
  if (!match || !match[1]) return { base: text, extension: "" };
  return { base: match[1], extension: match[2] };
}

// 比較や付け直しに使う形。拡張子は小文字へそろえる。
export function splitExtension(fileName) {
  const { base, extension } = splitExtensionRaw(fileName);
  return { base, extension: extension.toLowerCase() };
}

// メールアドレスから学籍番号を作る。想定形式（学籍番号＋英字1文字）に
// 一致しないものへ推測で番号を割り当てない。判断の理由も一緒に返す。
export function extractStudentNumber(email) {
  const text = String(email ?? "").trim();
  const match = text.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!match) return { number: "", reason: "invalid-email" };
  const local = match[1];
  const withLetter = local.match(/^(\d{4,12})[A-Za-z]$/);
  if (withLetter) return { number: withLetter[1], reason: "matched" };
  const digitsOnly = local.match(/^(\d{4,12})$/);
  // 末尾の英字が無い形は、1文字も削らずにそのまま使う。削っていないので
  // 誤った番号にはならないが、想定と違う点は控えとして残す。
  if (digitsOnly) return { number: digitsOnly[1], reason: "no-trailing-letter" };
  return { number: "", reason: "unexpected-format" };
}

// 表示名の先頭にある番号らしい語（例: 26_0243）を取り出す。
export function extractNameNumber(displayName) {
  const text = normalizeSpace(displayName);
  const match = text.match(/^([0-9][0-9A-Za-z_-]{1,15})[\s　]/);
  return match ? match[1] : "";
}

// 正式な学籍番号（例: 2610170001）からClassroom表示用の省略番号（26_0001）を作る。
// 桁数が不明な値には推測で番号を付けない。
export function abbreviatedStudentNumber(studentNumber) {
  const number = String(studentNumber ?? "").normalize("NFKC").replace(/[\s　]/g, "");
  if (!/^\d{6,15}$/.test(number)) return "";
  return `${number.slice(0, 2)}_${number.slice(-4)}`;
}

// 提出者ごとの「ファイル名に使う識別名」を決める。
// rule は email / name-number / display-name の3種類。
export function resolveStudentToken(student = {}, { rule = "email", sequence = 0 } = {}) {
  const displayName = normalizeSpace(student.studentName);
  const fallbackBase = sanitizeNamePart(displayName, { max: 40 })
    || `学生${String(sequence || 0).padStart(2, "0")}`;
  const warnings = [];

  if (rule === "email") {
    if (!student.email) {
      warnings.push("メールアドレスを取得できないため学籍番号を確定できません。代替名で保存しました。");
      return { token: fallbackBase, source: "fallback", warnings };
    }
    const { number, reason } = extractStudentNumber(student.email);
    if (number && reason === "matched") return { token: number, source: "email", warnings };
    if (number && reason === "no-trailing-letter") {
      warnings.push("メールアドレスの末尾に英字がないため、ローカル部をそのまま学籍番号として使いました。");
      return { token: number, source: "email", warnings };
    }
    warnings.push("メールアドレスが想定形式（学籍番号＋英字1文字）と一致しないため、代替名で保存しました。");
    return { token: fallbackBase, source: "fallback", warnings };
  }

  if (rule === "roster-number") {
    const number = String(student.studentNumber || "").normalize("NFKC").replace(/[\s　]/g, "");
    if (/^\d{6,15}$/.test(number)) return { token: number, source: "roster-number", warnings };
    warnings.push(student.rosterWarning || "名簿CSVと一意に照合できないため、表示名を代替として使いました。");
    return { token: fallbackBase, source: "fallback", warnings };
  }

  if (rule === "name-number") {
    const number = extractNameNumber(displayName);
    if (number) return { token: sanitizeNamePart(number, { max: 24 }), source: "name-number", warnings };
    warnings.push("表示名の先頭に番号が見つからないため、代替名で保存しました。");
    return { token: fallbackBase, source: "fallback", warnings };
  }

  return { token: fallbackBase, source: "display-name", warnings };
}

// 同姓同名や同じ代替名でも取り違えないよう、識別名は必ず一意にする。
export function assignUniqueTokens(students = [], options = {}) {
  const used = new Map();
  return students.map((student, index) => {
    const resolved = resolveStudentToken(student, { ...options, sequence: index + 1 });
    const base = resolved.token || `学生${String(index + 1).padStart(2, "0")}`;
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    if (count === 1) return { ...student, ...resolved, token: base };
    return {
      ...student,
      ...resolved,
      token: `${base}_${count}`,
      warnings: [...resolved.warnings, "同じ識別名の提出者がいるため、末尾に連番を付けました。"]
    };
  });
}

// ZIP名とZIP直下のフォルダー名。課題名が読めないときも必ず名前を作る。
export function zipBaseName(assignmentName) {
  const safe = sanitizeNamePart(assignmentName, { max: ROOT_FOLDER_MAX }) || "提出物";
  return `${safe}_提出物`;
}

// 「学生の識別名_課題名_任意の元ファイル名_補足.拡張子」を作る。
// 元の拡張子と目的の拡張子が同じ場合、二重に付けない。
export function buildEntryFileName({ token, assignmentName, originalName, extension = "", suffix = "", includeOriginalName = true }) {
  const safeToken = sanitizeNamePart(token, { max: 40 }) || "提出者不明";
  const safeAssignment = sanitizeNamePart(assignmentName, { max: ASSIGNMENT_MAX });
  const split = splitExtension(originalName);
  const targetExtension = (extension || split.extension || "").toLowerCase();
  // 目的の拡張子と元の拡張子が同じときだけ本体から取り除く。違う拡張子
  // （Googleドキュメント→.docx など）は、元の名前を残したほうが分かりやすい。
  const rawBase = split.extension && split.extension === targetExtension ? split.base : String(originalName ?? "");
  const safeBase = sanitizeNamePart(rawBase, { max: ORIGINAL_MAX }) || "提出物";
  const safeSuffix = suffix ? `_${sanitizeNamePart(suffix, { max: 20 })}` : "";
  const assemble = (base) => `${[safeToken, safeAssignment, includeOriginalName ? base : ""].filter(Boolean).join("_")}${safeSuffix}${targetExtension}`;
  if (!includeOriginalName) return assemble("");
  const full = assemble(safeBase);
  if (full.length <= ENTRY_NAME_MAX) return full;
  // 長すぎるときは元ファイル名だけを削る。学籍番号と課題名は必ず残す。
  // 区切りの「_」の分も見込んで余白を計算する。
  const room = ENTRY_NAME_MAX - assemble("").length - 1;
  const trimmed = sanitizeNamePart(safeBase.slice(0, Math.max(0, room)), { max: ORIGINAL_MAX });
  return trimmed ? assemble(trimmed) : assemble("");
}

// 同名になったときに _02、_03 を足す。拡張子の前に入れる。
export function uniqueEntryPath(usedPaths, path) {
  const used = usedPaths instanceof Set ? usedPaths : new Set(usedPaths || []);
  if (!used.has(path.toLowerCase())) {
    used.add(path.toLowerCase());
    return path;
  }
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const fileName = slash >= 0 ? path.slice(slash + 1) : path;
  // 連番を足すときに拡張子の大文字小文字まで変えない。
  const { base, extension } = splitExtensionRaw(fileName);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${directory}${base}_${String(index).padStart(2, "0")}${extension}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
  const fallback = `${directory}${base}_${Date.now()}${extension}`;
  used.add(fallback.toLowerCase());
  return fallback;
}

// ZIP内の保存先。全員同じフォルダーか、提出者ごとのフォルダーかを切り替える。
export function buildZipPath({ layout = "flat", rootFolder, token, fileName }) {
  const root = sanitizeNamePart(rootFolder, { max: 90 }) || "提出物";
  if (layout === "per-student") {
    const folder = sanitizeNamePart(token, { max: 40 }) || "提出者不明";
    return `${root}/${folder}/${fileName}`;
  }
  return `${root}/${fileName}`;
}

// Windowsのショートカット（.url）の中身。
export function internetShortcut(url) {
  return `[InternetShortcut]${CRLF}URL=${String(url ?? "").trim()}${CRLF}`;
}

const GOOGLE_EXPORTS = {
  document: { extension: ".docx", label: "Googleドキュメント", exportPath: (id) => `document/d/${id}/export?format=docx` },
  spreadsheet: { extension: ".xlsx", label: "Googleスプレッドシート", exportPath: (id) => `spreadsheets/d/${id}/export?format=xlsx` },
  presentation: { extension: ".pptx", label: "Googleスライド", exportPath: (id) => `presentation/d/${id}/export/pptx` },
  drawing: { extension: ".pdf", label: "Google図形描画", exportPath: (id) => `drawings/d/${id}/export/pdf` }
};

export function googleEditUrl(googleType, fileId, authuser = 0) {
  const folder = googleType === "spreadsheet"
    ? "spreadsheets"
    : googleType === "presentation"
      ? "presentation"
      : googleType === "drawing" ? "drawings" : "document";
  return `https://docs.google.com/${folder}/d/${fileId}/edit?usp=sharing&authuser=${authuser}`;
}

export function googleExportUrl(googleType, fileId, authuser = 0) {
  const preset = GOOGLE_EXPORTS[googleType];
  if (!preset) return "";
  const path = preset.exportPath(fileId);
  const separator = path.includes("?") ? "&" : "?";
  return `https://docs.google.com/${path}${separator}authuser=${authuser}`;
}

export function driveDownloadUrls(fileId, authuser = 0) {
  return [
    `https://drive.google.com/uc?id=${fileId}&export=download&authuser=${authuser}`,
    // 大きいファイルは確認画面（HTML）が返る。こちらは確認済みとして直接受け取れる。
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t&authuser=${authuser}`
  ];
}

export function submissionTypeLabel(item = {}) {
  if (item.googleType && GOOGLE_EXPORTS[item.googleType]) return GOOGLE_EXPORTS[item.googleType].label;
  if (item.kind === "link") return "リンク";
  if (item.kind === "no-attachment") return "添付なし";
  if (item.kind === "not-submitted") return "未提出";
  const extension = splitExtension(item.fileName || "").extension.replace(".", "");
  return extension ? extension.toUpperCase() : "ファイル";
}

// 提出物1件を、ZIPへ入れる「取得計画」に変換する。
// file : content.js が画面から読み取った添付1件
// 戻り値の parts は、実際に取得・保存する項目の一覧（本体と .url）。
export function planSubmissionItem(file = {}, context = {}) {
  const { token, assignmentName, authuser = 0, includeOriginalName = true } = context;
  const parts = [];
  const googleType = file.googleType || "";
  const preset = GOOGLE_EXPORTS[googleType];
  const originalName = file.fileName || "提出物";

  if (preset && file.fileId) {
    parts.push({
      role: "converted",
      kind: "download",
      urls: [googleExportUrl(googleType, file.fileId, authuser)],
      fileName: buildEntryFileName({ token, assignmentName, originalName, extension: preset.extension, includeOriginalName }),
      sourceUrl: googleEditUrl(googleType, file.fileId, authuser),
      failureNote: `${preset.label}を${preset.extension}へ変換できませんでした。`
    });
    // 変換後のOfficeファイルには、コメントや変更履歴、共有状態が残らない。
    // 原本を開けるショートカットを必ず添える。
    parts.push({
      role: "google-original",
      kind: "shortcut",
      url: googleEditUrl(googleType, file.fileId, authuser),
      fileName: buildEntryFileName({ token, assignmentName, originalName, extension: ".url", suffix: "Google原本", includeOriginalName })
    });
    return { parts, typeLabel: preset.label };
  }

  if (file.kind === "link" || (!file.fileId && file.sourceUrl)) {
    parts.push({
      role: "link",
      kind: "shortcut",
      url: file.sourceUrl || "",
      fileName: buildEntryFileName({ token, assignmentName, originalName, extension: ".url", includeOriginalName })
    });
    return { parts, typeLabel: "リンク" };
  }

  if (file.fileId) {
    const split = splitExtension(originalName);
    parts.push({
      role: "file",
      kind: "download",
      urls: driveDownloadUrls(file.fileId, authuser),
      fileName: buildEntryFileName({ token, assignmentName, originalName, extension: split.extension, includeOriginalName }),
      sourceUrl: `https://drive.google.com/file/d/${file.fileId}/view`,
      failureNote: "Google Driveから提出物を取得できませんでした。"
    });
    return { parts, typeLabel: submissionTypeLabel(file) };
  }

  return { parts, typeLabel: submissionTypeLabel(file) };
}

// 取得計画を作る。ここでZIP内のパスまで決めてしまうので、あとの取得は
// 順番が前後しても結果が変わらない。
export function planJob(job = {}) {
  const rule = ["email", "name-number", "display-name", "roster-number"].includes(job.tokenRule) ? job.tokenRule : "name-number";
  const includeOriginalName = job.fileNameStyle !== "without-original";
  const students = assignUniqueTokens(job.students || [], { rule });
  const rootFolder = zipBaseName(job.assignmentName);
  const layout = job.layout === "per-student" ? "per-student" : "flat";
  const used = new Set();
  const tasks = [];
  const rows = [];

  for (const student of students) {
    const studentWarning = (student.warnings || []).join(" ");
    const files = Array.isArray(student.files) ? student.files : [];
    const baseRow = {
      studentKey: student.studentKey,
      token: student.token,
      studentName: student.studentName,
      email: student.email || "",
      status: student.status || ""
    };
    // 未提出や添付なしは、フォルダーを作らず一覧にだけ残す。
    if (!files.length) {
      rows.push({
        ...baseRow,
        originalName: "",
        typeLabel: student.status === "未提出" ? "未提出" : "添付なし",
        zipPath: "",
        sourceUrl: "",
        result: "対象ファイルなし",
        note: studentWarning,
        role: "none"
      });
      continue;
    }
    for (const file of files) {
      const plan = planSubmissionItem(file, {
        token: student.token,
        assignmentName: job.assignmentName,
        authuser: job.authuser || 0,
        includeOriginalName
      });
      if (!plan.parts.length) {
        rows.push({
          ...baseRow,
          originalName: file.fileName || "",
          typeLabel: submissionTypeLabel(file),
          zipPath: "",
          sourceUrl: file.sourceUrl || "",
          result: "失敗",
          note: [studentWarning, "取得に必要な情報（DriveのファイルIDやURL）を確認できませんでした。"].filter(Boolean).join(" "),
          role: "unknown"
        });
        continue;
      }
      for (const part of plan.parts) {
        const zipPath = uniqueEntryPath(used, buildZipPath({
          layout,
          rootFolder,
          token: student.token,
          fileName: part.fileName
        }));
        const row = {
          ...baseRow,
          originalName: file.fileName || "",
          typeLabel: plan.typeLabel,
          zipPath,
          sourceUrl: part.kind === "shortcut" ? part.url : (part.sourceUrl || file.sourceUrl || ""),
          result: "未処理",
          note: studentWarning,
          role: part.role
        };
        rows.push(row);
        tasks.push({ key: `${student.studentKey}|${zipPath}`, part, row, zipPath });
      }
    }
  }
  return { rootFolder, tasks, rows, layout, used };
}

const CSV_HEADERS = [
  "学籍番号",
  "提出者氏名",
  "メールアドレス",
  "提出状態",
  "元の提出物名",
  "提出物の種類",
  "ZIP内の保存先",
  "元URL",
  "取得結果",
  "エラーまたは警告"
];

function csvCell(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Excelで開いても日本語が化けないよう、BOM付きUTF-8・CRLFで書き出す。
export function buildCsv(rows = []) {
  const lines = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push([
      row.token,
      row.studentName,
      row.email,
      row.status,
      row.originalName,
      row.typeLabel,
      row.zipPath,
      row.sourceUrl,
      row.result,
      row.note
    ].map(csvCell).join(","));
  }
  return `﻿${lines.join(CRLF)}${CRLF}`;
}

export function buildJson(rows = [], meta = {}) {
  return `${JSON.stringify({ ...meta, entries: rows }, null, 2)}\n`;
}

// 結果の数え上げ。1件失敗しても全体を止めないため、最後にここでまとめる。
export function summarizeRows(rows = []) {
  const students = new Map();
  let files = 0;
  let failedFiles = 0;
  let shortcutOnly = 0;
  for (const row of rows) {
    const key = row.studentKey || row.token || row.studentName || "unknown";
    if (!students.has(key)) students.set(key, { ok: 0, failed: 0, status: row.status });
    const student = students.get(key);
    // Google原本のショートカットは提出物そのものではないため、件数には数えない。
    const countable = row.role !== "google-original";
    // 「失敗（URLのみ保存）」は、リンクだけ残せた失敗。成功には数えない。
    if (String(row.result || "").startsWith("失敗")) {
      if (countable) failedFiles += 1;
      student.failed += 1;
    } else if (row.result === "成功") {
      if (countable) files += 1;
      student.ok += 1;
    } else if (row.result === "URLのみ保存") {
      if (countable) {
        files += 1;
        shortcutOnly += 1;
      }
      student.ok += 1;
    }
  }
  let submitted = 0;
  let notSubmitted = 0;
  let succeededStudents = 0;
  let failedStudents = 0;
  for (const student of students.values()) {
    if (student.status === "未提出") notSubmitted += 1;
    else submitted += 1;
    if (student.failed > 0) failedStudents += 1;
    else if (student.ok > 0) succeededStudents += 1;
  }
  return {
    students: students.size,
    submitted,
    notSubmitted,
    succeededStudents,
    failedStudents,
    files,
    failedFiles,
    shortcutOnly
  };
}

export function summaryText(summary) {
  return [
    `提出者：${summary.submitted}名`,
    `取得成功：${summary.succeededStudents}名・${summary.files}ファイル`,
    `未提出：${summary.notSubmitted}名`,
    `取得失敗：${summary.failedStudents}名・${summary.failedFiles}ファイル`
  ].join(CRLF);
}
