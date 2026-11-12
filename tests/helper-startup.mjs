import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const hooks = {};
const event = {addListener() {}};
let probes = 0;
let nativeStarts = 0;
let nativeRequests = 0;
const storage = {};
const context = vm.createContext({
  __CWR_BACKGROUND_TEST_HOOKS__: hooks,
  AbortController, clearTimeout, console,
  setTimeout: (fn, ms) => setTimeout(fn, ms === 300 ? 0 : ms),
  fetch: async () => {
    probes++;
    if (probes === 1) throw new TypeError("helper is still starting");
    if (probes === 2) return {ok:true,json:async()=>({ok:true,service:"Classroom Office Reviewer",version:"old"})};
    return {ok:true, json:async()=>({ok:true,service:"Classroom Office Reviewer",version:"test",sessionId:"session"})};
  },
  chrome: {
    runtime: {onMessage:event, getManifest:()=>({version:"test"}), connectNative:()=>{
      nativeStarts++;
      return {onDisconnect:event,onMessage:event,postMessage:(message)=>{assert.equal(message.type,"ensure-started");nativeRequests++;}};
    }},
    tabs:{onRemoved:event},
    storage:{local:{get:async()=>storage,remove:async()=>{},set:async(values)=>Object.assign(storage,values)}}
  }
});
vm.runInContext(source, context);
const [first, second] = await Promise.all([hooks.helperHealth(), hooks.helperHealth()]);
assert.equal(first.ok, true);
assert.equal(second.sessionId, "session");
assert.equal(probes, 3, "parallel callers share retries while the helper starts");
assert.equal(nativeStarts, 1, "one native launch for concurrent PDF/cache requests");
assert.equal(storage.classroomWordReviewerHelperSession, "session");
await hooks.helperHealth();
assert.equal(nativeStarts,1,"reuse the existing native host");
assert.equal(nativeRequests,1,"check startup again if a previously running helper stopped");
console.log("Helper startup retries transient connection failures and shares one launch across concurrent requests.");
