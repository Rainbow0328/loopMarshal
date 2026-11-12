import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

const { values } = parseArgs({
  options: { executable: { type: "string" }, namespace: { type: "string" } },
});
if (!values.executable || !values.namespace)
  throw new Error(
    "Provide --executable and an isolated or explicitly selected --namespace",
  );
const root = await mkdtemp(join(tmpdir(), "loopmarshal-codex-first-host-"));
const workspace = join(root, "project");
await mkdir(workspace);
await writeFile(
  join(workspace, "README.md"),
  "# Isolated Codex Host verification\n",
);
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
const config = {
  host: "127.0.0.1",
  port: 0,
  databasePath: join(root, "core.sqlite"),
};
let core;
async function boot() {
  core = await startCoreServer(config);
  const baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
  return createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
}
async function waitForDelivery(client, sessionId, messageId) {
  const deadline = Date.now() + 300000;
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
        delivery.error ?? "Codex Host delivery did not complete",
      );
      const report = await client.getMessageById(delivery.resultMessageId);
      assert.equal(report.toAgentId, delivery.replyToAgentId);
      return { delivery, report };
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("Timed out waiting for the real Codex Host response");
}

try {
  let client = await boot();
  const installation = await client.createToolInstallation({
    toolId: "codex",
    displayName: "Isolated Codex Host",
    executablePath: resolve(values.executable),
  });
  const setup = await client.createSessionSetup({
    sessionName: `Codex 首条消息验收 ${Date.now()}`,
    projectPath: workspace,
    agents: [
      {
        role: "host",
        name: "Codex Host",
        duty: "Answer the user's workbench messages",
        mode: "managed_proxy",
        nativeSessionMode: "create",
        binding: {
          installationId: installation.id,
          workspacePath: workspace,
          runtimeNamespace: resolve(values.namespace),
        },
      },
    ],
  });
  assert.deepEqual(setup.warnings, []);
  const host = setup.members.find((member) => member.role === "host");
  assert.ok(host);
  const pendingRoute = (await client.listMemberRoutes(setup.session.id)).find(
    (member) => member.agent.id === host.id,
  ).route;
  assert.equal(pendingRoute.bindingStatus, "initializing");
  assert.ok(
    pendingRoute.binding.nativeSessionId.startsWith("loopmarshal-pending:"),
  );

  async function send(content, key, expectedText) {
    const message = await client.sendMessage({
      sessionId: setup.session.id,
      fromAgentId: host.id,
      toAgentId: host.id,
      type: "instruction",
      idempotencyKey: key,
      payload: { kind: "web_user_message", content },
    });
    const { delivery, report } = await waitForDelivery(
      client,
      setup.session.id,
      message.id,
    );
    assert.equal(typeof report.payload?.content, "string");
    assert.match(report.payload.content, new RegExp(expectedText));
    assert.equal(
      delivery.snapshot.binding.nativeSessionId,
      report.payload.nativeSessionId,
    );
    return delivery.snapshot.binding.nativeSessionId;
  }

  const firstNativeSessionId = await send(
    "Reply exactly FIRST_HOST_MESSAGE_OK. Do not call tools or change files.",
    "first-host-message",
    "FIRST_HOST_MESSAGE_OK",
  );
  assert.ok(
    firstNativeSessionId &&
      !firstNativeSessionId.startsWith("loopmarshal-pending:"),
  );
  await core.close();
  core = null;
  client = await boot();
  const secondNativeSessionId = await send(
    "Reply exactly CONTINUED_HOST_HISTORY_OK. Do not call tools or change files.",
    "second-host-message",
    "CONTINUED_HOST_HISTORY_OK",
  );
  assert.equal(
    secondNativeSessionId,
    firstNativeSessionId,
    "The follow-up did not resume the exact session created by the first Host message",
  );

  const evidence = {
    passed: true,
    tool: "codex",
    actualCli: true,
    firstMessageCreatedNativeSession: true,
    followUpResumedSameNativeSession: true,
    coreRestartPreservedBinding: true,
    sessionId: setup.session.id,
    nativeSessionId: firstNativeSessionId,
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
