import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extensionIdFor } from "../native/extension-origin.mjs";

test("native service refuses unrelated extensions, rebinding and originless mutations", async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer-security-"));
  await fs.mkdir(path.join(fixture, "native"));
  await fs.mkdir(path.join(fixture, "extension"));
  await fs.mkdir(path.join(fixture, "cache"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "extension/manifest.json"), "utf8"));
  await fs.writeFile(path.join(fixture, "extension/manifest.json"), JSON.stringify(manifest));
  await fs.copyFile(path.join(root, "native/extension-origin.mjs"), path.join(fixture, "native/extension-origin.mjs"));
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const source = await fs.readFile(path.join(root, "native/server.mjs"), "utf8");
  assert.ok(source.includes("const port = 8765;"));
  await fs.writeFile(path.join(fixture, "native/server.mjs"), source.replace("const port = 8765;", `const port = ${port};`));
  const child = spawn(process.execPath, [path.join(fixture, "native/server.mjs")], {windowsHide:true, stdio:"ignore"});
  const base = `http://127.0.0.1:${port}`;
  const origin = `chrome-extension://${extensionIdFor(manifest, path.join(fixture, "extension"))}`;
  const request = (pathname, method = "GET", headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(base+pathname, {method, headers}, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks).toString()}));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("request timed out")));
    req.end();
  });
  try {
    let ready = false;
    for (let attempt=0; attempt<50; attempt++) {
      try { ready = (await request("/health")).status === 200; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "isolated helper started");
    const marker = "%PDF-1.7 security-fixture";
    const filename = "0123456789abcdef01234567.pdf";
    await fs.writeFile(path.join(fixture, "cache", filename), marker);
    for (const attacker of ["chrome-extension://"+"a".repeat(32), "chrome-extension://"+extensionIdFor(manifest,path.join(fixture,"extension"))+".evil",
                            "https://attacker.example", "null", origin+"/"]) {
      assert.equal((await request("/convert","POST",{Origin:attacker})).status,403);
      const denied = await request("/file/"+filename,"GET",{Origin:attacker});
      assert.equal(denied.status,403);
      assert.equal(denied.headers["access-control-allow-origin"],undefined);
    }
    assert.equal((await request("/convert","POST")).status,403);
    assert.equal((await request("/health","GET",{Host:`attacker.example:${port}`})).status,403);
    assert.equal((await request("/health","GET",{Origin:[origin,origin]})).status,403);
    const pdf = await request("/file/"+filename,"GET",{Origin:origin});
    assert.equal(pdf.status,200);
    assert.equal(pdf.body,marker);
    assert.equal(pdf.headers["access-control-allow-origin"],origin);
    assert.equal((await request("/unused","POST",{Origin:origin})).status,404);
    assert.equal((await request("/unused","POST",{"X-Reviewer-Native":"1"})).status,404);
    assert.equal((await request("/convert","OPTIONS",{Origin:origin})).status,204);
    assert.equal((await request("/shutdown","POST",{"X-Reviewer-Native":"1"})).status,200);
    await new Promise((resolve) => child.once("exit",resolve));
  } finally {
    if (child.exitCode === null) child.kill();
    await fs.rm(fixture,{recursive:true,force:true});
  }
});
