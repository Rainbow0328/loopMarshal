import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    workspace: { type: "string" },
    namespace: { type: "string" },
    session: { type: "string" },
    marker: { type: "string" },
    "other-session-file": { type: "string" },
  },
});
for (const key of [
  "executable",
  "workspace",
  "namespace",
  "session",
  "marker",
  "other-session-file",
])
  if (!values[key]) throw new Error(`Missing --${key}`);
const directory = await mkdtemp(join(tmpdir(), "loopmarshal-codex-knowledge-"));
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(directory, "knowledge");
process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
  directory,
  "preferences.json",
);
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const otherHash = await hash(values["other-session-file"]);
const core = await startCoreServer({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "core.sqlite"),
});
try {
  const baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  const { token } = await (await fetch(baseUrl + "/api/local-auth")).json();
  const client = createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
  const installation = await client.createToolInstallation({
    toolId: "codex",
    displayName: "Real Codex Keeper",
    executablePath: resolve(values.executable),
  });
  const created = await client.attachSession({
    sessionName: "Codex 会话知识维护验收",
    projectPath: resolve(values.workspace),
    agentName: "主控",
    role: "host",
    roleDescription: "验收知识维护结果",
  });
  const { agent: keeper } = await client.attachSession({
    sessionName: created.session.name,
    agentName: "知识库维护者",
    role: "knowledge_keeper",
    roleDescription: "使用本次执行的工具桥读写当前会话知识，不修改项目文件",
  });
  const member = await client.updateMemberRoute(created.session.id, keeper.id, {
    accessMode: "managed_proxy",
    expectedBindingVersion: 1,
    reason: "真实知识维护验收",
    binding: {
      installationId: installation.id,
      workspacePath: resolve(values.workspace),
      runtimeNamespace: resolve(values.namespace),
      nativeSessionId: values.session,
      endpoint: null,
    },
  });
  await client.verifyMemberRoute(
    created.session.id,
    keeper.id,
    member.route.bindingVersion,
  );
  await client.upsertKnowledge({
    sessionId: created.session.id,
    level: "l1",
    slug: "session-project",
    title: "会话项目",
    content: `项目目录：${created.session.projectPath}`,
  });
  const sent = await client.sendMessage({
    sessionId: created.session.id,
    fromAgentId: created.agent.id,
    toAgentId: keeper.id,
    type: "task",
    payload:
      "Acceptance task for your current role knowledge_keeper. Use the automatically configured loopmarshal MCP server tools directly for every collaboration call. First session_context and knowledge_read l1/session-project. Then knowledge_update l2/acceptance-check with title 'Verified session facts' and content containing the selected project directory plus the original private history verification token from earlier in this conversation (this prompt does not contain it). Finally knowledge_read that document to verify persistence. Do not use the command bridge or temporary script for this acceptance: we are verifying native MCP loading. Do not modify any project files. Do not enter await. Report the written ref and verification token in your final response.",
  });
  let delivery;
  for (let n = 0; n < 480; n++) {
    delivery = (await client.listDeliveries(created.session.id)).find(
      (d) => d.messageId === sent.id,
    );
    if (
      delivery &&
      ["completed", "failed", "blocked", "unknown"].includes(delivery.state)
    )
      break;
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.equal(
    delivery?.state,
    "completed",
    delivery?.error ?? "Keeper did not complete",
  );
  const document = await client.getKnowledge(
    "l2",
    "acceptance-check",
    created.session.id,
  );
  assert.ok(
    document.content.includes(values.marker),
    "Saved native history was not written into the session knowledge",
  );
  assert.ok(
    document.content
      .toLowerCase()
      .includes(resolve(values.workspace).toLowerCase()),
  );
  const report = await client.getMessageById(delivery.resultMessageId);
  assert.equal(report.payload.kind, "knowledge_maintenance_report");
  assert.equal(report.toAgentId, created.agent.id);
  assert.equal(await hash(values["other-session-file"]), otherHash);
  assert.equal((await readdir(join(directory, "proxy-bridges"))).length, 0);
  const events = await client.getDeliveryEvents(delivery.id);
  await writeFile(
    join(directory, "events.json"),
    JSON.stringify(events, null, 2),
  );
  for (const tool of ["session_context", "knowledge_read", "knowledge_update"])
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool_activity" &&
          event.payload?.toolType === "mcp_tool_call" &&
          event.payload?.name === tool,
      ),
      `Managed native MCP tool was not used: ${tool}`,
    );
  const evidence = {
    passed: true,
    realCodex: true,
    automaticNativeMcp: true,
    noManualSkillOrMcpSelection: true,
    exactHistory: true,
    projectContext: true,
    liveKnowledgeWriteAndRead: true,
    keeperReport: true,
    temporaryBridgeCleaned: true,
    otherSessionUnchanged: true,
    directory,
    sessionId: created.session.id,
  };
  await writeFile(
    join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error(`Knowledge acceptance evidence: ${directory}`);
  throw error;
} finally {
  await core.close();
}
