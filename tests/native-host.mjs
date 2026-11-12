import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

test("native host sends framed readiness and consumes partial incoming frames", {skip:process.platform !== "win32"}, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "reviewer native test-"));
  const host = await fs.readFile(new URL("../native/Native-Host.ps1", import.meta.url));
  await fs.writeFile(path.join(fixture,"Native-Host.ps1"),host);
  await fs.writeFile(path.join(fixture,"Start-Reviewer.ps1"),"param([switch]$Quiet)\nif (-not $Quiet) { throw 'Native stdout must stay binary' }\nAdd-Content -LiteralPath (Join-Path $PSScriptRoot 'started') -Value 'start'\n");
  await fs.writeFile(path.join(fixture,"Stop-Reviewer.ps1"),"Set-Content -LiteralPath (Join-Path $PSScriptRoot 'stopped') -Value 'ok'\n");
  const child = spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(fixture,"Native-Host.ps1")],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let bytes = Buffer.alloc(0);
  let stderr = "";
  child.stderr.on("data",data=>{stderr+=data;});
  const exited = new Promise(resolve=>child.once("exit",resolve));
  try {
    await new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>reject(new Error("Native readiness timed out: "+stderr)),10000);
      child.stdout.on("data",data=>{
        bytes=Buffer.concat([bytes,data]);
        if(bytes.length>=4 && bytes.length>=4+bytes.readUInt32LE(0)) {clearTimeout(timer);resolve();}
      });
      child.once("error",error=>{clearTimeout(timer);reject(error);});
    });
    assert.deepEqual(JSON.parse(bytes.subarray(4).toString("utf8")),{ok:true});
    const payload=Buffer.from('{"type":"ensure-started"}');
    const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);
    const frame=Buffer.concat([header,payload]);
    for(const byte of frame) child.stdin.write(Buffer.from([byte]));
    child.stdin.end();
    assert.equal(await exited,0,stderr);
    assert.equal((await fs.readFile(path.join(fixture,"stopped"),"utf8")).trim(),"ok");
    assert.equal((await fs.readFile(path.join(fixture,"started"),"utf8")).trim().split(/\r?\n/).length,2,"an existing native connection can restart the helper");
  } finally {
    if(child.exitCode===null) {child.kill();await exited;}
    assert.equal(path.dirname(path.resolve(fixture)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture).startsWith("reviewer native test-"));
    await fs.rm(fixture,{recursive:true,force:true});
  }
});
