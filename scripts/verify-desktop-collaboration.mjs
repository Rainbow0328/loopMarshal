import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

// Read-only acceptance against a running client. This never boots an isolated
// Core, launches a vendor CLI, impersonates a member, or removes session data.
const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://127.0.0.1:42688" },
    "session-id": { type: "string" },
    "correlation-id": { type: "string", default: "desktop-todo-acceptance" },
    marker: { type: "string", default: "DESKTOP_COLLAB_ACCEPTED" },
    output: { type: "string" },
  },
});
assert.ok(
  values["session-id"],
  "Provide --session-id for the session visible in the client.",
);
const baseUrl = values["base-url"],
  sessionId = values["session-id"];
const authResponse = await fetch(`${baseUrl}/api/local-auth`);
assert.ok(authResponse.ok, "The desktop Core must already be running.");
const { token } = await authResponse.json();
const client = createLoopMarshalClient({
  baseUrl,
  headers: { "x-loopmarshal-management-token": token },
});
const [sessions, members, messages, deliveries, knowledge] = await Promise.all([
  client.listSessions(),
  client.listMemberRoutes(sessionId),
  client.listMessages(sessionId),
  client.listDeliveries(sessionId),
  client.listKnowledge({ sessionId }),
]);
const session = sessions.find((item) => item.id === sessionId);
assert.ok(
  session,
  "The collaboration session must be present in the client's session list.",
);
assert.equal(
  deliveries.filter((item) =>
    ["queued", "delivering", "awaiting_result"].includes(item.state),
  ).length,
  0,
  "The collaboration is still running; repeat after it finishes.",
);
const host = members.find((item) => item.agent.role === "host");
const worker = members.find((item) => item.agent.role === "worker");
const keeper = members.find((item) => item.agent.role === "knowledge_keeper");
assert.ok(
  host && worker && keeper,
  "Host, Worker and Keeper must belong to this same session.",
);
for (const member of [host, worker, keeper]) {
  assert.equal(member.route.accessMode, "managed_proxy");
  assert.equal(member.route.bindingStatus, "ready");
  assert.ok(
    member.route.binding.nativeSessionId &&
      !member.route.binding.nativeSessionId.startsWith("loopmarshal-pending:"),
  );
}
const task = messages.find(
  (item) =>
    item.correlationId === values["correlation-id"] &&
    item.type === "task" &&
    item.fromAgentId === host.agent.id &&
    item.toAgentId === worker.agent.id,
);
assert.ok(
  task,
  "The Host must dispatch the real task to the registered Worker.",
);
const workerDelivery = deliveries.find((item) => item.messageId === task.id);
assert.equal(
  workerDelivery?.state,
  "completed",
  "The Worker must finish the dispatched task.",
);
assert.equal(task.processingStatus, "processed");
assert.equal(
  workerDelivery.snapshot.binding.nativeSessionId,
  worker.route.binding.nativeSessionId,
);
const workerReport = messages.find(
  (item) => item.id === workerDelivery.resultMessageId,
);
assert.equal(
  workerReport?.processingStatus,
  "processed",
  "The Host must consume the Worker's report.",
);
const maintenance = deliveries.find(
  (item) =>
    item.targetAgentId === keeper.agent.id &&
    item.state === "completed" &&
    messages.some(
      (message) =>
        message.id === item.messageId &&
        message.correlationId === task.correlationId,
    ),
);
assert.ok(maintenance, "The Keeper must finish maintenance for this task.");
assert.equal(
  maintenance.snapshot.binding.nativeSessionId,
  keeper.route.binding.nativeSessionId,
);
const maintenanceReport = messages.find(
  (item) => item.id === maintenance.resultMessageId,
);
assert.equal(
  maintenanceReport?.processingStatus,
  "processed",
  "The Host must consume the Keeper's maintenance report.",
);
const finalReport = messages.find(
  (item) =>
    item.fromAgentId === host.agent.id &&
    item.type === "result" &&
    item.createdAt >= task.createdAt &&
    item.payload?.status === "ready_for_review" &&
    item.payload?.content?.includes(values.marker),
);
assert.ok(
  finalReport,
  "The Host must return the final acceptance after reviewing reports.",
);
const hostDelivery = deliveries.find(
  (item) => item.resultMessageId === finalReport.id,
);
assert.equal(hostDelivery?.state, "completed");
assert.equal(
  hostDelivery.snapshot.binding.nativeSessionId,
  host.route.binding.nativeSessionId,
);
const currentKnowledge = [];
for (const ref of knowledge.filter(
  (item) => item.updatedAt >= task.createdAt,
)) {
  const [document, changes] = await Promise.all([
    client.getKnowledge(ref.level, ref.slug, sessionId),
    client.listKnowledgeChanges({
      sessionId,
      level: ref.level,
      slug: ref.slug,
      limit: 1,
    }),
  ]);
  assert.ok(
    !`${document.content}\n${document.summary ?? ""}`.includes("␠"),
    `Knowledge ${ref.slug} still substitutes visible symbols for real spaces.`,
  );
  currentKnowledge.push({
    level: document.level,
    slug: document.slug,
    version: document.version,
    content: document.content,
    latestChange: changes[0]
      ? {
          sourceKind: changes[0].sourceKind,
          sourceAgentId: changes[0].sourceAgentId,
          summary: changes[0].summary,
        }
      : null,
  });
}
assert.ok(
  currentKnowledge.some((item) => /todo|待办/i.test(item.content)),
  "Session knowledge must describe the implemented project.",
);
assert.ok(
  currentKnowledge.some((item) => /node\s+--test/.test(item.content)),
  "Session knowledge must contain the verified test command.",
);
const probe = currentKnowledge.find(
  (item) => item.slug === "text-roundtrip-probe",
);
if (probe)
  assert.equal(
    probe.content,
    'node --test\n连续空格：A  B\n中文与引号："保持原文"',
    "Knowledge must preserve the exact original text.",
  );
const evidence = {
  checkedAt: new Date().toISOString(),
  passed: true,
  baseUrl,
  sessionId,
  sessionName: session.name,
  validationScope: "transport_and_recorded_collaboration",
  limitations: [
    "Recorded messages establish dispatch, consumption and reports; they do not prove unattended setup or correct semantic knowledge classification.",
    "Knowledge may be subsequently corrected manually. Use the acceptance record and knowledge change history to identify authorship.",
  ],
  projectPath: session.projectPath,
  members: [host, worker, keeper].map((item) => ({
    name: item.agent.agentName,
    role: item.agent.role,
    tool: item.installation.toolId,
    nativeSessionId: item.route.binding.nativeSessionId,
  })),
  checks: {
    persistentDesktopSession: true,
    hostDispatchedTask: true,
    workerCompletedTask: true,
    hostConsumedWorkerReport: true,
    keeperCompletedMaintenanceTask: true,
    hostConsumedKeeperReport: true,
    hostAcceptedWork: true,
    nativeSessionBindingsPreserved: true,
    knowledgeCommandsContainRealSpaces: true,
    ...(probe ? { exactKnowledgeTextRoundTrip: true } : {}),
  },
  messages: {
    task: task.id,
    workerReport: workerReport.id,
    keeperReport: maintenanceReport.id,
    finalReport: finalReport.id,
  },
  knowledge: currentKnowledge.map(({ content, ...ref }) => ref),
  earlierFailedDeliveries: deliveries
    .filter((item) => ["failed", "blocked", "unknown"].includes(item.state))
    .map((item) => ({ id: item.id, state: item.state, error: item.error })),
};
if (values.output) {
  const path = resolve(values.output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n");
}
console.log(JSON.stringify(evidence, null, 2));
