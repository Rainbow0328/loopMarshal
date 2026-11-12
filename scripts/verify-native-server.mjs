import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";
import {
  resolveToolExecutable,
  proxyEnvironment,
  runProxyProcess,
} from "../apps/core/dist/apps/core/src/services/proxy-process.js";

// Real vendor executable/server and native storage; the provider is a deterministic local test service.
// This verifies native history transport, not reasoning quality or vendor account authentication.
const { values } = parseArgs({
  options: {
    tool: { type: "string" },
    executable: { type: "string" },
    keep: { type: "boolean" },
    bare: { type: "boolean" },
  },
});
if (
  !["mimo", "opencode", "qwen", "claude", "zcode"].includes(values.tool) ||
  !values.executable
)
  throw new Error(
    "Provide --tool mimo|opencode|qwen|claude|zcode and --executable <actual CLI path>",
  );
const cliTool = ["qwen", "claude", "zcode"].includes(values.tool);
const executableArgs = values.bare ? ["--bare"] : [];
const executable = resolveToolExecutable({
  toolId: values.tool,
  executablePath: resolve(values.executable),
  executableArgs,
});
const root = await mkdtemp(join(tmpdir(), `loopmarshal-real-${values.tool}-`));
const workspace = join(root, "项目 A 中文");
const namespace = join(root, "tool-data");
await mkdir(workspace);
await mkdir(namespace);
const markers = [
  `LM_NATIVE_A_${randomUUID().replaceAll("-", "")}`,
  `LM_NATIVE_B_${randomUUID().replaceAll("-", "")}`,
];
const requests = [];
const provider = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (request.url?.endsWith("/models")) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "mock", object: "model" }],
      }),
    );
    return;
  }
  try {
    const body = JSON.parse(raw);
    const serialized = JSON.stringify(body.messages ?? body.input ?? body);
    const marker = markers.find((candidate) => serialized.includes(candidate));
    requests.push({
      path: request.url,
      marker: marker ?? null,
      proxyTurn: serialized.includes("LoopMarshal task."),
    });
    const content = marker ?? "HISTORY_MISSING";
    const common = {
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
      model: "mock",
    };
    if (request.url?.includes("/messages/count_tokens")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    if (request.url?.includes("/messages")) {
      const message = {
        id: `msg_${randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: content }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      if (body.stream) {
        response.setHeader("content-type", "text/event-stream");
        for (const event of [
          {
            type: "message_start",
            message: { ...message, content: [], stop_reason: null },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: content },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 10 },
          },
          { type: "message_stop" },
        ]) {
          response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
        response.end();
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(message));
      }
      return;
    }
    if (body.stream) {
      response.setHeader("content-type", "text/event-stream");
      for (const choice of [
        { delta: { role: "assistant", content }, finish_reason: null },
        { delta: {}, finish_reason: "stop" },
      ]) {
        response.write(
          `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`,
        );
      }
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
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    }
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
await new Promise((done) => provider.listen(0, "127.0.0.1", done));
const providerPort = provider.address().port;
const config = {
  model: "loopmarshal/mock",
  small_model: "loopmarshal/mock",
  share: "disabled",
  permission: { "*": "deny" },
  provider: {
    loopmarshal: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local verification provider",
      options: {
        baseURL: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: "local-test-only",
      },
      models: {
        mock: { name: "Mock", limit: { context: 128000, output: 4096 } },
      },
    },
  },
};
const nativeEnv = {
  ...proxyEnvironment(),
  HOME: namespace,
  USERPROFILE: namespace,
  XDG_CONFIG_HOME: join(namespace, "config"),
  XDG_DATA_HOME: join(namespace, "data"),
  XDG_CACHE_HOME: join(namespace, "cache"),
  XDG_STATE_HOME: join(namespace, "state"),
};
const prefix = values.tool === "mimo" ? "MIMOCODE" : "OPENCODE";
nativeEnv[`${prefix}_CONFIG_CONTENT`] = JSON.stringify(config);
nativeEnv[`${prefix}_DISABLE_MODELS_FETCH`] = "1";
nativeEnv[`${prefix}_DISABLE_AUTOUPDATE`] = "1";
nativeEnv[`${prefix}_DISABLE_CLAUDE_CODE_MCP`] = "1";
nativeEnv[`${prefix}_DISABLE_DEFAULT_PLUGINS`] = "1";
const child = cliTool
  ? null
  : spawn(
      executable.command,
      [
        ...executable.args,
        "serve",
        "--port",
        "0",
        "--hostname",
        "127.0.0.1",
        ...(values.tool === "mimo" ? ["--pure"] : []),
      ],
      {
        cwd: workspace,
        env: nativeEnv,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
let output = "";
let childExit = null;
let instance;
child?.on("error", (error) => {
  output += String(error);
  childExit = -1;
});
child?.on("close", (code) => {
  childExit = code ?? -1;
});
child?.stdout.on("data", (chunk) => {
  output = (output + chunk).slice(-12000);
});
child?.stderr.on("data", (chunk) => {
  output = (output + chunk).slice(-12000);
});
async function until(operation, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("Timed out waiting for native server verification");
}
try {
  const endpoint = cliTool
    ? null
    : await until(() => {
        if (childExit !== null)
          throw new Error(`Vendor server exited ${childExit}: ${output}`);
        return output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
      });
  const seededQwen = new Set();
  if (values.tool === "qwen") {
    nativeEnv.QWEN_HOME = namespace;
    nativeEnv.QWEN_RUNTIME_DIR = namespace;
    for (const [key, value] of Object.entries({
      OPENAI_API_KEY: "local-test-only",
      OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      OPENAI_MODEL: "mock",
    })) {
      nativeEnv[key] = value;
      process.env[key] = value;
    }
    await writeFile(
      join(namespace, "settings.json"),
      JSON.stringify({
        security: {
          auth: {
            selectedType: "openai",
            apiKey: "local-test-only",
            baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          },
        },
        model: { name: "mock" },
      }),
    );
  }
  if (values.tool === "claude") {
    nativeEnv.CLAUDE_CONFIG_DIR = namespace;
    for (const [key, value] of Object.entries({
      ANTHROPIC_API_KEY: "local-test-only",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}`,
    })) {
      nativeEnv[key] = value;
      process.env[key] = value;
    }
  }
  if (values.tool === "zcode") {
    const data = join(namespace, ".zcode");
    await mkdir(join(data, "v2"), { recursive: true });
    await mkdir(join(data, "cli", "db"), { recursive: true });
    nativeEnv.ZCODE_DATA_BASE_DIR = namespace;
    nativeEnv.ZCODE_STORAGE_DIR = join(data, "cli");
    nativeEnv.ZCODE_SESSION_DB_PATH = join(data, "cli", "db", "db.sqlite");
    await writeFile(
      join(data, "v2", "provider_config.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "local",
                providerName: "Local verification",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "local-test-only" },
                  api: {
                    type: "openai-chat-completions",
                    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
                  },
                  personalModelIds: ["mock"],
                },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [],
            manualProviderModelRules: [],
          },
          defaultModelSelection: { providerId: "local", modelId: "mock" },
        },
      }),
    );
  }
  async function native(path, method = "GET", body) {
    if (cliTool) {
      if (path === "/session" && method === "POST") return { id: randomUUID() };
      const id = path.split("/")[2];
      if (method === "POST") {
        const prompt = body.parts[0].text;
        let captured = "";
        const args =
          values.tool === "claude"
            ? [
                ...executable.args,
                "--print",
                seededQwen.has(id) ? "--resume" : "--session-id",
                id,
                "--output-format",
                "stream-json",
                "--verbose",
              ]
            : values.tool === "zcode"
              ? [
                  ...executable.args,
                  ...(seededQwen.has(id) ? ["--resume", id] : []),
                  "--prompt",
                  prompt,
                  "--cwd",
                  workspace,
                  "--mode",
                  "plan",
                  "--output-format",
                  "stream-json",
                ]
              : [
                  ...executable.args,
                  seededQwen.has(id) ? "--resume" : "--session-id",
                  id,
                  "--prompt",
                  prompt,
                  "--output-format",
                  "stream-json",
                  "--approval-mode",
                  "plan",
                ];
        const result = await runProxyProcess(
          {
            command: executable.command,
            args,
            cwd: workspace,
            env: nativeEnv,
            ...(values.tool === "claude" ? { input: prompt } : {}),
          },
          {
            signal: AbortSignal.timeout(120000),
            timeoutMs: 120000,
            onLine: (line) => {
              captured += line + "\n";
            },
          },
        );
        if (result.exitCode !== 0)
          throw new Error(
            `Native CLI seed failed: ${captured} ${result.stderr}`,
          );
        await writeFile(join(root, `native-seed-${id}.jsonl`), captured);
        if (values.tool === "zcode") {
          const terminal = captured
            .split(/\r?\n/)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .find((event) => event?.type === "result");
          if (!terminal?.sessionId)
            throw new Error(`ZCode returned no native ID: ${captured}`);
          return { ...terminal, id: terminal.sessionId };
        }
        seededQwen.add(id);
        return captured;
      }
      if (values.tool === "zcode") {
        const db = new DatabaseSync(nativeEnv.ZCODE_SESSION_DB_PATH, {
          readOnly: true,
        });
        try {
          return db
            .prepare("SELECT * FROM message WHERE session_id = ? ORDER BY id")
            .all(id);
        } finally {
          db.close();
        }
      }
      const files = (await readdir(namespace, { recursive: true })).filter(
        (file) => file.includes(id) && /\.jsonl?$/.test(file),
      );
      return Promise.all(
        files.map((file) => readFile(join(namespace, file), "utf8")),
      );
    }
    const url = new URL(endpoint + path);
    url.searchParams.set("directory", workspace);
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(90000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `Native ${path}: ${response.status} ${await response.text()}`,
      );
    return response.json();
  }
  const sessions = [];
  for (const marker of markers) {
    let session = await native("/session", "POST", {});
    const seeded = await native(`/session/${session.id}/message`, "POST", {
      model: { providerID: "loopmarshal", modelID: "mock" },
      parts: [
        {
          type: "text",
          text: `Remember my private history marker ${marker}. Reply with it. Do not use tools.`,
        },
      ],
    });
    if (!JSON.stringify(seeded).includes(marker))
      throw new Error(`Native session seed failed: ${JSON.stringify(seeded)}`);
    if (!cliTool)
      await writeFile(
        join(root, `native-seed-${session.id}.json`),
        JSON.stringify(seeded, null, 2),
      );
    if (values.tool === "zcode") session = { id: seeded.id };
    sessions.push(session);
  }
  console.log(
    JSON.stringify({
      stage: "native_seeded",
      tool: values.tool,
      nativeSessionIds: sessions.map((session) => session.id),
    }),
  );
  const coreConfig = {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "core.sqlite"),
  };
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  async function boot() {
    instance = await startCoreServer(coreConfig);
    const baseUrl = `http://127.0.0.1:${instance.server.server.address().port}`;
    const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
    return createLoopMarshalClient({
      baseUrl,
      headers: { "x-loopmarshal-management-token": token },
    });
  }
  let client = await boot();
  const { session, agent: host } = await client.createSession({
    sessionName: "native-test",
    agentName: "主控",
    displayName: "主控",
    platform: "generic",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  const installation = await client.createToolInstallation({
    toolId: values.tool,
    executablePath: resolve(values.executable),
    executableArgs,
    displayName: values.tool,
    ...(values.tool === "qwen"
      ? {
          environmentKeys: [
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_MODEL",
          ],
        }
      : values.tool === "claude"
        ? { environmentKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] }
        : {}),
  });
  const members = [];
  for (const [index, saved] of sessions.entries()) {
    const member = await client.createProxyMember(session.id, {
      agentName: index === 0 ? "前端开发" : "后端开发",
      roleDescription: "Verify history, no tools or file changes",
      binding: {
        installationId: installation.id,
        workspacePath: workspace,
        runtimeNamespace: namespace,
        nativeSessionId: saved.id,
        endpoint,
      },
    });
    await client.verifyMemberRoute(
      session.id,
      member.agent.id,
      member.route.bindingVersion,
    );
    members.push(member);
  }
  const secondBefore = JSON.stringify(
    await native(`/session/${sessions[1].id}/message`),
  );
  let invalidIdRejected = false;
  const invalidMember = await client.createProxyMember(session.id, {
    agentName: "invalid-session",
    roleDescription: "Reject a missing session without creating one",
    binding: {
      installationId: installation.id,
      workspacePath: workspace,
      runtimeNamespace: namespace,
      nativeSessionId: `missing-${randomUUID()}`,
      endpoint,
    },
  });
  try {
    await client.verifyMemberRoute(
      session.id,
      invalidMember.agent.id,
      invalidMember.route.bindingVersion,
    );
  } catch {
    invalidIdRejected = true;
  }
  if (!invalidIdRejected)
    throw new Error("A nonexistent native session passed verification");
  await client.updateMemberRoute(session.id, invalidMember.agent.id, {
    accessMode: "cli_await",
    expectedBindingVersion: invalidMember.route.bindingVersion,
    disabled: true,
    reason: "Missing ID correctly rejected",
  });
  for (let round = 0; round < 4; round++) {
    if (round === 2) {
      await instance.close();
      instance = null;
      client = await boot();
    }
    const target = round === 3 ? 1 : 0;
    const sent = await client.sendMessage({
      sessionId: session.id,
      fromAgentId: host.id,
      toAgentId: members[target].agent.id,
      type: "task",
      payload:
        "Repeat my private history marker. Do not use tools or change files.",
      idempotencyKey: `round-${round}`,
    });
    const delivery = await until(async () => {
      const value = (await client.listDeliveries(session.id)).find(
        (item) => item.messageId === sent.id,
      );
      if (value && ["blocked", "unknown", "failed"].includes(value.state))
        throw new Error(`Core delivery ${value.state}: ${value.error}`);
      return value?.state === "completed" ? value : null;
    });
    const report = await client.getMessageById(delivery.resultMessageId);
    if (
      report.toAgentId !== host.id ||
      !JSON.stringify(report.payload).includes(markers[target])
    )
      throw new Error("Wrong member, history or report destination");
    if (
      round === 2 &&
      JSON.stringify(await native(`/session/${sessions[1].id}/message`)) !==
        secondBefore
    )
      throw new Error("Unaddressed native history was modified");
  }
  const proxyRequests = requests.filter((request) => request.proxyTurn);
  if (
    proxyRequests.length < 4 ||
    proxyRequests.some((request) => !request.marker)
  )
    throw new Error("Provider did not receive restored history");
  const registered = await client.listToolInstallations();
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(
      {
        tool: values.tool,
        version: (await client.listMemberRoutes(session.id)).find(
          (member) => member.agent.id === members[0].agent.id,
        )?.route.verifiedToolVersion,
        sessions: sessions.map((session) => session.id),
        requests,
        installation: registered[0],
        checks: {
          history: true,
          exactSession: true,
          untouchedOtherSession: true,
          coreRestart: true,
          invalidIdRejected,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      tool: values.tool,
      realVendorExecutable: true,
      provider: "local-test-service",
      turns: 4,
      coreRestart: true,
      bothNativeHistories: true,
      invalidIdRejected,
      evidenceDirectory: values.keep ? root : null,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      tool: values.tool,
      error: error.message,
      nativeOutput: output,
      evidenceDirectory: root,
    }),
  );
  values.keep = true;
  process.exitCode = 1;
} finally {
  if (instance) await instance.close();
  if (childExit === null && child?.pid) {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    await new Promise((done) => {
      killer.on("close", done);
      killer.on("error", done);
    });
    await until(() => childExit !== null, 10000).catch(() => {});
  }
  await new Promise((done) => provider.close(done));
  if (!values.keep) await rm(root, { recursive: true, force: true });
}
