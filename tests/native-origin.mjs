import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { allowedOrigin, extensionIdFromManifestKey } from "../native/extension-origin.mjs";

const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const server = await readFile(new URL("../native/server.mjs", import.meta.url), "utf8");
const extensionId = extensionIdFromManifestKey(manifest.key);
const allowedExtensionOrigin = `chrome-extension://${extensionId}`;

assert.match(extensionId, /^[a-p]{32}$/);
assert.equal(extensionId, "dbafjkigeiajjijjijmplmoodkiclcgg");
assert(server.includes("extensionIdFromManifestKey(manifest.key)"));
assert(server.includes("isAllowedOrigin(origin, allowedExtensionId)"));

assert.equal(allowedOrigin(allowedExtensionOrigin, extensionId), true);
assert.equal(allowedOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", extensionId), false);
assert.equal(allowedOrigin("https://example.invalid", extensionId), false);
assert.equal(allowedOrigin("", extensionId), true);

console.log(`Native helper accepts only ${allowedExtensionOrigin} and keeps origin-less local control requests working.`);
