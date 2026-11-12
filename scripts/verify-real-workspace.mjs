import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

const { values } = parseArgs({
  options: {
    tool: { type: "string" },
    executable: { type: "string" },
    namespace: { type: "string" },
    workspace: { type: "string" },
    endpoint: { type: "string" },
  },
});
for (const key of ["tool", "executable", "namespace", "workspace"])
  if (!values[key]) throw new Error(`Missing --${key}`);
const tool = values.tool;
const workspace = resolve(values.workspace);
const root = await mkdtemp(
  join(tmpdir(), `loopmarshal-real-workspace-${tool}-`),
);
await mkdir(join(root, "knowledge"), { recursive: true });
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
const config = {
  host: "127.0.0.1",
  port: 0,
  databasePath: join(root, "core.sqlite"),
};
const marker = `LM_${tool.toUpperCase()}_${randomUUID().replaceAll("-", "")}`;
let core;
async function boot() {
  core = await startCoreServer(config);
  const address = core.server.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
  return createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
}
async function waitForDelivery(client, sessionId, messageId) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const delivery = (await client.listDeliveries(sessionId)).find(
      (item) => item.messageId === messageId,
    );
    if (
      delivery &&
      ["completed", "failed", "blocked", "unknown"].includes(delivery.state)
    ) {
      assert.equal(
        delivery.state,
        "completed",
        delivery.error ?? "Native delivery did not complete",
      );
      assert.ok(delivery.resultMessageId);
      return {
        delivery,
        report: await client.getMessageById(delivery.resultMessageId),
      };
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Timed out waiting for delivery ${messageId}`);
}
async function getAllDeliveryEvents(client, deliveryId) {
  const events = [];
  let after = 0;
  while (true) {
    const page = await client.getDeliveryEvents(deliveryId, after);
    events.push(...page);
    if (page.length < 200) return events;
    after = page.at(-1).sequence;
  }
}
async function waitForSessionIdle(client, sessionId) {
  const deadline = Date.now() + 5 * 60_000;
  let idleChecks = 0;
  while (Date.now() < deadline) {
    const deliveries = await client.listDeliveries(sessionId);
    const active = deliveries.some((item) =>
      ["queued", "running", "awaiting_result"].includes(item.state),
    );
    if (!active) {
      idleChecks++;
      if (idleChecks === 3) {
        assert.ok(
          deliveries.every((item) => item.state === "completed"),
          "Session has failed, blocked, or unknown deliveries",
        );
        return;
      }
    } else idleChecks = 0;
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("Session did not become idle before the restart check");
}
async function send(
  client,
  sessionId,
  fromAgentId,
  toAgentId,
  type,
  content,
  key,
) {
  const message = await client.sendMessage({
    sessionId,
    fromAgentId,
    toAgentId,
    type,
    idempotencyKey: key,
    payload:
      type === "instruction" ? { kind: "web_user_message", content } : content,
  });
  return waitForDelivery(client, sessionId, message.id);
}
try {
  let client = await boot();
  const installation = await client.createToolInstallation({
    toolId: tool,
    displayName: `真实 ${tool}`,
    executablePath: resolve(values.executable),
  });
  const binding = {
    installationId: installation.id,
    workspacePath: workspace,
    runtimeNamespace: resolve(values.namespace),
    ...(values.endpoint ? { endpoint: values.endpoint } : {}),
  };
  const setup = await client.createSessionSetup({
    sessionName: `真实项目验收-${tool}-${Date.now()}`,
    projectPath: workspace,
    agents: [
      {
        role: "host",
        name: "主控",
        duty: "理解用户目标、协调成员并验收结果",
        mode: "managed_proxy",
        nativeSessionMode: "create",
        binding,
      },
      {
        role: "worker",
        name: "执行者",
        duty: "阅读项目并完成被分配的任务",
        mode: "managed_proxy",
        nativeSessionMode: "create",
        binding,
      },
      {
        role: "knowledge_keeper",
        name: "知识库维护者",
        duty: "维护当前会话的项目知识",
        mode: "managed_proxy",
        nativeSessionMode: "create",
        binding,
      },
    ],
  });
  assert.deepEqual(setup.warnings, []);
  const host = setup.members.find((member) => member.role === "host");
  const worker = setup.members.find((member) => member.role === "worker");
  const keeper = setup.members.find(
    (member) => member.role === "knowledge_keeper",
  );
  assert.ok(host && worker && keeper);
  const getRoute = async (agentId) =>
    (await client.listMemberRoutes(setup.session.id)).find(
      (item) => item.agent.id === agentId,
    ).route;
  assert.equal((await getRoute(host.id)).bindingStatus, "initializing");
  const hostFirst = await send(
    client,
    setup.session.id,
    host.id,
    host.id,
    "instruction",
    `Reply exactly HOST_FIRST_${tool.toUpperCase()}_OK. Do not call tools or change files.`,
    `host-first-${tool}`,
  );
  const hostNativeSessionId = (await getRoute(host.id)).binding.nativeSessionId;
  assert.ok(
    hostNativeSessionId &&
      !hostNativeSessionId.startsWith("loopmarshal-pending:"),
  );
  assert.match(
    String(hostFirst.report.payload?.content ?? hostFirst.report.payload),
    new RegExp(`HOST_FIRST_${tool.toUpperCase()}_OK`),
  );
  const workerTask = await send(
    client,
    setup.session.id,
    host.id,
    worker.id,
    "task",
    `Read the selected project directory and reply exactly WORKER_${tool.toUpperCase()}_OK. Do not modify files and do not call external tools.`,
    `worker-task-${tool}`,
  );
  assert.equal(workerTask.report.toAgentId, host.id);
  assert.match(
    String(workerTask.report.payload?.content ?? workerTask.report.payload),
    new RegExp(`WORKER_${tool.toUpperCase()}_OK`),
  );
  const workerNativeSessionId = (await getRoute(worker.id)).binding
    .nativeSessionId;
  assert.ok(
    workerNativeSessionId &&
      !workerNativeSessionId.startsWith("loopmarshal-pending:"),
  );
  const keeperTask = await send(
    client,
    setup.session.id,
    host.id,
    keeper.id,
    "task",
    `Use the automatically managed MCP tools knowledge_update and knowledge_read. Write level l2 slug real-${tool} with title Real ${tool} verification and content ${marker}; reread it, then reply exactly KEEPER_${tool.toUpperCase()}_OK. Do not modify project files.`,
    `keeper-task-${tool}`,
  );
  assert.equal(keeperTask.report.toAgentId, host.id);
  assert.match(
    String(keeperTask.report.payload?.content ?? keeperTask.report.payload),
    new RegExp(`KEEPER_${tool.toUpperCase()}_OK`),
  );
  const keeperNativeSessionId = (await getRoute(keeper.id)).binding
    .nativeSessionId;
  assert.ok(
    keeperNativeSessionId &&
      !keeperNativeSessionId.startsWith("loopmarshal-pending:"),
  );
  const knowledge = await client.listKnowledge({ sessionId: setup.session.id });
  const document = knowledge.find((item) => item.slug === `real-${tool}`);
  assert.ok(document, "Knowledge keeper did not create the requested document");
  const full = await client.getKnowledge(
    document.level,
    document.slug,
    setup.session.id,
  );
  assert.match(full.content, new RegExp(marker));
  const events = await getAllDeliveryEvents(client, keeperTask.delivery.id);
  if (["codex", "claude"].includes(tool))
    for (const name of ["knowledge_update", "knowledge_read"])
      assert.ok(
        events.some(
          (event) =>
            event.type === "tool_activity" &&
            JSON.stringify(event.payload).includes(name),
        ),
        `Keeper did not use managed MCP tool ${name}`,
      );
  await waitForSessionIdle(client, setup.session.id);
  await core.close();
  core = null;
  client = await boot();
  assert.equal(
    (await getRoute(host.id)).binding.nativeSessionId,
    hostNativeSessionId,
  );
  const follow = await send(
    client,
    setup.session.id,
    host.id,
    host.id,
    "instruction",
    `Reply exactly HOST_CONTINUED_${tool.toUpperCase()}_OK. Do not call tools or change files.`,
    `host-followup-${tool}`,
  );
  assert.match(
    String(follow.report.payload?.content ?? follow.report.payload),
    new RegExp(`HOST_CONTINUED_${tool.toUpperCase()}_OK`),
  );
  const evidence = {
    passed: true,
    tool,
    workspace,
    sessionId: setup.session.id,
    nativeSessionIds: {
      host: hostNativeSessionId,
      worker: workerNativeSessionId,
      keeper: keeperNativeSessionId,
    },
    checks: {
      sessionCreatedByLoopMarshal: true,
      hostMessage: true,
      hostTaskToWorker: true,
      workerReportToHost: true,
      keeperMcpKnowledgeWriteAndRead: true,
      coreRestartPreservedHostSession: true,
      hostFollowUp: true,
    },
    evidenceDirectory: root,
  };
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (core) await core.close();
}
