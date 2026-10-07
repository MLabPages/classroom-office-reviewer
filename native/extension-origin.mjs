import crypto from "node:crypto";

// Chromium derives an unpacked extension's ID from the normalized path's
// native bytes; Windows uses UTF-16LE and an uppercase drive letter.
export function extensionIdFor(manifest, extensionPath, platform = process.platform) {
  const bytes = manifest.key
    ? Buffer.from(manifest.key, "base64")
    : Buffer.from(platform === "win32" ? extensionPath.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : extensionPath,
                  platform === "win32" ? "utf16le" : "utf8");
  return [...crypto.createHash("sha256").update(bytes).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
}

export function allowedOrigin(origin, extensionId) {
  return /^[a-p]{32}$/.test(extensionId) && origin === `chrome-extension://${extensionId}`;
}

export function allowedRequest(req, extensionId, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const values = (name) => req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name);
  if (values("host").length !== 1 || !hosts.has(req.headers.host) || values("origin").length > 1) return false;
  if (req.headers.origin !== undefined) return allowedOrigin(req.headers.origin, extensionId);
  return req.method === "GET" || req.method === "HEAD" ||
    (values("x-reviewer-native").length === 1 && req.headers["x-reviewer-native"] === "1");
}
