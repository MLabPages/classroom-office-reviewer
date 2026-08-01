export function normalizeSubmissionSearch(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function filterSubmissionEntries(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const normalizedQuery = normalizeSubmissionSearch(query);
  if (!normalizedQuery) return list;
  return list.filter((entry) => [entry?.studentName, entry?.fileName]
    .some((value) => normalizeSubmissionSearch(value).includes(normalizedQuery)));
}
