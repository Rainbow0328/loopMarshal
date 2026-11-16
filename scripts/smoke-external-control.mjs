import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlHarness, until } from "./lib/control-test-harness.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "apps/cli/dist/apps/cli/src/index.js");
const root = await mkdtemp(join(tmpdir(), "loopmarshal-control-"));
const project = join(root, "project");
await mkdir(project);
await writeFile(
  join(project, "README.md"),
  "# External control fixture\nInspect this project.",
);
Object.assign(process.env, {
  LOOPMARSHAL_DATABASE_PATH: join(root, "core.sqlite"),
  LOOPMARSHAL_KNOWLEDGE_ROOT: join(root, "knowledge"),
  LOOPMARSHAL_USER_PREFERENCES_PATH: join(root, "preferences.json"),
  LOOPMARSHAL_HOME: join(root, "home"),
  LOOPMARSHAL_LOG_DIR: join(root, "logs"),
  LOOPMARSHAL_LOG_LEVEL: "error",
  LOOPMARSHAL_LOG_ROTATION: "false",
});
delete process.env.LOOPMARSHAL_MEMBER_TOKEN;
delete process.env.LOOPMARSHAL_MANAGEMENT_TOKEN;
delete process.env.LOOPMARSHAL_ROLE;

const { runCli, connectMcp } = createControlHarness(cli, project);

let core, mcp, workerMcp, hostMcp;
const model = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const input = JSON.parse(body);
  const draft = input.messages.some((m) => m.content?.includes("知识草稿"));
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: draft ? "CONTROL_KNOWLEDGE_DRAFT" : "CONTROL_HOST_REPLY",
          },
        },
      ],
    }),
  );
});

try {
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  const { startCoreServer } = await import("@loopmarshal/core");
  const { createLoopMarshalClient } = await import("@loopmarshal/sdk");
  const { listControlActions, callControlAction } = await import(
    "../apps/cli/dist/apps/cli/src/control/registry.js"
  );
  core = await startCoreServer({
    host: "127.0.0.1",
    port: 0,
    databasePath: process.env.LOOPMARSHAL_DATABASE_PATH,
  });
  const base = `http://127.0.0.1:${core.server.server.address().port}`;
  process.env.LOOPMARSHAL_BASE_URL = base;
  const token = await readFile(
    `${process.env.LOOPMARSHAL_DATABASE_PATH}.management-token`,
    "utf8",
  );
  const sdk = createLoopMarshalClient({
    baseUrl: base,
    headers: { "x-loopmarshal-management-token": token.trim() },
  });
  const call = (name, input) => callControlAction(sdk, name, input);

  const directory = await runCli(["api", "actions"]);
  assert.equal(directory.code, 0);
  assert.equal(directory.output.data.length, listControlActions().length);
  assert(directory.output.data.length > 50);
  const schema = await runCli(["api", "describe", "session.create"]);
  assert(schema.output.data.inputSchema.required.includes("projectPath"));
  const unknown = await runCli(["api", "call", "unknown.action"]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.output.error.code, "ACTION_NOT_FOUND");
  assert.equal(
    (await runCli(["api", "call", "session.create", "--input", "{"])).code,
    1,
  );
  assert.equal(
    (await runCli(["api", "call", "model.list", "--input", '{"typo":true}']))
      .code,
    1,
  );

  const privateKey = "private-control-key-never-in-output";
  const saved = await runCli(
    ["api", "call", "model.save", "--input-file", "-"],
    {
      id: "control-model",
      name: "Local fixture",
      provider: "openai",
      modelId: "fixture",
      apiKey: privateKey,
      baseUrl: `http://127.0.0.1:${model.address().port}`,
      maxOutputTokens: 256,
    },
  );
  assert.equal(saved.code, 0);
  assert.equal(saved.output.data.hasApiKey, true);
  assert(!saved.raw.includes(privateKey));
  await call("model.save", {
    id: "control-model",
    name: "Renamed",
    provider: "openai",
    modelId: "fixture",
  });
  assert.equal(
    core.databaseManager.connection
      .prepare("SELECT api_key FROM model_configs WHERE id = ?")
      .get("control-model").api_key,
    privateKey,
  );
  assert.equal(
    (await runCli(["model", "list"])).raw.includes(privateKey),
    false,
  );

  const setup = {
    sessionName: "External control",
    projectPath: project,
    agents: [
      {
        name: "Host",
        duty: "Coordinate project work",
        role: "host",
        mode: "core_runtime",
        modelConfigId: "control-model",
      },
      {
        name: "Reviewer",
        duty: "Review work",
        role: "worker",
        mode: "mcp_await",
      },
    ],
  };
  const inputFile = join(root, "session.json");
  await writeFile(inputFile, "\uFEFF" + JSON.stringify(setup));
  const created = await runCli([
    "session",
    "create",
    "--input-file",
    inputFile,
  ]);
  assert.equal(created.code, 0, JSON.stringify(created.output));
  const session = created.output.data.session;
  assert.equal(
    (await sdk.getSessionConsole(session.id)).session.id,
    session.id,
  );
  const discovered = await runCli(["session", "list", "--project", project]);
  assert(discovered.output.data.sessions.some((s) => s.id === session.id));
  assert(
    Array.isArray((await runCli(["session", "list"])).output.data.sessions),
  );
  const invalid = await runCli(
    ["api", "call", "session.create", "--input-file", "-"],
    { ...setup, sessionName: "Invalid", agents: [] },
  );
  assert.equal(invalid.code, 1);
  assert(!(await sdk.listSessions()).some((s) => s.sessionName === "Invalid"));
  assert.equal(
    (
      await runCli([
        "session",
        "message",
        setup.sessionName,
        "--content",
        "Inspect this project",
        "--idempotency-key",
        "user-message-1",
      ])
    ).code,
    0,
  );
  await until(
    () => sdk.listMessages(session.id),
    (messages) =>
      messages.some((m) =>
        JSON.stringify(m.payload).includes("CONTROL_HOST_REPLY"),
      ),
  );
  const one = await call("session.message", {
    session: setup.sessionName,
    content: "Inspect this project",
    idempotencyKey: "user-message-1",
  });
  const two = await call("session.message", {
    session: setup.sessionName,
    content: "Inspect this project",
    idempotencyKey: "user-message-1",
  });
  assert.equal(one.id, two.id);
  await assert.rejects(
    () =>
      call("session.message", {
        session: setup.sessionName,
        content: "Different request",
        idempotencyKey: "user-message-1",
      }),
    { code: "CONFLICT" },
  );
  assert.equal(
    (await sdk.listMessages(session.id)).filter(
      (m) => m.idempotencyKey === "user-message-1",
    ).length,
    1,
  );
  for (const bad of [
    {
      ...setup,
      sessionName: "Missing project",
      projectPath: join(root, "missing"),
    },
    {
      ...setup,
      sessionName: "Missing model",
      agents: [{ ...setup.agents[0], modelConfigId: "removed-model" }],
    },
  ]) {
    await assert.rejects(() => call("session.create", bad));
    assert(
      !(await sdk.listSessions()).some(
        (s) => s.sessionName === bad.sessionName,
      ),
    );
  }
  const runtime = (
    await call("runtime.list", { session: setup.sessionName })
  )[0];
  assert(runtime);
  await call("runtime.pause", { id: runtime.id });
  assert.equal((await sdk.getWebAgentRuntime(runtime.id)).status, "paused");
  await call("runtime.configure", {
    id: runtime.id,
    customDuty: "Coordinate and verify the project",
  });
  await call("runtime.start", { id: runtime.id });

  mcp = connectMcp();
  const initialized = await mcp.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  assert.equal(initialized.serverInfo.name, "loopmarshal");
  assert(
    (await mcp.request("tools/list")).tools.some(
      (t) => t.name === "session_create",
    ),
  );
  const capabilities = await mcp.call("app_capabilities", {
    group: "discussion",
  });
  assert(capabilities.actions.every((a) => a.group === "discussion"));
  assert.equal(
    (await mcp.call("session_get", { session: setup.sessionName })).data.session
      .id,
    session.id,
  );
  assert(!JSON.stringify(await mcp.call("model_list")).includes(privateKey));
  const page = await mcp.call("app_call", {
    action: "message.query",
    input: { session: setup.sessionName, limit: 1 },
  });
  assert.equal(page.data.messages.length, 1);
  assert.equal(
    (await mcp.call("app_describe", { action: "session.create" })).inputSchema
      .type,
    "object",
  );
  await assert.rejects(() =>
    mcp.call("app_call", {
      action: "session.create",
      input: { sessionName: "Missing Host", projectPath: project, agents: [] },
    }),
  );

  // The exact native binding must survive two user messages through different transports.
  const native = join(root, "codex-fixture.cjs");
  const namespace = join(root, "codex-data");
  await mkdir(namespace);
  await writeFile(
    native,
    `
    const fs = require('node:fs'), path = require('node:path');
    if (process.argv.includes('--version')) { console.log('codex-cli 0.132.0'); process.exit(0); }
    let prompt = ''; process.stdin.on('data', b => prompt += b); process.stdin.on('end', () => {
      const root = process.env.CODEX_HOME, id = 'control-native-123';
      fs.mkdirSync(path.join(root,'sessions'), {recursive:true});
      fs.appendFileSync(path.join(root,'calls.jsonl'), JSON.stringify({args:process.argv.slice(2),prompt})+'\\n');
      fs.writeFileSync(path.join(root,'sessions',id+'.jsonl'), JSON.stringify({type:'session_meta',payload:{id,cwd:process.cwd()}})+'\\n');
      console.log(JSON.stringify({type:'thread.started',thread_id:id}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NATIVE_CONTROL_REPLY'}}));
      console.log(JSON.stringify({type:'turn.completed'}));
    });
  `,
  );
  const installation = await call("tool.register", {
    toolId: "codex",
    displayName: "Test fixture",
    executablePath: native,
  });
  const proxySetup = {
    sessionName: "Proxy control",
    projectPath: project,
    agents: [
      {
        name: "Codex Host",
        role: "host",
        duty: "Coordinate",
        mode: "managed_proxy",
        binding: {
          installationId: installation.id,
          workspacePath: project,
          runtimeNamespace: namespace,
        },
      },
    ],
  };
  const proxy = (await mcp.call("session_create", proxySetup)).data;
  assert.equal(proxy.members.length, 1);
  await mcp.call("session_message", {
    session: proxySetup.sessionName,
    content: "First native turn",
    idempotencyKey: "native-first",
  });
  await until(
    () => sdk.listDeliveries(proxy.session.id),
    (d) => d.some((x) => x.state === "completed"),
  );
  assert.equal(
    (await call("member.list", { session: proxySetup.sessionName }))[0].route
      .binding.nativeSessionId,
    "control-native-123",
  );
  await call("session.message", {
    session: proxySetup.sessionName,
    content: "Second native turn",
    idempotencyKey: "native-second",
  });
  await until(
    () => sdk.listDeliveries(proxy.session.id),
    (d) => d.filter((x) => x.state === "completed").length === 2,
  );
  const nativeCalls = (await readFile(join(namespace, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(nativeCalls.length, 2);
  assert(!nativeCalls[0].args.includes("resume"));
  assert(nativeCalls[1].args.includes("resume"));
  assert(nativeCalls[1].args.includes("control-native-123"));
  const completed = (await sdk.listDeliveries(proxy.session.id)).find(
    (d) => d.state === "completed",
  );
  const events = await call("delivery.events", { id: completed.id });
  assert(events.length > 0);
  assert.equal(
    (
      await call("delivery.events", {
        id: completed.id,
        after: events.at(-1).sequence,
      })
    ).length,
    0,
  );
  const proxyMember = (
    await call("member.list", { session: proxySetup.sessionName })
  )[0];
  await assert.rejects(() =>
    call("member.update_route", {
      session: proxySetup.sessionName,
      agentId: proxyMember.agent.id,
      route: {
        accessMode: "managed_proxy",
        binding: proxyMember.route.binding,
        expectedBindingVersion: proxyMember.route.bindingVersion + 1,
        reason: "Stale binding",
      },
    }),
  );
  assert.equal(
    (await call("member.list", { session: proxySetup.sessionName }))[0].route
      .binding.nativeSessionId,
    "control-native-123",
  );

  const profile = (
    await call("tool.config.create", {
      installationId: installation.id,
      name: "Fixture profile",
      configRoot: namespace,
    })
  ).profile;
  const document = (
    await call("tool.config.read", { profileId: profile.id })
  ).documents.find((d) => d.id === "user");
  const configPath = join(namespace, "config.toml");
  await writeFile(configPath, 'model = "original-model"\n');
  const original = (
    await call("tool.config.read", { profileId: profile.id })
  ).documents.find((d) => d.id === "user");
  const preview = await call("tool.config.preview", {
    profileId: profile.id,
    changes: {
      documentId: document.id,
      expectedFingerprint: original.fingerprint,
      values: { model: "fixture-model" },
    },
  });
  const applied = await call("tool.config.apply", {
    profileId: profile.id,
    previewId: preview.previewId,
  });
  assert(
    (await readFile(join(namespace, "config.toml"), "utf8")).includes(
      "fixture-model",
    ),
  );
  await assert.rejects(() =>
    call("tool.config.preview", {
      profileId: profile.id,
      changes: {
        documentId: document.id,
        expectedFingerprint: document.fingerprint,
        values: { model: "stale" },
      },
    }),
  );
  await call("tool.config.restore", {
    profileId: profile.id,
    backupId: applied.backup.id,
  });
  assert.equal(
    await readFile(configPath, "utf8"),
    'model = "original-model"\n',
  );

  await call("knowledge.upsert", {
    session: setup.sessionName,
    level: "l2",
    slug: "contract",
    title: "Project contract",
    content: "A durable rule",
  });
  assert.equal(
    (
      await call("knowledge.read", {
        session: setup.sessionName,
        level: "l2",
        slug: "contract",
      })
    ).content,
    "A durable rule",
  );
  assert.equal(
    (await call("knowledge.list", { session: proxySetup.sessionName })).length,
    0,
  );
  const room = await call("discussion.create", {
    name: "Design review",
    modelIds: ["control-model"],
  });
  const replies = await call("discussion.send", {
    roomId: room.id,
    content: "Discuss a design",
    memberIds: ["control-model"],
  });
  assert(replies.some((r) => r.content === "CONTROL_HOST_REPLY"));
  const sourceIds = replies.map((r) => r.id);
  const draft = await call("discussion.knowledge.draft", {
    roomId: room.id,
    modelId: "control-model",
    sourceIds,
  });
  assert.equal(draft.content, "CONTROL_KNOWLEDGE_DRAFT");
  const knowledge = await call("discussion.knowledge.save", {
    roomId: room.id,
    title: "Reviewed",
    content: draft.content,
    sourceIds,
  });
  assert.equal(
    (
      await call("discussion.knowledge.sources", {
        roomId: room.id,
        entryId: knowledge.id,
      })
    ).length,
    sourceIds.length,
  );
  await call("discussion.access.set", {
    roomId: room.id,
    session: setup.sessionName,
    enabled: true,
  });
  assert(
    (
      await call("discussion.access.list", { session: setup.sessionName })
    ).includes(room.id),
  );
  assert.equal(
    (await call("discussion.messages", { roomId: room.id, limit: 1 })).length,
    1,
  );
  await call("discussion.access.set", {
    roomId: room.id,
    session: setup.sessionName,
    enabled: false,
  });
  assert(
    !(
      await call("discussion.access.list", { session: setup.sessionName })
    ).includes(room.id),
  );

  await call("preference.save", {
    key: "test-language",
    value: "TypeScript",
    category: "control-test",
  });
  assert.equal(
    (await call("preference.list", { category: "control-test" })).preferences[0]
      .value,
    "TypeScript",
  );
  await call("preference.delete", { key: "test-language" });
  assert.equal(
    (await call("preference.list", { category: "control-test" })).preferences
      .length,
    0,
  );
  const extension = await call("mcp.create", {
    name: "Fixture MCP",
    url: `http://127.0.0.1:${model.address().port}/mcp`,
    headers: { Authorization: `Bearer ${privateKey}` },
    enabled: false,
  });
  assert(!JSON.stringify(extension).includes(privateKey));
  assert(!JSON.stringify(await call("mcp.list")).includes(privateKey));
  assert.equal(
    (await call("mcp.update", { serverId: extension.id, name: "Renamed MCP" }))
      .name,
    "Renamed MCP",
  );
  await call("mcp.delete", { serverId: extension.id });

  workerMcp = connectMcp({ LOOPMARSHAL_ROLE: "worker" });
  const restricted = (await workerMcp.request("tools/list")).tools;
  assert(
    !restricted.some((t) =>
      ["app_call", "session_create", "dispatch_many"].includes(t.name),
    ),
  );
  assert(restricted.some((t) => t.name === "submit"));
  await workerMcp.call("attach", {
    name: "Reviewer",
    session: setup.sessionName,
    role: "worker",
    duty: "Review work",
  });
  await mcp.call("app_call", {
    action: "message.send",
    input: {
      sessionName: setup.sessionName,
      from: "Host",
      to: ["Reviewer"],
      type: "task",
      content: { content: "Review the project" },
      idempotencyKey: "review-task-1",
    },
  });
  const claimed = await workerMcp.call("await", {
    name: "Reviewer",
    session: setup.sessionName,
  });
  assert(JSON.stringify(claimed).includes("Review the project"));
  await workerMcp.call("submit", {
    name: "Reviewer",
    session: setup.sessionName,
    content: "CONTROL_REVIEW_DONE",
  });
  const reported = await mcp.call("app_call", {
    action: "message.query",
    input: { session: setup.sessionName, memberName: "Reviewer" },
  });
  assert(JSON.stringify(reported).includes("CONTROL_REVIEW_DONE"));
  await assert.rejects(() =>
    workerMcp.call("app_call", {
      action: "session.delete",
      input: { session: setup.sessionName },
    }),
  );
  await assert.rejects(() =>
    workerMcp.call("attach", {
      name: "Elevate",
      session: "Should not exist",
      role: "host",
      duty: "Unauthorized",
    }),
  );
  const denied = await runCli(["api", "call", "model.list"], undefined, {
    LOOPMARSHAL_MEMBER_TOKEN: "invalid-member-token",
  });
  assert.equal(denied.code, 1);
  assert.equal(denied.output.error.code, "PERMISSION_DENIED");
  const reviewer = created.output.data.members.find(
    (m) => m.agentName === "Reviewer",
  );
  const issued = await sdk.issueMemberCredential(
    session.id,
    reviewer.id,
    "external-control-test",
  );
  const limited = createLoopMarshalClient({
    baseUrl: base,
    headers: { authorization: `Bearer ${issued.token}` },
  });
  await assert.rejects(() => limited.listModels(), { statusCode: 403 });
  await assert.rejects(
    () =>
      limited.createSessionSetup({
        ...setup,
        sessionName: "Member must not create",
      }),
    { statusCode: 403 },
  );
  await assert.rejects(
    () =>
      limited.sendByName({
        sessionName: setup.sessionName,
        from: "Host",
        to: ["Reviewer"],
        type: "task",
        content: "Impersonate Host",
        idempotencyKey: "impersonation",
      }),
    { statusCode: 403 },
  );
  hostMcp = connectMcp({ LOOPMARSHAL_ROLE: "host" });
  assert(
    (await hostMcp.request("tools/list")).tools.some(
      (t) => t.name === "app_call",
    ),
  );
  assert.equal(
    (await hostMcp.call("session_get", { session: setup.sessionName })).data
      .session.id,
    session.id,
  );
  const blockedInput = await runCli(
    ["api", "call", "model.save", "--input-file", "-"],
    {
      name: "Invalid",
      provider: "openai",
      modelId: "fixture",
      apiKey: privateKey,
      injectedField: "no",
    },
  );
  assert.equal(blockedInput.code, 1);
  assert(!blockedInput.raw.includes(privateKey));
  assert.equal((await sdk.getSession(session.id)).id, session.id);
  const disposable = {
    id: "disposable-model",
    name: "Temporary",
    provider: "openai",
    modelId: "fixture",
    apiKey: privateKey,
  };
  await call("model.save", disposable);
  assert.equal(
    (await call("model.save", { ...disposable, apiKey: null })).hasApiKey,
    false,
  );
  await call("model.delete", { id: disposable.id });
  assert(!(await call("model.list")).some((m) => m.id === disposable.id));
  await call("runtime.stop", { id: runtime.id });
  console.log(
    `PASS: ${listControlActions().length} actions; CLI/MCP discovery, creation, user/Host messaging, worker dispatch/consume/report, exact native-session resume, model secret preservation, config preview/apply/conflict, knowledge isolation, discussion summary/access, MCP/preferences management, and member restrictions.`,
  );
} finally {
  await hostMcp?.close();
  await workerMcp?.close();
  await mcp?.close();
  await core?.close();
  await new Promise((done) => model.close(() => done()));
  await rm(root, { recursive: true, force: true });
}
