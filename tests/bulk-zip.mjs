import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  assignUniqueTokens,
  abbreviatedStudentNumber,
  buildCsv,
  buildEntryFileName,
  buildZipPath,
  extractNameNumber,
  extractStudentNumber,
  internetShortcut,
  planJob,
  planSubmissionItem,
  resolveStudentToken,
  sanitizeNamePart,
  splitExtension,
  summarizeRows,
  uniqueEntryPath,
  zipBaseName
} from "../extension/bulk-zip-core.js";
import { ZipBuilder, shouldStore } from "../extension/zip-writer.js";
import { __setChannel, handleZipMessage, runJob } from "../extension/bulk-zip.js";

const ASSIGNMENT = "第3回レポート";

// ---------------------------------------------------------------
// 学籍番号の抽出
// ---------------------------------------------------------------
assert.deepEqual(extractStudentNumber("1234567a@example.ac.jp"), { number: "1234567", reason: "matched" });
assert.deepEqual(extractStudentNumber("1234567A@bus.kindai.ac.jp"), { number: "1234567", reason: "matched" });
// 末尾に英字が無い形は、1文字も削らずそのまま使う（誤った番号を作らない）。
assert.deepEqual(extractStudentNumber("1234567@example.ac.jp"), { number: "1234567", reason: "no-trailing-letter" });
// 想定外の形式へ推測で番号を割り当てない。
assert.deepEqual(extractStudentNumber("yamada.taro@example.ac.jp"), { number: "", reason: "unexpected-format" });
assert.deepEqual(extractStudentNumber("1234567ab@example.ac.jp"), { number: "", reason: "unexpected-format" });
assert.deepEqual(extractStudentNumber("a1234567@example.ac.jp"), { number: "", reason: "unexpected-format" });
assert.deepEqual(extractStudentNumber("123a@example.ac.jp"), { number: "", reason: "unexpected-format" });
assert.deepEqual(extractStudentNumber(""), { number: "", reason: "invalid-email" });
assert.deepEqual(extractStudentNumber("1234567a"), { number: "", reason: "invalid-email" });

assert.equal(extractNameNumber("26_0243 安田（Yasuda）"), "26_0243");
assert.equal(extractNameNumber("安田（Yasuda）"), "");
assert.equal(abbreviatedStudentNumber("2610170001"), "26_0001");
assert.equal(abbreviatedStudentNumber("2610170001a"), "");

const rosterNumber = resolveStudentToken(
  { studentName: "26_0001 学生A（Student A）", studentNumber: "2610170001" },
  { rule: "roster-number", sequence: 1 }
);
assert.equal(rosterNumber.token, "2610170001");
assert.equal(rosterNumber.source, "roster-number");
const unresolvedRosterNumber = resolveStudentToken(
  { studentName: "26_0001 学生A（Student A）", rosterWarning: "名簿CSVと一意に照合できないため、表示名を代替として使いました。" },
  { rule: "roster-number", sequence: 1 }
);
assert.equal(unresolvedRosterNumber.token, "26_0001 学生A（Student A）");
assert.match(unresolvedRosterNumber.warnings[0], /一意に照合/);

// 想定外のメールアドレスでは代替名を使い、警告を残す。
const unexpected = resolveStudentToken(
  { studentName: "26_0243 安田（Yasuda）", email: "yasuda@example.ac.jp" },
  { rule: "email", sequence: 1 }
);
assert.equal(unexpected.source, "fallback");
assert.match(unexpected.token, /^26_0243 安田/);
assert.equal(unexpected.warnings.length, 1);
assert.match(unexpected.warnings[0], /想定形式/);

const noEmail = resolveStudentToken({ studentName: "", email: "" }, { rule: "email", sequence: 7 });
assert.equal(noEmail.token, "学生07");
assert.match(noEmail.warnings[0], /メールアドレス/);

// 同姓同名でも識別名が衝突しない。
const tokens = assignUniqueTokens([
  { studentKey: "u:a", studentName: "山田 太郎" },
  { studentKey: "u:b", studentName: "山田 太郎" },
  { studentKey: "u:c", studentName: "山田 太郎" }
], { rule: "display-name" }).map((student) => student.token);
assert.deepEqual(tokens, ["山田 太郎", "山田 太郎_2", "山田 太郎_3"]);

// ---------------------------------------------------------------
// ファイル名のサニタイズ
// ---------------------------------------------------------------
assert.equal(sanitizeNamePart('レポート:第1回/最終<版>?.docx'), "レポート_第1回_最終_版__.docx");
assert.equal(sanitizeNamePart("  余白あり  "), "余白あり");
assert.equal(sanitizeNamePart("末尾のピリオド..."), "末尾のピリオド");
assert.equal(sanitizeNamePart("CON"), "_CON");
assert.equal(sanitizeNamePart("あ".repeat(200)).length, 110);
assert.equal(sanitizeNamePart(""), "");
assert.deepEqual(splitExtension("レポート.docx"), { base: "レポート", extension: ".docx" });
assert.deepEqual(splitExtension("レポート"), { base: "レポート", extension: "" });
assert.deepEqual(splitExtension("a.b.pdf"), { base: "a.b", extension: ".pdf" });

// 元の拡張子を二重に付けない。
assert.equal(
  buildEntryFileName({ token: "1234567", assignmentName: ASSIGNMENT, originalName: "レポート.docx", extension: ".docx" }),
  "1234567_第3回レポート_レポート.docx"
);
assert.equal(
  buildEntryFileName({ token: "26_0001", assignmentName: "課題名", originalName: "提出ファイル.docx", extension: ".docx", includeOriginalName: false }),
  "26_0001_課題名.docx"
);
assert.equal(
  buildEntryFileName({ token: "2610170001", assignmentName: "課題名", originalName: "提出ファイル.docx", extension: ".url", suffix: "Google原本", includeOriginalName: false }),
  "2610170001_課題名_Google原本.url"
);
// Googleドキュメント（拡張子なし）→ .docx を足す。
assert.equal(
  buildEntryFileName({ token: "1234567", assignmentName: ASSIGNMENT, originalName: "発表資料", extension: ".docx" }),
  "1234567_第3回レポート_発表資料.docx"
);
// 元の名前が .docx でも、Googleスライド→.pptx なら元の名前を残す。
assert.equal(
  buildEntryFileName({ token: "1234567", assignmentName: ASSIGNMENT, originalName: "資料.docx", extension: ".pptx" }),
  "1234567_第3回レポート_資料.docx.pptx"
);
// 学籍番号を取得できない提出者でも、ファイルは失われない名前になる。
assert.equal(
  buildEntryFileName({ token: "", assignmentName: ASSIGNMENT, originalName: "", extension: ".pdf" }),
  "提出者不明_第3回レポート_提出物.pdf"
);
// 極端に長い名前は切り詰めても学籍番号と課題名が残る。
// Windowsのパス長に収まるよう、ファイル名は110文字までにする。
const longName = buildEntryFileName({
  token: "1234567",
  assignmentName: "あ".repeat(80),
  originalName: `${"い".repeat(200)}.pdf`,
  extension: ".pdf"
});
assert(longName.startsWith("1234567_"));
assert(longName.endsWith(".pdf"));
assert(longName.length <= 110, `長すぎます: ${longName.length}`);
assert(longName.includes("あ".repeat(40)), "課題名は残す");
// 学生フォルダーまで含めたZIP内パスも、Windowsで扱える長さに収める。
const longPath = buildZipPath({
  layout: "per-student",
  rootFolder: zipBaseName("あ".repeat(120)),
  token: "い".repeat(60),
  fileName: longName
});
// 展開先（例: C:\Users\name\Downloads\ ＝約25文字）を足しても260文字に収まる。
assert(longPath.length <= 220, `ZIP内パスが長すぎます: ${longPath.length}`);

// ---------------------------------------------------------------
// 重複名の連番とZIP内パス
// ---------------------------------------------------------------
const used = new Set();
assert.equal(uniqueEntryPath(used, "root/1234567_課題_資料.docx"), "root/1234567_課題_資料.docx");
assert.equal(uniqueEntryPath(used, "root/1234567_課題_資料.docx"), "root/1234567_課題_資料_02.docx");
assert.equal(uniqueEntryPath(used, "root/1234567_課題_資料.docx"), "root/1234567_課題_資料_03.docx");
// 大文字小文字だけが違う名前も、Windowsでは同じ扱いになるため分ける。
assert.equal(uniqueEntryPath(used, "root/1234567_課題_資料.DOCX"), "root/1234567_課題_資料_04.DOCX");

assert.equal(zipBaseName(ASSIGNMENT), "第3回レポート_提出物");
assert.equal(zipBaseName("2026/前期:最終レポート"), "2026_前期_最終レポート_提出物");
assert.equal(zipBaseName(""), "提出物_提出物");
assert.equal(
  buildZipPath({ layout: "flat", rootFolder: "第3回レポート_提出物", token: "1234567", fileName: "a.docx" }),
  "第3回レポート_提出物/a.docx"
);
assert.equal(
  buildZipPath({ layout: "per-student", rootFolder: "第3回レポート_提出物", token: "1234567", fileName: "a.docx" }),
  "第3回レポート_提出物/1234567/a.docx"
);

// ---------------------------------------------------------------
// .url ファイル
// ---------------------------------------------------------------
assert.equal(internetShortcut("https://example.com/"), "[InternetShortcut]\r\nURL=https://example.com/\r\n");

// ---------------------------------------------------------------
// 提出物の種類ごとの処理分岐
// ---------------------------------------------------------------
const planContext = { token: "1234567", assignmentName: ASSIGNMENT, authuser: 5 };
const wordPlan = planSubmissionItem({ kind: "office", fileName: "レポート.docx", fileId: "FILE_ID_0000000000000000001" }, planContext);
assert.equal(wordPlan.parts.length, 1);
assert.equal(wordPlan.parts[0].kind, "download");
assert.equal(wordPlan.parts[0].fileName, "1234567_第3回レポート_レポート.docx");
assert.match(wordPlan.parts[0].urls[0], /drive\.google\.com\/uc\?id=FILE_ID_0000000000000000001&export=download&authuser=5/);
assert.match(wordPlan.parts[0].urls[1], /drive\.usercontent\.google\.com\/download/);

for (const [googleType, extension, label] of [
  ["document", ".docx", "Googleドキュメント"],
  ["spreadsheet", ".xlsx", "Googleスプレッドシート"],
  ["presentation", ".pptx", "Googleスライド"],
  ["drawing", ".pdf", "Google図形描画"]
]) {
  const plan = planSubmissionItem({ kind: `google-${googleType}`, googleType, fileName: "提出資料", fileId: "GDOC_0000000000000000001" }, planContext);
  assert.equal(plan.typeLabel, label);
  // 変換ファイルと、Google上の原本を開くための .url の2件になる。
  assert.equal(plan.parts.length, 2);
  assert.equal(plan.parts[0].fileName, `1234567_第3回レポート_提出資料${extension}`);
  assert.match(plan.parts[0].urls[0], /docs\.google\.com/);
  assert.equal(plan.parts[1].kind, "shortcut");
  assert.equal(plan.parts[1].fileName, "1234567_第3回レポート_提出資料_Google原本.url");
  assert.match(plan.parts[1].url, /docs\.google\.com/);
}

const linkPlan = planSubmissionItem({ kind: "link", fileName: "YouTube動画", sourceUrl: "https://youtu.be/abcdefghijk" }, planContext);
assert.equal(linkPlan.parts.length, 1);
assert.equal(linkPlan.parts[0].kind, "shortcut");
assert.equal(linkPlan.parts[0].fileName, "1234567_第3回レポート_YouTube動画.url");

// 取得に必要な情報が無い提出物は、計画を作らない（＝一覧に失敗として残る）。
assert.equal(planSubmissionItem({ kind: "unknown", fileName: "なぞの提出" }, planContext).parts.length, 0);

// ---------------------------------------------------------------
// CSV
// ---------------------------------------------------------------
const csv = buildCsv([
  {
    token: "1234567",
    studentName: "26_0243 安田（Yasuda）",
    email: "1234567a@example.ac.jp",
    status: "提出済み",
    originalName: "レポート,第1回.docx",
    typeLabel: "DOCX",
    zipPath: "第3回レポート_提出物/1234567_第3回レポート_レポート.docx",
    sourceUrl: "https://drive.google.com/file/d/ID/view",
    result: "成功",
    note: ""
  }
]);
assert(csv.startsWith("﻿"), "Excelで開いても化けないようBOMを付ける");
assert(csv.includes("\r\n"), "改行はCRLF");
assert(csv.includes("学籍番号,提出者氏名,メールアドレス,提出状態,元の提出物名,提出物の種類,ZIP内の保存先,元URL,取得結果,エラーまたは警告"));
assert(csv.includes('"レポート,第1回.docx"'), "カンマを含む値は引用符で囲む");

// ---------------------------------------------------------------
// 一部失敗時の結果集計
// ---------------------------------------------------------------
const summary = summarizeRows([
  { studentKey: "u:a", status: "提出済み", result: "成功", role: "file" },
  { studentKey: "u:a", status: "提出済み", result: "成功", role: "file" },
  { studentKey: "u:b", status: "提出済み", result: "成功", role: "converted" },
  { studentKey: "u:b", status: "提出済み", result: "URLのみ保存", role: "google-original" },
  { studentKey: "u:c", status: "提出済み", result: "失敗", role: "file" },
  { studentKey: "u:d", status: "未提出", result: "対象ファイルなし", role: "none" }
]);
assert.deepEqual(summary, {
  students: 4,
  submitted: 3,
  notSubmitted: 1,
  succeededStudents: 2,
  failedStudents: 1,
  files: 3,
  failedFiles: 1,
  shortcutOnly: 0
});

// ---------------------------------------------------------------
// 収集結果から取得計画までの通し確認
// ---------------------------------------------------------------
const students = [
  {
    studentKey: "u:1", studentName: "26_0243 安田（Yasuda）", email: "1234567a@example.ac.jp", status: "提出済み",
    files: [{ kind: "office", fileName: "レポート.docx", fileId: "DRIVE_0000000000000000001" }]
  },
  {
    studentKey: "u:2", studentName: "26_0244 吾郷（Ago）", email: "1234568a@example.ac.jp", status: "提出済み",
    files: [
      { kind: "office", fileName: "資料.docx", fileId: "DRIVE_0000000000000000002" },
      { kind: "office", fileName: "資料.docx", fileId: "DRIVE_0000000000000000003" }
    ]
  },
  {
    studentKey: "u:3", studentName: "26_0245 前田（Maeda）", email: "maeda@example.ac.jp", status: "提出済み",
    files: [{ kind: "google-document", googleType: "document", fileName: "考察", fileId: "GDOC_0000000000000000004" }]
  },
  { studentKey: "u:4", studentName: "26_0246 山中（Yamanaka）", email: "1234570a@example.ac.jp", status: "未提出", files: [] },
  { studentKey: "u:5", studentName: "26_0247 西山（Nishiyama）", email: "1234571a@example.ac.jp", status: "提出済み", files: [] }
];

const flatPlan = planJob({ assignmentName: ASSIGNMENT, layout: "flat", tokenRule: "email", authuser: 5, students });
assert.equal(flatPlan.rootFolder, "第3回レポート_提出物");
// 同じ学生の同名ファイルは連番で分かれる。
assert.deepEqual(
  flatPlan.tasks.filter((task) => task.row.studentKey === "u:2").map((task) => task.zipPath),
  [
    "第3回レポート_提出物/1234568_第3回レポート_資料.docx",
    "第3回レポート_提出物/1234568_第3回レポート_資料_02.docx"
  ]
);
// 想定外のメールアドレスは代替名＋警告。
const maedaRow = flatPlan.rows.find((row) => row.studentKey === "u:3");
assert.match(maedaRow.zipPath, /26_0245 前田/);
assert.match(maedaRow.note, /想定形式/);
// 未提出と添付なしは、ZIPへ入れず一覧にだけ残す。
const missingRow = flatPlan.rows.find((row) => row.studentKey === "u:4");
assert.equal(missingRow.result, "対象ファイルなし");
assert.equal(missingRow.status, "未提出");
assert.equal(missingRow.zipPath, "");
const emptyRow = flatPlan.rows.find((row) => row.studentKey === "u:5");
assert.equal(emptyRow.typeLabel, "添付なし");
assert.equal(emptyRow.result, "対象ファイルなし");
assert.equal(emptyRow.status, "提出済み", "添付なしの提出済み学生は未提出へ書き換えない");

const perStudentPlan = planJob({ assignmentName: ASSIGNMENT, layout: "per-student", tokenRule: "email", authuser: 5, students });
assert.equal(
  perStudentPlan.tasks[0].zipPath,
  "第3回レポート_提出物/1234567/1234567_第3回レポート_レポート.docx"
);

const compactNamePlan = planJob({
  assignmentName: "課題名",
  tokenRule: "roster-number",
  fileNameStyle: "without-original",
  students: [{
    studentKey: "u:compact",
    studentName: "26_0001 学生A（Student A）",
    studentNumber: "2610170001",
    status: "提出済み",
    files: [{ kind: "office", fileName: "提出ファイル.docx", fileId: "COMPACT_000000000000000001" }]
  }]
});
assert.equal(compactNamePlan.tasks[0].zipPath, "課題名_提出物/2610170001_課題名.docx");

// 6人の提出済みの直後に未提出者がいても、以降の11人を含めて全18人を
// 一覧へ渡す。未提出者は取得タスクを作らず、CSVには必ず1行残す。
const eighteenStudents = Array.from({ length: 18 }, (_unused, index) => {
  const number = index + 1;
  const notSubmitted = number === 7;
  return {
    studentKey: `u:sequence-${number}`,
    studentName: `学生 ${number}`,
    status: notSubmitted ? "未提出" : "提出済み",
    files: notSubmitted
      ? []
      : [{ kind: "office", fileName: `report-${number}.docx`, fileId: `SEQUENCE_${String(number).padStart(20, "0")}` }]
  };
});
const eighteenPlan = planJob({ assignmentName: ASSIGNMENT, layout: "flat", tokenRule: "display-name", students: eighteenStudents });
const eighteenSummary = summarizeRows(eighteenPlan.rows.map((row) => (
  row.result === "未処理" ? { ...row, result: "成功" } : row
)));
const eighteenCsv = buildCsv(eighteenPlan.rows);
assert.equal(eighteenPlan.rows.length, 18, "CSV対象は全18人分を保持する");
assert.equal(eighteenPlan.tasks.length, 17, "未提出者では取得タスクを作らない");
assert.deepEqual(eighteenSummary, {
  students: 18,
  submitted: 17,
  notSubmitted: 1,
  succeededStudents: 17,
  failedStudents: 0,
  files: 17,
  failedFiles: 0,
  shortcutOnly: 0
});
const seventhRow = eighteenPlan.rows.find((row) => row.studentKey === "u:sequence-7");
assert.equal(seventhRow.result, "対象ファイルなし");
assert.equal(seventhRow.status, "未提出");
assert.equal(eighteenCsv.trim().split(/\r?\n/).length, 19, "CSVは見出しを含めて19行");
assert(eighteenCsv.includes("学生 18"), "未提出者の後の学生もCSVに含める");

// 未提出の位置にかかわらず、対象ファイルなしの行を残して次の学生を処理する。
for (const missingPositions of [[1], [5], [3], [2, 3], [3, 4]]) {
  const studentsForMissingPositions = Array.from({ length: 5 }, (_unused, index) => {
    const number = index + 1;
    const notSubmitted = missingPositions.includes(number);
    return {
      studentKey: `u:position-${missingPositions.join("-")}-${number}`,
      studentName: `位置確認 ${number}`,
      status: notSubmitted ? "未提出" : "提出済み",
      files: notSubmitted ? [] : [{ kind: "office", fileName: `position-${number}.docx`, fileId: `POSITION_${missingPositions.join("")}_${number}` }]
    };
  });
  const plan = planJob({ assignmentName: ASSIGNMENT, tokenRule: "display-name", students: studentsForMissingPositions });
  assert.equal(plan.rows.length, 5, `未提出 ${missingPositions.join(",")}人目でも全員をCSVへ残す`);
  assert.equal(plan.tasks.length, 5 - missingPositions.length, "未提出者は取得タスクから除外する");
  assert.equal(
    plan.rows.filter((row) => row.status === "未提出" && row.result === "対象ファイルなし").length,
    missingPositions.length,
    "未提出者ごとに対象ファイルなしを記録する"
  );
}

// ---------------------------------------------------------------
// ZIPの作成（モックデータ）と中身の確認
// ---------------------------------------------------------------
function parseZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = buffer.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  assert(end >= 0, "ZIPの終端レコードが見つかりません");
  const total = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let index = 0; index < total; index += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, "中央ディレクトリの署名が不正です");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const rawSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const stored = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? Buffer.from(stored) : zlib.inflateRawSync(Buffer.from(stored));
    assert.equal(content.length, rawSize, `${name} の展開後サイズが一致しません`);
    entries.push({ name, method, crc, rawSize, utf8: Boolean(flags & 0x0800), content });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function textResponse(body, contentType = "application/octet-stream") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: null,
    blob: async () => new Blob([body])
  };
}

const wordBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(600).fill(0x41)]);
const requested = [];
const failing = new Set(["DRIVE_0000000000000000003"]);
const messages = [];
__setChannel({
  send: (message) => messages.push(message),
  fetch: async (url) => {
    requested.push(url);
    if ([...failing].some((id) => url.includes(id))) {
      return { ok: false, status: 403, headers: new Headers({ "content-type": "text/html" }), body: null, blob: async () => new Blob([]) };
    }
    if (url.includes("GDOC_0000000000000000004")) return textResponse(new Uint8Array([1, 2, 3, 4, 5]));
    return textResponse(wordBytes);
  }
});

await handleZipMessage({
  type: "cwr-zip-run",
  jobId: "test-1",
  assignmentName: ASSIGNMENT,
  layout: "per-student",
  tokenRule: "email",
  authuser: 5,
  students
});

const done = messages.find((message) => message.type === "cwr-zip-done");
assert(done, "完了の通知が届いていません");
assert.equal(done.fileName, "第3回レポート_提出物.zip");
// 1件失敗しても、残りの提出物は最後まで処理する。
assert.equal(done.summary.failedStudents, 1);
assert.equal(done.summary.failedFiles, 1);
// 1件でも取得できなかった提出者は、確認が必要なので失敗側に数える。
assert.equal(done.summary.succeededStudents, 2);
assert.equal(done.summary.notSubmitted, 1);
assert.equal(done.summary.submitted, 4);
assert(messages.some((message) => message.type === "cwr-zip-progress" && message.phase === "download"));

const zipBuffer = Buffer.from(await done.blob.arrayBuffer());
const entries = parseZip(zipBuffer);
const names = entries.map((entry) => entry.name).sort();
assert.deepEqual(names, [
  "第3回レポート_提出物/1234567/1234567_第3回レポート_レポート.docx",
  "第3回レポート_提出物/1234568/1234568_第3回レポート_資料.docx",
  "第3回レポート_提出物/1234568/1234568_第3回レポート_資料_02_リンクのみ.url",
  "第3回レポート_提出物/26_0245 前田（Maeda）/26_0245 前田（Maeda）_第3回レポート_考察.docx",
  "第3回レポート_提出物/26_0245 前田（Maeda）/26_0245 前田（Maeda）_第3回レポート_考察_Google原本.url",
  "第3回レポート_提出物/提出物一覧.csv",
  "第3回レポート_提出物/提出物一覧.json"
].sort());
assert(entries.every((entry) => entry.utf8), "日本語名のためUTF-8フラグを立てる");

// 取得できなかった提出物は、開くためのURLだけを残す。
const fallback = entries.find((entry) => entry.name.endsWith("_リンクのみ.url"));
assert.match(fallback.content.toString("utf8"), /^\[InternetShortcut\]\r\nURL=https:\/\/drive\.google\.com\/file\/d\/DRIVE_0000000000000000003\/view\r\n$/);
// Google原本のショートカットは必ず残す。
const original = entries.find((entry) => entry.name.endsWith("_Google原本.url"));
assert.match(original.content.toString("utf8"), /docs\.google\.com\/document\/d\/GDOC_0000000000000000004\/edit/);
// 通常ファイルは元の中身のまま入る。
const word = entries.find((entry) => entry.name.endsWith("1234567_第3回レポート_レポート.docx"));
assert.equal(word.rawSize, wordBytes.length);
assert.deepEqual(new Uint8Array(word.content), wordBytes);
// すでに圧縮済みの形式は再圧縮しない。
assert.equal(word.method, 0);
assert.equal(shouldStore("a.docx"), true);
assert.equal(shouldStore("a.csv"), false);

const csvEntry = entries.find((entry) => entry.name.endsWith("提出物一覧.csv"));
const csvText = csvEntry.content.toString("utf8");
assert(csvText.startsWith("﻿"));
assert(csvText.includes("26_0246 山中（Yamanaka）"), "未提出者も一覧へ残す");
assert(csvText.includes("未提出,,未提出,,,対象ファイルなし"), "未提出者は取得結果を「対象ファイルなし」にする");
assert(csvText.includes("権限不足"), "取得できなかった理由を残す");
assert(csvText.includes("失敗（URLのみ保存）"));
const jsonEntry = entries.find((entry) => entry.name.endsWith("提出物一覧.json"));
const jsonReport = JSON.parse(jsonEntry.content.toString("utf8"));
assert.equal(jsonReport.assignmentName, ASSIGNMENT);
assert.equal(jsonReport.entries.length, flatPlan.rows.length);

// ---------------------------------------------------------------
// 失敗した項目だけの再取得
// ---------------------------------------------------------------
const retryKeys = done.failures.map((failure) => failure.key);
assert.equal(retryKeys.length, 1);
assert.equal(done.failures[0].studentName, "26_0244 吾郷（Ago）");
assert.match(done.failures[0].note, /権限不足/);

const retryMessages = [];
failing.clear();
__setChannel({
  send: (message) => retryMessages.push(message),
  fetch: async (url) => {
    requested.push(url);
    return textResponse(wordBytes);
  }
});
await handleZipMessage({
  type: "cwr-zip-run",
  jobId: "retry-1",
  assignmentName: ASSIGNMENT,
  layout: "per-student",
  tokenRule: "email",
  authuser: 5,
  students,
  onlyKeys: retryKeys
});
const retryDone = retryMessages.find((message) => message.type === "cwr-zip-done");
assert(retryDone, "再取得の完了通知が届いていません");
assert.equal(retryDone.retried, true);
assert.equal(retryDone.failures.length, 0, "再取得で成功した項目は失敗に残らない");
const retryEntries = parseZip(Buffer.from(await retryDone.blob.arrayBuffer()));
assert.deepEqual(retryEntries.map((entry) => entry.name).sort(), [
  "第3回レポート_提出物/1234568/1234568_第3回レポート_資料_02.docx",
  "第3回レポート_提出物/提出物一覧.csv",
  "第3回レポート_提出物/提出物一覧.json"
].sort());
const retryCsv = retryEntries.find((entry) => entry.name.endsWith("提出物一覧.csv")).content.toString("utf8");
assert(retryCsv.includes("スキップ"), "再取得の対象外は一覧でスキップと分かるようにする");

// ---------------------------------------------------------------
// 取得できず、URLも無い場合は失敗として残す
// ---------------------------------------------------------------
const brokenMessages = [];
__setChannel({
  send: (message) => brokenMessages.push(message),
  fetch: async () => ({ ok: false, status: 500, headers: new Headers({ "content-type": "text/plain" }), body: null, blob: async () => new Blob([]) })
});
await handleZipMessage({
  type: "cwr-zip-run",
  jobId: "test-2",
  assignmentName: ASSIGNMENT,
  layout: "flat",
  tokenRule: "name-number",
  authuser: 0,
  students: [{
    studentKey: "u:9",
    studentName: "26_0250 胡井（Ebii）",
    status: "提出済み",
    files: [{ kind: "google-presentation", googleType: "presentation", fileName: "発表", fileId: "GSLIDE_000000000000000001" }]
  }]
});
const brokenDone = brokenMessages.find((message) => message.type === "cwr-zip-done");
assert(brokenDone, "失敗しても完了の通知は届く");
const brokenEntries = parseZip(Buffer.from(await brokenDone.blob.arrayBuffer()));
// 変換に失敗しても、Google原本のURLは残る。
assert(brokenEntries.some((entry) => entry.name.endsWith("_Google原本.url")));
assert(brokenEntries.some((entry) => entry.name.includes("26_0250_第3回レポート_発表")));
const brokenCsv = brokenEntries.find((entry) => entry.name.endsWith("提出物一覧.csv")).content.toString("utf8");
assert(brokenCsv.includes("26_0250"), "表示名の番号を学籍番号として使える");

// ---------------------------------------------------------------
// ログインできていないときは、全員分を試す前に理由を出して止める
// ---------------------------------------------------------------
const signedOutMessages = [];
let signedOutRequests = 0;
__setChannel({
  send: (message) => signedOutMessages.push(message),
  fetch: async () => {
    signedOutRequests += 1;
    return { ok: true, status: 200, headers: new Headers({ "content-type": "text/html; charset=utf-8" }), body: null, blob: async () => new Blob(["<html>"]) };
  }
});
await handleZipMessage({
  type: "cwr-zip-run",
  jobId: "signed-out",
  assignmentName: ASSIGNMENT,
  layout: "flat",
  tokenRule: "display-name",
  authuser: 0,
  students: Array.from({ length: 20 }, (unused, index) => ({
    studentKey: `u:s${index}`,
    studentName: `テスト ${index}`,
    status: "提出済み",
    files: [{ kind: "office", fileName: `report${index}.docx`, fileId: `SIGNEDOUT_00000000000000${index}` }]
  }))
});
const signedOutError = signedOutMessages.find((message) => message.type === "cwr-zip-error");
assert(signedOutError, "ログインできていないときはエラーを知らせる");
assert.match(signedOutError.message, /ログイン/);
assert(!signedOutMessages.some((message) => message.type === "cwr-zip-cancelled"), "中止の案内で上書きしない");
assert(!signedOutMessages.some((message) => message.type === "cwr-zip-done"));
// 20人分を試し続けない（1件あたり2つのURLを試すので、上限の3件×2程度で止まる）。
assert(signedOutRequests <= 12, `試行回数が多すぎます: ${signedOutRequests}`);

// ---------------------------------------------------------------
// 二重実行の防止
// ---------------------------------------------------------------
const busyMessages = [];
let releaseFetch = null;
__setChannel({
  send: (message) => busyMessages.push(message),
  fetch: () => new Promise((resolve) => {
    releaseFetch = () => resolve(textResponse(wordBytes));
  })
});
const firstRun = handleZipMessage({
  type: "cwr-zip-run",
  jobId: "busy-1",
  assignmentName: ASSIGNMENT,
  layout: "flat",
  tokenRule: "display-name",
  students: [{ studentKey: "u:x", studentName: "テスト 太郎", status: "提出済み", files: [{ kind: "office", fileName: "a.docx", fileId: "BUSY_00000000000000000001" }] }]
});
await new Promise((resolve) => setImmediate(resolve));
await handleZipMessage({ type: "cwr-zip-run", jobId: "busy-2", assignmentName: ASSIGNMENT, students: [] });
assert(busyMessages.some((message) => message.type === "cwr-zip-error" && /すでにZIPを作成中/.test(message.message)));
releaseFetch();
await firstRun;

// ---------------------------------------------------------------
// 途中キャンセル
// ---------------------------------------------------------------
const cancelMessages = [];
let cancelStarted = null;
const started = new Promise((resolve) => { cancelStarted = resolve; });
__setChannel({
  send: (message) => cancelMessages.push(message),
  fetch: () => new Promise((resolve, reject) => {
    cancelStarted();
    setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
  })
});
const cancelRun = handleZipMessage({
  type: "cwr-zip-run",
  jobId: "cancel-1",
  assignmentName: ASSIGNMENT,
  layout: "flat",
  tokenRule: "display-name",
  students: [{ studentKey: "u:y", studentName: "中止 テスト", status: "提出済み", files: [{ kind: "office", fileName: "b.docx", fileId: "CANCEL_0000000000000000001" }] }]
});
await started;
await handleZipMessage({ type: "cwr-zip-cancel" });
await cancelRun;
assert(cancelMessages.some((message) => message.type === "cwr-zip-cancelled"), "キャンセルは必ず通知して処理中のままにしない");
assert(!cancelMessages.some((message) => message.type === "cwr-zip-done"));

// ---------------------------------------------------------------
// ZIPの上限
// ---------------------------------------------------------------
const builder = new ZipBuilder();
await builder.addText("a/b.txt", "テスト");
assert.equal(builder.entries.length, 1);

console.log("Bulk ZIP download: student numbers, file names, ZIP layout, CSV, and partial failures behave as expected.");
