import assert from "node:assert/strict";

const previousWindow = Object.getOwnPropertyDescriptor(globalThis,"window");
const previousParent = Object.getOwnPropertyDescriptor(globalThis,"parent");
let onMessage;
const messages = [];
const parentFrame = {postMessage:(message,origin)=>messages.push({message,origin})};
try {
  globalThis.window = {addEventListener:(type,listener)=>{if(type==="message") onMessage=listener;}};
  globalThis.parent = parentFrame;
  await import("../extension/bulk-zip.js?bootstrap-regression");
  assert.equal(messages.length,1,"初期化後に親へ準備完了を通知する");
  assert.equal(messages[0].message.type,"cwr-zip-ready");
  assert.equal(messages[0].origin,"https://classroom.google.com");
  onMessage({origin:"https://example.invalid",source:parentFrame,data:{type:"cwr-zip-ping"}});
  onMessage({origin:"https://classroom.google.com",source:{},data:{type:"cwr-zip-ping"}});
  assert.equal(messages.length,1,"無関係な送信元には応答しない");
  onMessage({origin:"https://classroom.google.com",source:parentFrame,data:{type:"cwr-zip-ping"}});
  assert.equal(messages.length,2,"初回通知を取り逃しても準備完了を再確認できる");
  assert.equal(messages[1].message.type,"cwr-zip-ready");
} finally {
  if(previousWindow) Object.defineProperty(globalThis,"window",previousWindow); else delete globalThis.window;
  if(previousParent) Object.defineProperty(globalThis,"parent",previousParent); else delete globalThis.parent;
}
console.log("ZIP frame bootstrap acknowledges only its Classroom parent and supports readiness rechecks.");
