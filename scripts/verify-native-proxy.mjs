import { parseArgs } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

// Explicit existing test conversations only. Never uses the user's most recent conversation.
const { values } = parseArgs({
  options: {
    tool: { type: "string" },
    executable: { type: "string" },
    workspace: { type: "string" },
    namespace: { type: "string" },
    "session-one": { type: "string" },
    "session-two": { type: "string" },
    marker: { type: "string" },
    "session-two-file": { type: "string" },
    endpoint: { type: "string" },
    "marker-two": { type: "string" },
    "environment-keys": { type: "string" },
    "args-json": { type: "string" },
  },
});
for (const key of [
  "tool",
  "executable",
  "workspace",
  "namespace",
  "session-one",
  "session-two",
  "marker",
]) {
  if (!values[key]) throw new Error(`Missing explicit --${key}`);
}
const state = await mkdtemp(join(tmpdir(), "loopmarshal-native-core-"));
const secondHistoryHash = values["session-two-file"]
  ? createHash("sha256")
      .update(await readFile(values["session-two-file"]))
      .digest("hex")
  : null;
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(state, "knowledge");
const config = {
  host: "127.0.0.1",
  port: 0,
  databasePath: join(state, "core.sqlite"),
};
let instance;
let firstAgentId;
let secondAgentId;
let sessionId;
let nativeDeliveryIds = [];
let firstBindingVersion;
async function boot() {
  instance = await startCoreServer(config);
  const address = instance.server.server.address();
  if (!address || typeof address === "string")
    throw new Error("Core port not available");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
  return createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
}
async function waitResult(
  client,
  messageId,
  nativeId = values["session-one"],
  marker = values.marker,
) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const delivery = (await client.listDeliveries(sessionId)).find(
      (item) => item.messageId === messageId,
    );
    if (
      delivery &&
      ["completed", "failed", "unknown", "blocked"].includes(delivery.state)
    ) {
      if (delivery.state !== "completed" || !delivery.resultMessageId)
        throw new Error(`Native delivery ${delivery.state}: ${delivery.error}`);
      const result = await client.getMessageById(delivery.resultMessageId);
      if (
        delivery.snapshot.binding.nativeSessionId !== nativeId ||
        result.toAgentId !== (await client.getSession(sessionId)).hostAgentId
      )
        throw new Error("Delivery/report identity mismatch");
      if (!JSON.stringify(result.payload).includes(marker))
        throw new Error(
          "Existing native conversation did not recall its private history marker",
        );
      nativeDeliveryIds.push(delivery.id);
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error("Timed out waiting for a real native report");
}
try {
  let client = await boot();
  const { session, agent: host } = await client.createSession({
    sessionName: `native-test-${Date.now()}`,
    agentName: "主控",
    displayName: "主控",
    platform: "generic",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  sessionId = session.id;
  const installation = await client.createToolInstallation({
    toolId: values.tool,
    displayName: values.tool,
    executablePath: resolve(values.executable),
    executableArgs: JSON.parse(values["args-json"] ?? "[]"),
    environmentKeys: values["environment-keys"]?.split(",") ?? [],
  });
  for (const [name, id] of [
    ["前端开发", values["session-one"]],
    ["后端开发", values["session-two"]],
  ]) {
    const member = await client.createProxyMember(sessionId, {
      agentName: name,
      roleDescription: "History continuity verification; no file changes",
      binding: {
        installationId: installation.id,
        workspacePath: resolve(values.workspace),
        runtimeNamespace: resolve(values.namespace),
        nativeSessionId: id,
        ...(values.endpoint ? { endpoint: values.endpoint } : {}),
      },
    });
    await client.verifyMemberRoute(
      sessionId,
      member.agent.id,
      member.route.bindingVersion,
    );
    if (name === "前端开发") {
      firstAgentId = member.agent.id;
      firstBindingVersion = member.route.bindingVersion;
    } else secondAgentId = member.agent.id;
  }
  for (let turn = 1; turn <= 2; turn++) {
    const message = await client.sendMessage({
      sessionId,
      fromAgentId: host.id,
      toAgentId: firstAgentId,
      type: "task",
      payload: `Verification turn ${turn}. Repeat the private verification token I asked you to remember earlier in this conversation. Output only that token. Do not call tools or change files.`,
      idempotencyKey: `continuity-${turn}`,
      correlationId: `continuity-${turn}`,
    });
    await waitResult(client, message.id);
    console.log(
      JSON.stringify({
        tool: values.tool,
        turn,
        nativeSessionId: values["session-one"],
        historyRecalled: true,
      }),
    );
  }
  if (
    (await client.listDeliveries(sessionId)).some(
      (item) => item.targetAgentId === secondAgentId,
    )
  )
    throw new Error("Other member received an unexpected delivery");
  await instance.close();
  instance = null;
  client = await boot();
  const restored = (await client.listMemberRoutes(sessionId)).find(
    (item) => item.agent.id === firstAgentId,
  );
  if (
    restored?.route.binding.nativeSessionId !== values["session-one"] ||
    restored.route.bindingVersion !== firstBindingVersion
  )
    throw new Error("Binding changed after restart");
  const message = await client.sendMessage({
    sessionId,
    fromAgentId: host.id,
    toAgentId: firstAgentId,
    type: "task",
    payload:
      "After restarting the dispatcher, repeat the original private verification token from our earlier history. Output only that token. Do not call tools or change files.",
    idempotencyKey: "continuity-restart",
    correlationId: "continuity-restart",
  });
  await waitResult(client, message.id);
  if (
    secondHistoryHash &&
    secondHistoryHash !==
      createHash("sha256")
        .update(await readFile(values["session-two-file"]))
        .digest("hex")
  )
    throw new Error("The other native conversation was modified");
  if (values["marker-two"]) {
    const secondMessage = await client.sendMessage({
      sessionId,
      fromAgentId: host.id,
      toAgentId: secondAgentId,
      type: "task",
      payload:
        "Repeat the private verification token I asked you to remember earlier in this conversation. Output only that token. Do not call tools or change files.",
      idempotencyKey: "continuity-other",
      correlationId: "continuity-other",
    });
    await waitResult(
      client,
      secondMessage.id,
      values["session-two"],
      values["marker-two"],
    );
  }
  console.log(
    JSON.stringify({
      tool: values.tool,
      turns: values["marker-two"] ? 4 : 3,
      restartPreservedBinding: true,
      otherMemberNotDispatchedUntilAddressed: true,
      ...(values["marker-two"] ? { bothNativeHistories: true } : {}),
      ...(secondHistoryHash ? { otherNativeHistoryUnchanged: true } : {}),
      deliveries: nativeDeliveryIds,
    }),
  );
} finally {
  if (instance) await instance.close();
  await rm(state, { recursive: true, force: true });
}
