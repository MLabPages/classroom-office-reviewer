import assert from "node:assert/strict";
import { filterSubmissionEntries } from "../extension/submission-list.js";

const entries = [
  { catalogKey: "student-a|report", studentName: "26_0101 山田", fileName: "期末レポート.docx" },
  { catalogKey: "student-b|slides", studentName: "26_0102 佐藤", fileName: "発表資料" },
  { catalogKey: "student-c|pdf", studentName: "26_0103 鈴木", fileName: "実験記録.pdf" }
];

assert.deepEqual(
  filterSubmissionEntries(entries, "山田").map((entry) => entry.catalogKey),
  ["student-a|report"]
);
assert.deepEqual(
  filterSubmissionEntries(entries, "実験記録.pdf").map((entry) => entry.catalogKey),
  ["student-c|pdf"]
);
assert.deepEqual(filterSubmissionEntries(entries, "存在しない提出物"), []);
assert.equal(filterSubmissionEntries(null, "山田").length, 0);

console.log("Submission list search handles student names, file names, and zero-result queries.");
