import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

const directory = await mkdtemp(join(tmpdir(), "loopmarshal-routing-smoke-"));
const databasePath = join(directory, "core.sqlite");
const namespace = join(directory, "native-data");
const workspace = join(directory, "project A 中文");
await mkdir(join(namespace, "sessions"), { recursive: true });
await mkdir(workspace);
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(directory, "knowledge");
const cli = resolve("apps/cli/dist/apps/cli/src/index.js");
const script = join(directory, "mock-codex.cjs");
await writeFile(
  script,
  `
const fs = require('fs'), path = require('path');
if (process.argv.includes('--version')) { console.log('codex fixture-1'); process.exit(0); }
const resume = process.argv.indexOf('resume'); const id = process.argv[resume + 1];
const file = path.join(process.env.CODEX_HOME, 'sessions', id + '.jsonl');
const records = fs.readFileSync(file, 'utf8').trim().split('\\n').map(JSON.parse);
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', text => prompt += text);
process.stdin.on('end', () => {
  fs.appendFileSync(file, JSON.stringify({ type:'user', sessionId:id, cwd:process.cwd(), prompt }) + '\\n');
  console.log(JSON.stringify({type:'thread.started',thread_id:id}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:records[0].payload.historyMarker}}));
  console.log(JSON.stringify({type:'turn.completed'}));
});
`,
);
for (const [id, marker] of [
  ["native-one", "history-one"],
  ["native-two", "history-two"],
]) {
  await writeFile(
    join(namespace, "sessions", `${id}.jsonl`),
    JSON.stringify({
      type: "session_meta",
      payload: { id, cwd: workspace, historyMarker: marker },
    }) + "\n",
  );
}
let instance;
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function boot() {
  instance = await startCoreServer({
    host: "127.0.0.1",
    port: 0,
    databasePath,
  });
  const address = instance.server.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
  return {
    baseUrl,
    token,
    client: createLoopMarshalClient({
      baseUrl,
      headers: { "x-loopmarshal-management-token": token },
    }),
  };
}
async function runCli(baseUrl, args) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      LOOPMARSHAL_BASE_URL: baseUrl,
      LOOPMARSHAL_DATABASE_PATH: databasePath,
      LOOPMARSHAL_CLI_STATE_DIR: join(directory, "cli-state"),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    error = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (error += chunk));
  const exitCode = await new Promise((done, fail) => {
    child.on("error", fail);
    child.on("close", done);
  });
  if (exitCode !== 0) throw new Error(`CLI failed: ${output || error}`);
  return JSON.parse(output);
}
async function awaitDelivery(client, sessionId) {
  for (let index = 0; index < 100; index++) {
    const delivery = (await client.listDeliveries(sessionId))[0];
    if (delivery?.state === "completed") return delivery;
    if (delivery && ["failed", "unknown", "blocked"].includes(delivery.state))
      throw new Error(`Delivery ${delivery.state}: ${delivery.error}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Proxy smoke delivery timed out");
}
try {
  let { client, baseUrl, token } = await boot();
  let duplicateRejected = false;
  try {
    await startCoreServer({ host: "127.0.0.1", port: 0, databasePath });
  } catch (error) {
    duplicateRejected = String(error).includes("另一个 Core");
  }
  assert(
    duplicateRejected,
    "A second Core must not take over a live Core's database",
  );
  const denied = await fetch(`${baseUrl}/api/tool-installations`);
  assert(denied.status === 403, "Management must require a credential");
  const rebound = await instance.server.inject({
    method: "GET",
    url: "/api/local-auth",
    headers: { host: "untrusted.example", origin: "http://untrusted.example" },
    remoteAddress: "127.0.0.1",
  });
  assert(
    rebound.statusCode === 403,
    "A foreign hostname must not obtain local management credentials",
  );
  const crossOrigin = await fetch(`${baseUrl}/api/tool-installations`, {
    headers: {
      Origin: "https://untrusted.example",
      "x-loopmarshal-management-token": token,
    },
  });
  assert(
    crossOrigin.status === 403,
    "Cross-origin proxy management must be rejected",
  );
  await runCli(baseUrl, [
    "attach",
    "主控",
    "--session",
    "test",
    "--role",
    "host",
    "--duty",
    "Coordinate",
  ]);
  const session = await client.getSessionByName("test");
  const installation = await client.createToolInstallation({
    toolId: "codex",
    displayName: "fixture",
    executablePath: process.execPath,
    executableArgs: [script],
  });
  const members = [];
  for (const [name, id] of [
    ["前端开发", "native-one"],
    ["后端开发", "native-two"],
  ]) {
    const member = await client.createProxyMember(session.id, {
      agentName: name,
      roleDescription: "Implement tasks",
      binding: {
        installationId: installation.id,
        workspacePath: workspace,
        runtimeNamespace: namespace,
        nativeSessionId: id,
      },
    });
    await client.verifyMemberRoute(
      session.id,
      member.agent.id,
      member.route.bindingVersion,
    );
    members.push(member);
  }
  const waiting = await client.joinSession(session.id, {
    agentName: "代码审查",
    displayName: "代码审查",
    role: "worker",
    roleDescription: "Review code",
    platform: "unadapted-tool",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  await runCli(baseUrl, [
    "dispatch-many",
    "主控",
    "--session",
    "test",
    "--task",
    "前端开发::Implement the frontend",
  ]);
  const first = await awaitDelivery(client, session.id);
  const report = await client.getMessageById(first.resultMessageId);
  assert(
    report.payload.result === "history-one",
    "Proxy must load the bound history",
  );
  assert(
    first.targetAgentId === members[0].agent.id &&
      report.toAgentId === session.hostAgentId,
    "Report routing must be exact",
  );
  assert(
    (await client.claimNext(members[0].agent.id)) === null,
    "Legacy await must not claim proxy tasks",
  );
  await runCli(baseUrl, [
    "dispatch-many",
    "主控",
    "--session",
    "test",
    "--task",
    "代码审查::Review frontend",
  ]);
  const legacyTask = await client.claimNext(waiting.agent.id);
  assert(
    legacyTask?.toAgentId === waiting.agent.id,
    "Waiting-chain member must receive its task without native identity",
  );
  await client.completeMessage(legacyTask.id, { agentId: waiting.agent.id });
  await instance.close();
  instance = null;
  ({ client, baseUrl } = await boot());
  await runCli(baseUrl, [
    "dispatch-many",
    "主控",
    "--session",
    "test",
    "--task",
    "前端开发::Continue the original task",
  ]);
  const second = await awaitDelivery(client, session.id);
  assert(
    second.id !== first.id &&
      second.snapshot.binding.nativeSessionId === "native-one",
    "Restart must continue the same native session",
  );
  const oneRecords = (
    await readFile(join(namespace, "sessions", "native-one.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  const twoRecords = (
    await readFile(join(namespace, "sessions", "native-two.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  assert(
    oneRecords.length === 3 && twoRecords.length === 1,
    "Only the addressed native history may change",
  );
  let hostReport;
  while ((hostReport = await client.claimNext(session.hostAgentId)))
    await client.completeMessage(hostReport.id, {
      agentId: session.hostAgentId,
    });
  await client.leaveAgent(waiting.agent.id);
  await client.sendByName({
    sessionName: "test",
    from: "主控",
    to: ["前端开发"],
    type: "announcement",
    content: "Informational only",
    idempotencyKey: "notice-1",
  });
  await client.updateWindowBindingDefaults("test", "主控", {
    intervalSeconds: 1,
    maxRounds: 1,
  });
  const idle = await runCli(baseUrl, ["await", "主控", "--session", "test"]);
  assert(
    idle.op === "PROCESS_SESSION_IDLE" && idle.status === "all_workers_waiting",
    "Idle native members must not need a waiting process",
  );
  console.log(
    JSON.stringify({
      passed: true,
      originalHostCommand: true,
      mixedWaitingChain: true,
      exactSession: true,
      nativeTurns: 2,
      restartPreservedBinding: true,
      managementAuth: true,
      exclusiveCore: true,
      proxyIdleWithoutWaiter: true,
    }),
  );
} finally {
  if (instance) await instance.close();
  await rm(directory, { recursive: true, force: true });
}
