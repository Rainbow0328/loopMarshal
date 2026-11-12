const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { CoreSupervisor } = require("../src/core-supervisor.cjs");

function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "loopmarshal-desktop-supervisor-"));
  const runtime = process.execPath; const entry = join(root, "child.cjs");
  mkdirSync(join(root, "data")); writeFileSync(entry, body);
  const supervisor = new CoreSupervisor({ resourceDirectory: root, dataDirectory: join(root, "data"), runtimePath: runtime, coreHostPath: entry, startupTimeout: 5000, shutdownTimeout: 1000 });
  return { root, supervisor };
}

test("waits for an explicit Core-ready message and shuts down the owned child gracefully", async () => {
  const f = fixture('process.send({type:"ready",baseUrl:"http://127.0.0.1:42688",nodeVersion:process.version});process.on("message",m=>{if(m.type==="shutdown")process.exit(0)});');
  try {
    const info = await f.supervisor.start(); assert.equal(info.type, "ready"); assert.equal(info.baseUrl, "http://127.0.0.1:42688");
    await f.supervisor.stop(); assert.equal(f.supervisor.child, null);
  } finally { await f.supervisor.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("surfaces a startup failure and never leaves an owned child running", async () => {
  const f = fixture('process.send({type:"startup_error",code:"EADDRINUSE",message:"occupied"});process.exit(1);');
  try {
    await assert.rejects(f.supervisor.start(), (error) => error.code === "EADDRINUSE" && /occupied/.test(error.message));
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(f.supervisor.child, null);
  } finally { await f.supervisor.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("terminates only its owned child when graceful shutdown times out", async () => {
  const f = fixture('process.send({type:"ready",baseUrl:"http://127.0.0.1:42688"});process.on("message",m=>{if(m.type==="shutdown")process.send({type:"stopped"})});');
  try { await f.supervisor.start(); await f.supervisor.stop(); assert.equal(f.supervisor.child, null); }
  finally { await f.supervisor.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("reports a missing runtime and clears process ownership", async () => {
  const f = fixture(""); f.supervisor.runtimePath = join(f.root, "missing-node.exe");
  try { await assert.rejects(f.supervisor.start(), /无法启动内置运行时/); assert.equal(f.supervisor.child, null); }
  finally { await f.supervisor.stop(); rmSync(f.root, { recursive: true, force: true }); }
});

test("can restart with the same data directory and still reports an unexpected exit", async () => {
  const f = fixture('process.send({type:"ready",baseUrl:"http://127.0.0.1:42688"});process.on("message",m=>{if(m.type==="shutdown")process.exit(0);if(m.type==="crash")process.exit(2)});');
  try {
    await f.supervisor.start(); await f.supervisor.stop(); await f.supervisor.start();
    const exited = new Promise((resolve) => f.supervisor.once("unexpected-exit", resolve));
    f.supervisor.child.send({ type: "crash" }); assert.equal((await exited).code, 2); assert.equal(f.supervisor.child, null);
  } finally { await f.supervisor.stop(); rmSync(f.root, { recursive: true, force: true }); }
});
