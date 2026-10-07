import crypto from "node:crypto";

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function extensionIdFromManifestKey(key) {
  if (typeof key !== "string" || !key) return "";

  let publicKey;
  try {
    publicKey = Buffer.from(key, "base64");
  } catch {
    return "";
  }
  if (!publicKey.length) return "";

  const digest = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((value) => String.fromCharCode(97 + value))
    .join("");
}

export function allowedOrigin(origin, extensionId) {
  if (!origin) return true;
  return EXTENSION_ID_PATTERN.test(extensionId) && origin === `chrome-extension://${extensionId}`;
}

export function allowedRequest(req, extensionId, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const count = (name) => req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
  if (count("host") !== 1 || !hosts.has(req.headers.host) || count("origin") > 1) return false;
  if (req.headers.origin !== undefined) return !!req.headers.origin && allowedOrigin(req.headers.origin, extensionId);
  return req.method === "GET" || req.method === "HEAD" ||
    (count("x-reviewer-native") === 1 && req.headers["x-reviewer-native"] === "1");
}
