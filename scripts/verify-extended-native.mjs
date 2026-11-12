import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { NativeCliSessionAdapter } from "../apps/core/dist/apps/core/src/services/native-session-adapters.js";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

// Real official programs and native history, with a deterministic local provider.
// This checks transport and session continuation, not real model/account acceptance.
const { values } = parseArgs({
  options: {
    tool: { type: "string" },
    executable: { type: "string" },
    output: { type: "string" },
  },
});
assert.ok(["gemini", "kimi", "droid", "copilot"].includes(values.tool));
assert.ok(values.executable);
const tool = values.tool;
const root = await mkdtemp(join(tmpdir(), `loopmarshal-extended-${tool}-`));
const project = join(root, "项目 A");
await mkdir(project);
const namespace =
  tool === "gemini"
    ? join(root, ".gemini")
    : tool === "droid"
      ? join(root, ".factory")
      : join(root, "data");
await mkdir(namespace);
const markers = ["HISTORY_A_" + randomUUID(), "HISTORY_B_" + randomUUID()];
const requests = [];
const provider = createServer(async (request, response) => {
  let raw = "";
  for await (const part of request) raw += part;
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {}
  const content = JSON.stringify(
    body.messages ?? body.contents ?? body.input ?? body,
  );
  const marker =
    markers.find((item) => content.includes(item)) ?? "HISTORY_MISSING";
  requests.push({ path: request.url, marker });
  if (request.url.includes("countTokens")) {
    response.setHeader("content-type", "application/json");
    response.end('{"totalTokens":100}');
    return;
  }
  if (
    request.url.includes("generateContent") ||
    request.url.includes("streamGenerateContent")
  ) {
    const message = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: marker }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
      modelVersion: "gemini-2.5-flash",
    };
    response.setHeader(
      "content-type",
      request.url.includes("streamGenerateContent")
        ? "text/event-stream"
        : "application/json",
    );
    response.end(
      request.url.includes("streamGenerateContent")
        ? `data: ${JSON.stringify(message)}\n\n`
        : JSON.stringify(message),
    );
    return;
  }
  const common = {
    id: "chatcmpl-" + randomUUID(),
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? "mock",
  };
  if (body.stream) {
    response.setHeader("content-type", "text/event-stream");
    for (const choice of [
      { delta: { role: "assistant", content: marker }, finish_reason: null },
      { delta: {}, finish_reason: "stop" },
    ])
      response.write(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  } else {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ...common,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: marker },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  }
});
await new Promise((done) => provider.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${provider.address().port}`;
const environmentKeys = [];
const executableArgs = [];
if (tool === "gemini") {
  process.env.GEMINI_API_KEY = "local-test-only";
  process.env.GOOGLE_GEMINI_BASE_URL = url;
  environmentKeys.push("GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL");
  await writeFile(
    join(namespace, "settings.json"),
    JSON.stringify({
      model: { name: "gemini-2.5-flash" },
      security: { auth: { selectedType: "gemini-api-key" } },
      general: { disableAutoUpdate: true },
    }),
  );
}
if (tool === "kimi")
  await writeFile(
    join(namespace, "config.toml"),
    `default_model = "local"\n[providers.local]\ntype = "openai_legacy"\nbase_url = "${url}/v1"\napi_key = "local-test-only"\n[models.local]\nprovider = "local"\nprotocol = "openai"\nmodel = "mock"\nmax_context_size = 32000\n`,
  );
if (tool === "droid") {
  executableArgs.push("--no-auto-update");
  await writeFile(
    join(namespace, "settings.json"),
    JSON.stringify({
      customModels: [
        {
          model: "mock",
          displayName: "mock",
          baseUrl: url + "/v1",
          apiKey: "local-test-only",
          provider: "generic-chat-completion-api",
        },
      ],
    }),
  );
  executableArgs.splice(0); // Model is selected below in a per-tool invocation-compatible wrapper.
}
if (tool === "copilot") {
  Object.assign(process.env, {
    COPILOT_PROVIDER_BASE_URL: url + "/v1",
    COPILOT_PROVIDER_API_KEY: "local-test-only",
    COPILOT_MODEL: "gpt-4.1",
  });
  environmentKeys.push(
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_MODEL",
  );
}
// Droid requires its model selection after `exec`; configure the persisted default.
if (tool === "droid")
  await writeFile(
    join(namespace, "settings.json"),
    JSON.stringify({
      model: "custom:mock-0",
      customModels: [
        {
          model: "mock",
          displayName: "mock",
          baseUrl: url + "/v1",
          apiKey: "local-test-only",
          provider: "generic-chat-completion-api",
        },
      ],
    }),
  );
const timestamp = new Date().toISOString();
const base = {
  installation: {
    id: "official",
    toolId: tool,
    displayName: tool,
    executablePath: resolve(values.executable),
    executableArgs,
    environmentKeys,
    version: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  binding: {
    installationId: "official",
    workspacePath: project,
    runtimeNamespace: namespace,
    nativeSessionId: "loopmarshal-pending:test",
    endpoint: null,
  },
  nativeSessionKey: "test",
};
const events = [];
const context = () => ({
  signal: AbortSignal.timeout(90000),
  onStarted() {},
  onEvent(type, payload) {
    events.push({ type, payload });
  },
});
const evidence = {
  tool,
  root,
  validation: "official_program_with_local_provider",
  nativeIds: [],
  turns: [],
  requests,
};
let core;
try {
  const adapter = new NativeCliSessionAdapter(join(root, "evidence"));
  for (const marker of markers) {
    const created = await adapter.create(
      base,
      `Remember the exact private marker ${marker}. Return it; do not use tools.`,
      context(),
    );
    console.log("create", JSON.stringify(created));
    assert.equal(created.result.outcome, "reported");
    assert.ok(created.result.text.includes(marker));
    evidence.nativeIds.push(created.nativeSessionId);
    evidence.turns.push(created.result);
  }
  assert.notEqual(evidence.nativeIds[0], evidence.nativeIds[1]);
  for (let turn = 0; turn < 4; turn++) {
    const index = turn % 2;
    const snapshot = {
      ...base,
      binding: { ...base.binding, nativeSessionId: evidence.nativeIds[index] },
    };
    const fresh = new NativeCliSessionAdapter(join(root, "evidence"));
    await fresh.verify(snapshot, AbortSignal.timeout(15000));
    const result = await fresh.execute(
      snapshot,
      "Return the private marker from your previous conversation; no tools.",
      context(),
    );
    console.log("resume", JSON.stringify(result));
    assert.equal(result.outcome, "reported");
    assert.equal(result.nativeSessionId, evidence.nativeIds[index]);
    assert.ok(result.text.includes(markers[index]));
    assert.ok(!result.text.includes(markers[1 - index]));
    evidence.turns.push(result);
  }
  const before = requests.length;
  const missing = {
    ...base,
    binding: { ...base.binding, nativeSessionId: randomUUID() },
  };
  await assert.rejects(
    adapter.execute(missing, "must never create a replacement", context()),
    /准确会话|原生历史/,
  );
  assert.equal(requests.length, before);

  // Exercise the same product setup and durable delivery APIs used by the UI.
  // The deterministic provider does not plan tasks or maintain knowledge: this
  // verifies routing, consumption, reporting and persistence, not autonomous AI.
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
    root,
    "preferences.json",
  );
  let client;
  const start = async () => {
    core = await startCoreServer({
      host: "127.0.0.1",
      port: 0,
      databasePath: join(root, "core.sqlite"),
    });
    const baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
    const { token } = await (await fetch(baseUrl + "/api/local-auth")).json();
    client = createLoopMarshalClient({
      baseUrl,
      headers: { "x-loopmarshal-management-token": token },
    });
  };
  await start();
  const installation = await client.createToolInstallation({
    toolId: tool,
    displayName: "Official " + tool,
    executablePath: base.installation.executablePath,
    environmentKeys,
  });
  const sessionName = tool + " product routing";
  const attached = await client.attachSession({
    sessionName,
    projectPath: project,
    agentName: "Host",
    role: "host",
    roleDescription: "External test coordinator",
  });
  const sid = attached.session.id;
  const members = [];
  for (const name of ["开发 A", "开发 B"])
    members.push(
      await client.createProxyMember(sid, {
        agentName: name,
        roleDescription: "Return the assigned private marker without tools",
        binding: {
          installationId: installation.id,
          workspacePath: project,
          runtimeNamespace: namespace,
        },
      }),
    );
  const routed = [];
  const deliver = async (index, first) => {
    const [message] = await client.sendByName({
      sessionName,
      from: "Host",
      to: [members[index].agent.agentName],
      type: "task",
      content: first
        ? `Remember ${markers[index]}. Return that marker. Do not use tools.`
        : "Return only the exact private marker from our previous conversation. Do not use tools.",
      idempotencyKey: randomUUID(),
    });
    const deadline = Date.now() + 120000;
    let delivery;
    while (Date.now() < deadline) {
      delivery = (await client.listDeliveries(sid)).find(
        (item) => item.messageId === message.id,
      );
      if (
        delivery &&
        !["queued", "delivering", "awaiting_result"].includes(delivery.state)
      )
        break;
      await new Promise((done) => setTimeout(done, 150));
    }
    assert.equal(delivery?.state, "completed", JSON.stringify(delivery));
    const messages = await client.listMessages(sid);
    const report = messages.find(
      (item) => item.id === delivery.resultMessageId,
    );
    assert.equal(report.fromAgentId, members[index].agent.id);
    assert.equal(report.toAgentId, attached.agent.id);
    assert.ok(JSON.stringify(report.payload).includes(markers[index]));
    assert.ok(!JSON.stringify(report.payload).includes(markers[1 - index]));
    assert.equal(
      messages.find((item) => item.id === message.id).processingStatus,
      "processed",
    );
    routed.push({
      member: index,
      nativeSessionId: delivery.snapshot.binding.nativeSessionId,
      deliveryId: delivery.id,
      consumed: true,
      reported: true,
    });
    console.log("product", JSON.stringify(routed.at(-1)));
  };
  await deliver(0, true);
  await deliver(1, true);
  assert.notEqual(routed[0].nativeSessionId, routed[1].nativeSessionId);
  await core.close();
  core = undefined;
  await start();
  await deliver(1, false);
  await deliver(0, false);
  assert.equal(routed[2].nativeSessionId, routed[1].nativeSessionId);
  assert.equal(routed[3].nativeSessionId, routed[0].nativeSessionId);
  const hostSetup = await client.createSessionSetup({
    sessionName: tool + " managed host",
    projectPath: project,
    agents: [
      {
        role: "host",
        name: "主控",
        duty: "Respond to user instructions without tools",
        mode: "managed_proxy",
        nativeSessionMode: "create",
        binding: {
          installationId: installation.id,
          workspacePath: project,
          runtimeNamespace: namespace,
        },
      },
    ],
  });
  const hostTurns = [];
  for (const content of [
    "Remember " + markers[0] + ". Return it without tools.",
    "Return the private marker from your previous conversation without tools.",
  ]) {
    const message = await client.sendMessage({
      sessionId: hostSetup.session.id,
      fromAgentId: hostSetup.agent.id,
      toAgentId: hostSetup.agent.id,
      type: "instruction",
      payload: { kind: "web_user_message", content },
    });
    const deadline = Date.now() + 120000;
    let delivery;
    while (Date.now() < deadline) {
      delivery = (await client.listDeliveries(hostSetup.session.id)).find(
        (item) => item.messageId === message.id,
      );
      if (
        delivery &&
        !["queued", "delivering", "awaiting_result"].includes(delivery.state)
      )
        break;
      await new Promise((done) => setTimeout(done, 150));
    }
    assert.equal(delivery?.state, "completed", JSON.stringify(delivery));
    const report = (await client.listMessages(hostSetup.session.id)).find(
      (item) => item.id === delivery.resultMessageId,
    );
    assert.ok(JSON.stringify(report.payload).includes(markers[0]));
    hostTurns.push(delivery.snapshot.binding.nativeSessionId);
  }
  assert.equal(hostTurns[0], hostTurns[1]);
  evidence.product = {
    routed,
    restartContinuation: true,
    hostCreatedByProduct: true,
    hostNativeSessionId: hostTurns[0],
    hostChatContinuation: true,
    validation: "product_apis_with_official_program_and_deterministic_provider",
  };
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error.stack;
  process.exitCode = 1;
} finally {
  if (core) await core.close();
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify({ ...evidence, events }, null, 2),
  );
  if (values.output)
    await writeFile(resolve(values.output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
