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
