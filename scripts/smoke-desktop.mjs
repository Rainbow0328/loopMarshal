import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const { values } = parseArgs({
  options: {
    playwright: { type: "string" },
    executable: { type: "string" },
    "codex-executable": { type: "string" },
    "codex-workspace": { type: "string" },
    "codex-namespace": { type: "string" },
    "codex-session": { type: "string" },
    "codex-marker": { type: "string" },
    "other-session-file": { type: "string" },
  },
});
if (!values.playwright)
  throw new Error("Provide --playwright <playwright-core/index.mjs>");
const executable = resolve(
  values.executable || "release/desktop/win-unpacked/LoopMarshal.exe",
);
const resources = join(dirname(executable), "resources", "loopmarshal");
const expectedVersion = JSON.parse(
  await readFile(
    new URL("../apps/desktop/package.json", import.meta.url),
    "utf8",
  ),
).version;
const { _electron } = await import(
  pathToFileURL(resolve(values.playwright)).href
);
const sdkRoot = join(resources, "app/node_modules/@loopmarshal/sdk");
const sdkPackage = JSON.parse(
  await readFile(join(sdkRoot, "package.json"), "utf8"),
);
const { createLoopMarshalClient } = await import(
  pathToFileURL(join(sdkRoot, sdkPackage.main)).href
);
const directory = await mkdtemp(join(tmpdir(), "loopmarshal-desktop-smoke-"));
const otherHistoryHash = values["other-session-file"]
  ? createHash("sha256")
      .update(await readFile(values["other-session-file"]))
      .digest("hex")
  : null;
const data = join(directory, "data");
const namespace = join(directory, "native");
await mkdir(join(namespace, "sessions"), { recursive: true });
const fixture = join(directory, "fixture.cjs");
const releasePath = join(directory, "release-observed-task");
const executionLog = join(directory, "executions.jsonl");
await writeFile(
  fixture,
  `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('desktop-fixture-1');process.exit(0)}if(process.argv.includes('debug')&&process.argv.includes('config')){console.log('{}');process.exit(0)}let text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(executionLog)},JSON.stringify({pid:process.pid,observed:text.includes('OBSERVE_LONG_TASK')})+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'desktop-native'}));const finish=()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'DESKTOP_RUNTIME_OK '+process.execPath}}));console.log(JSON.stringify({type:'turn.completed'}))};if(text.includes('OBSERVE_LONG_TASK')){const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);finish()}},100)}else finish()});`,
);
await writeFile(
  join(namespace, "sessions", "desktop-native.jsonl"),
  JSON.stringify({
    type: "session_meta",
    payload: { id: "desktop-native", cwd: directory },
  }) + "\n",
);
const configPath = join(namespace, "config.toml");
await writeFile(
  configPath,
  '# Desktop persistence test\nmodel = "desktop-original"\n',
);
// Launch without any system Node/npm paths. Only Windows utilities remain available.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "PATH"].includes(
        key.toUpperCase(),
      ),
  ),
);
env.PATH = [
  join(process.env.SystemRoot, "System32"),
  process.env.SystemRoot,
  join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
].join(";");
env.CODEX_HOME = namespace;
env.LOOPMARSHAL_DESKTOP_DATA_DIR = data;
env.LOOPMARSHAL_DESKTOP_PORT = "0";
let electron;
let page;
let info;
let client;
let endpoint;
let observationEvidence;
const errors = [];
async function waitForInputValue(locator, expected) {
  await locator.waitFor({ state: "attached" });
  let actual;
  for (let attempt = 0; attempt < 200; attempt++) {
    actual = await locator.inputValue();
    if (actual === expected) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(actual, expected);
}
async function launch() {
  electron = await _electron.launch({
    executablePath: executable,
    cwd: directory,
    env,
    timeout: 60000,
    chromiumSandbox: true,
  });
  page = await electron.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByText("LoopMarshal", { exact: true }).first().waitFor();
  info = await page.evaluate(() => window.loopmarshalDesktop.getInfo());
  assert.equal(info.packaged, true);
  assert.equal(info.dataDirectory, data);
  assert.equal(info.nodeVersion, "v24.14.0");
  assert.equal(
    info.version,
    expectedVersion,
    "The executable must match the current desktop release",
  );
  endpoint = JSON.parse(
    await readFile(join(data, "desktop/endpoint.json"), "utf8"),
  );
  const { token } = await (
    await fetch(info.baseUrl + "/api/local-auth")
  ).json();
  client = createLoopMarshalClient({
    baseUrl: info.baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
}
async function quit() {
  const oldEndpoint = endpoint;
  await electron.close();
  electron = null;
  await assert.rejects(access(join(data, "desktop/endpoint.json")));
  assert.throws(() => process.kill(oldEndpoint.pid, 0));
  await assert.rejects(
    fetch(oldEndpoint.baseUrl + "/health", {
      signal: AbortSignal.timeout(2000),
    }),
  );
}
async function run(command, args) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      env,
      cwd: directory,
      windowsHide: true,
      windowsVerbatimArguments: /cmd\.exe$/i.test(command),
    });
    let output = "";
    child.stdout.on("data", (text) => (output += text));
    child.stderr.on("data", (text) => (output += text));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Command timed out"));
    }, 30000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}
try {
  await launch();
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (!options.properties.includes("openDirectory"))
        throw new Error("Expected a directory picker");
      return { canceled: false, filePaths: [path] };
    };
  }, directory);
  assert.equal(
    await page.evaluate(() =>
      window.loopmarshalDesktop.selectProjectDirectory(),
    ),
    directory,
  );
  assert.deepEqual(
    await page.evaluate(() => [typeof window.require, typeof window.process]),
    ["undefined", "undefined"],
  );
  assert.equal(
    await page.evaluate(() => window.loopmarshalDesktop.customTitleBar),
    true,
  );
  assert.equal(
    await page
      .locator(".desktop-titlebar")
      .evaluate((node) => getComputedStyle(node).webkitAppRegion),
    "drag",
  );
  assert.equal(
    await page
      .locator(".desktop-titlebar")
      .evaluate((node) => node.clientHeight),
    36,
  );
  assert.ok(
    await page
      .locator(".desktop-titlebar-brand .loop-mark")
      .evaluate(
        (node) => node.complete && node.naturalWidth > 0 && node.width === 24,
      ),
    "The shared brand icon is visible in the titlebar",
  );
  await page.getByRole("link", { name: "发现 Worker", exact: true }).waitFor();
  assert.ok(
    await page.evaluate(() => {
      const color = (selector) =>
        getComputedStyle(document.querySelector(selector)).backgroundColor;
      return (
        color(".desktop-titlebar") === color(".workbench-header") &&
        color(".desktop-titlebar-brand") === color(".app-sidebar")
      );
    }),
    "Window chrome shares the page and navigation surfaces",
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.loopmarshalDesktop.setWindowTheme("invalid");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await page.locator('html[data-theme="dark"]').waitFor({ state: "attached" });
  await page.screenshot({
    path: join(directory, "integrated-titlebar-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();
  await page.locator('html[data-theme="light"]').waitFor({ state: "attached" });
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].maximize(),
  );
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMaximized(),
    ),
    true,
  );
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].unmaximize(),
  );
  const { session, agent } = await client.createSession({
    sessionName: "桌面包验收",
    agentName: "主控",
    displayName: "主控",
    platform: "generic",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  const external = await run(join(resources, "runtime/node.exe"), [
    join(resources, "cli-wrapper.mjs"),
    "attach",
    "桌面外部主控",
    "--session",
    "桌面外部会话",
    "--role",
    "host",
    "--duty",
    "通过 CLI 指挥当前项目",
  ]);
  assert.equal(external.code, 0, external.output);
  const externalSession = await client.getSessionByName("桌面外部会话");
  assert.equal(
    externalSession.projectPath.toLowerCase(),
    directory.toLowerCase(),
  );
  await page
    .getByRole("button", { name: "新建协作", exact: true })
    .first()
    .click();
  const dialog = page.locator(".modal-backdrop");
  assert.deepEqual(
    await dialog
      .getByLabel("主控运行方式", { exact: true })
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["core_runtime", "managed_proxy"],
  );
  await dialog.getByLabel("项目目录", { exact: true }).fill(directory);
  await dialog.getByLabel("主控模型", { exact: true }).selectOption("");
  assert.equal(
    await dialog
      .getByRole("button", { name: "检查配置", exact: true })
      .getAttribute("aria-disabled"),
    "true",
  );
  await dialog.getByRole("alert").filter({ hasText: "选择模型配置" }).waitFor();
  assert.equal(
    await dialog.getByLabel("执行者名称", { exact: true }).count(),
    0,
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await page
    .getByRole("dialog", { name: "切换协作会话", exact: true })
    .getByRole("button", { name: "打开已有协作", exact: true })
    .click();
  await dialog.getByLabel("扫描项目目录", { exact: true }).fill(directory);
  await dialog.getByRole("button", { name: "开始扫描", exact: true }).click();
  await dialog.getByText(/找到 1 个会话/).waitFor();
  await dialog.getByLabel("打开会话 桌面外部会话", { exact: true }).click();
  await page
    .getByRole("heading", { name: "桌面外部会话", exact: true })
    .waitFor();
  assert.equal(
    (await client.getMembers(externalSession.id)).find(
      (member) => member.role === "host",
    ).id,
    externalSession.hostAgentId,
  );
  assert.equal(await page.locator(".conversation-thread").innerText(), "");
  assert.equal(
    await page
      .getByRole("textbox", { name: "发送给 Host 的消息", exact: true })
      .getAttribute("placeholder"),
    null,
  );
  const externalWorker = await run(join(resources, "runtime/node.exe"), [
    join(resources, "cli-wrapper.mjs"),
    "attach",
    "桌面外部开发",
    "--session",
    "桌面外部会话",
    "--role",
    "worker",
    "--duty",
    "实现任务",
  ]);
  assert.equal(externalWorker.code, 0, externalWorker.output);
  const externalMember = (await client.getMembers(externalSession.id)).find(
    (value) => value.agentName === "桌面外部开发",
  );
  await client.sendMessage({
    sessionId: externalSession.id,
    fromAgentId: externalSession.hostAgentId,
    toAgentId: externalMember.id,
    type: "task",
    payload: "DESKTOP_EXTERNAL_MEMBER_TASK",
  });
  const history = await run(join(resources, "runtime/node.exe"), [
    join(resources, "cli-wrapper.mjs"),
    "messages",
    "桌面外部主控",
    "--session",
    "桌面外部会话",
    "--member",
    "桌面外部开发",
  ]);
  assert.equal(history.code, 0, history.output);
  assert.ok(
    JSON.stringify(JSON.parse(history.output)).includes(
      "DESKTOP_EXTERNAL_MEMBER_TASK",
    ),
  );
  assert.equal(
    (await client.getInbox(externalMember.id))[0].processingStatus,
    "pending",
  );
  await page
    .getByRole("textbox", { name: "发送给 Host 的消息", exact: true })
    .fill("请查询开发成员并把答复发送到客户端");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("等待 Host 接收", { exact: true }).waitFor();
  const claimed = await run(join(resources, "runtime/node.exe"), [
    join(resources, "cli-wrapper.mjs"),
    "await",
    "桌面外部主控",
    "--session",
    "桌面外部会话",
  ]);
  assert.equal(claimed.code, 0, claimed.output);
  assert.equal(JSON.parse(claimed.output).op, "PROCESS_CLAIMED_MESSAGE");
  const replied = await run(join(resources, "runtime/node.exe"), [
    join(resources, "cli-wrapper.mjs"),
    "resolve",
    "桌面外部主控",
    "--session",
    "桌面外部会话",
    "--summary",
    "已检查开发任务，客户端答复链路正常",
  ]);
  assert.equal(replied.code, 0, replied.output);
  await page
    .getByText("已检查开发任务，客户端答复链路正常", { exact: true })
    .waitFor();
  assert.equal(
    (await client.listMessages(externalSession.id)).find(
      (value) => value.payload?.kind === "host_reply",
    ).processingStatus,
    "processed",
  );
  await page.screenshot({
    path: join(directory, "external-host-chat.png"),
    fullPage: true,
  });
  const installation = await client.createToolInstallation({
    toolId: "codex",
    displayName: "桌面测试工具",
    executablePath: fixture,
  });
  const member = await client.createProxyMember(session.id, {
    agentName: "前端开发",
    roleDescription: "验证桌面内置运行时",
    binding: {
      installationId: installation.id,
      workspacePath: directory,
      runtimeNamespace: namespace,
      nativeSessionId: "desktop-native",
    },
  });
  await client.verifyMemberRoute(
    session.id,
    member.agent.id,
    member.route.bindingVersion,
  );
  const managedSetup = (
    await client.getSessionConsole(session.id)
  ).members.find((value) => value.agentId === member.agent.id).automaticSetup;
  assert.equal(managedSetup.status, "ready");
  assert.equal(managedSetup.transport, "native_mcp");
  assert.match(
    await readFile(managedSetup.skillPath, "utf8"),
    /LoopMarshal managed collaboration/,
  );
  const managedMcpConfig = JSON.parse(
    await readFile(managedSetup.mcpConfigPath, "utf8"),
  );
  assert.equal(
    managedMcpConfig.mcpServers[managedSetup.serverName].command.toLowerCase(),
    join(resources, "runtime/node.exe").toLowerCase(),
  );
  const contextCheck = await run(join(resources, "runtime/node.exe"), [
    managedSetup.bridgePath,
    "session_context",
    "{}",
  ]);
  assert.equal(contextCheck.code, 0, contextCheck.output);
  assert.equal(
    JSON.parse(contextCheck.output).data.result.currentMember.id,
    member.agent.id,
  );
  const sent = await client.sendMessage({
    sessionId: session.id,
    fromAgentId: agent.id,
    toAgentId: member.agent.id,
    type: "task",
    payload: "Check desktop runtime",
    idempotencyKey: "desktop-smoke",
  });
  let delivered;
  for (let attempt = 0; attempt < 100; attempt++) {
    delivered = (await client.listDeliveries(session.id)).find(
      (value) => value.messageId === sent.id,
    );
    if (delivered?.state === "completed") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(delivered?.state, "completed");
  const report = await client.getMessageById(delivered.resultMessageId);
  const reportText = JSON.stringify(report);
  assert.match(reportText, /DESKTOP_RUNTIME_OK/);
  assert.ok(
    reportText
      .toLowerCase()
      .includes(
        join(resources, "runtime/node.exe")
          .replaceAll("\\", "\\\\")
          .toLowerCase(),
      ),
  );
  // Observe the exact running process without creating or restarting a turn.
  await page.goto(`${info.baseUrl}/?sessionId=${session.id}`);
  await page
    .getByRole("heading", { name: session.name, exact: true })
    .waitFor();
  const toolbar = page.getByRole("toolbar", { name: "协作操作", exact: true });
  const buttonSizes = await toolbar
    .locator(":scope > .btn")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const bounds = node.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, y: bounds.y };
      }),
    );
  assert.equal(buttonSizes.length, 6);
  assert.ok(
    buttonSizes.every(
      (size) =>
        size.height === 36 &&
        size.width === buttonSizes[0].width &&
        size.y === buttonSizes[0].y,
    ),
    JSON.stringify(buttonSizes),
  );
  assert.equal(await page.locator(".workbench-project").count(), 0);
  assert.equal(
    await page
      .locator(".workbench-header")
      .getByRole("button", { name: "刷新", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(".workbench-header")
      .getByRole("button", { name: "打开已有协作", exact: true })
      .count(),
    0,
  );
  await page.screenshot({
    path: join(directory, "compact-workbench.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  const switcher = page.getByRole("dialog", {
    name: "切换协作会话",
    exact: true,
  });
  await switcher.getByRole("button", { name: "刷新", exact: true }).waitFor();
  await switcher
    .getByRole("button", { name: "打开已有协作", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(directory, "session-list-actions.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  for (const route of [
    "models",
    "tools",
    "knowledge",
    "tool-config",
    "mcp",
    "preferences",
  ]) {
    await page.goto(`${info.baseUrl}/${route}`);
    await page.locator(".page-header h1").waitFor();
    assert.equal(
      await page.locator(".page-breadcrumb, .page-eyebrow").count(),
      0,
    );
    assert.ok(
      await page
        .locator(".page-header")
        .evaluate((node) => node.getBoundingClientRect().height <= 72),
      `${route} keeps a compact header`,
    );
    if (["models", "tools", "knowledge"].includes(route))
      await page.screenshot({
        path: join(directory, `compact-${route}.png`),
        fullPage: true,
      });
  }
  await page.goto(`${info.baseUrl}/?sessionId=${session.id}`);
  await page
    .getByRole("heading", { name: session.name, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "实时动态", exact: true }).click();
  const observedTask = await client.sendMessage({
    sessionId: session.id,
    fromAgentId: agent.id,
    toAgentId: member.agent.id,
    type: "task",
    payload: "OBSERVE_LONG_TASK",
  });
  const live = page.getByRole("region", { name: "实时动态", exact: true });
  await live
    .locator(".activity-running")
    .getByText("桌面测试工具 · 正在执行", { exact: true })
    .waitFor();
  const beforeObservation = (await client.listDeliveries(session.id)).find(
    (value) => value.messageId === observedTask.id,
  );
  assert.equal(beforeObservation.state, "awaiting_result");
  const executions = () =>
    readFile(executionLog, "utf8").then((value) =>
      value
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  const originalRuns = await executions();
  assert.equal(originalRuns.filter((value) => value.observed).length, 1);
  const originalPid = originalRuns.at(-1).pid;
  const observationCreated = electron.waitForEvent("window");
  await live.getByRole("button", { name: "查看运行", exact: true }).click();
  const observation = await observationCreated;
  await observation
    .getByRole("heading", { name: "运行观察", exact: true })
    .waitFor();
  await observation
    .getByText("同一任务的只读视图，关闭窗口后任务继续执行。", { exact: true })
    .waitFor();
  assert.equal(await observation.locator(".app-sidebar").count(), 0);
  assert.deepEqual(
    await observation.evaluate(() => [
      typeof window.require,
      typeof window.process,
    ]),
    ["undefined", "undefined"],
  );
  await observation.screenshot({
    path: join(directory, "running-observation.png"),
    fullPage: true,
  });
  await page.evaluate(
    ({ sid, mid }) => window.loopmarshalDesktop.openActivityWindow(sid, mid),
    { sid: session.id, mid: member.agent.id },
  );
  assert.equal(
    await electron.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    2,
    "Reuse the same observation window",
  );
  assert.ok(
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (window) =>
          window.isVisible() &&
          window.isFocused() &&
          window.webContents.getURL().includes("/activity?"),
      ),
    ),
    "Observation is brought to the foreground",
  );
  await observation
    .getByRole("button", { name: "查看对话历史", exact: true })
    .click();
  await page.getByRole("dialog", { name: "会话消息", exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("按成员筛选消息").inputValue(),
    member.agent.id,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "切换会话", exact: true })
      .getAttribute("data-session-id"),
    session.id,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.loopmarshalDesktop.openActivityWindow("../arbitrary");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await observation.close();
  assert.equal(
    await electron.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  );
  process.kill(originalPid, 0);
  const stillRunning = (await client.listDeliveries(session.id)).find(
    (value) => value.id === beforeObservation.id,
  );
  assert.equal(stillRunning.state, "awaiting_result");
  assert.equal(stillRunning.attemptId, beforeObservation.attemptId);
  assert.equal(stillRunning.snapshot.binding.nativeSessionId, "desktop-native");
  assert.equal((await executions()).length, originalRuns.length);
  await writeFile(releasePath, "continue the same task");
  for (let attempt = 0; attempt < 100; attempt++) {
    delivered = (await client.listDeliveries(session.id)).find(
      (value) => value.id === beforeObservation.id,
    );
    if (delivered?.state === "completed") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(delivered.state, "completed");
  assert.match(
    JSON.stringify(
      (await client.getMessageById(delivered.resultMessageId)).payload,
    ),
    /DESKTOP_RUNTIME_OK/,
  );
  assert.equal((await executions()).length, originalRuns.length);
  observationEvidence = {
    observedSameProcess: true,
    originalPid,
    sameAttempt: true,
    noAdditionalExecutions: true,
    closePreservesTask: true,
    historyOpensCorrectMember: true,
  };
  console.log(JSON.stringify(observationEvidence));
  await page.goto(info.baseUrl + "/tool-config");
  await page.getByRole("heading", { name: "工具配置", exact: true }).waitFor();
  await page
    .locator('input[aria-label="默认模型"], input[aria-label="配置名称"]')
    .first()
    .waitFor({ state: "attached" });
  if (
    await page
      .getByRole("button", { name: "其他配置目录", exact: true })
      .count()
  )
    await page
      .getByRole("button", { name: "其他配置目录", exact: true })
      .click();
  await page.getByLabel("配置名称", { exact: true }).fill("桌面配置验收");
  await page.getByLabel("工具配置目录", { exact: true }).fill(namespace);
  await page
    .getByRole("button", { name: "继续设置模型与密钥", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "默认模型", exact: true })
    .fill("desktop-saved");
  await page.getByLabel("认证方式", { exact: true }).selectOption("api_key");
  await page
    .getByLabel("API Key", { exact: true })
    .fill("local-desktop-auth-test-key");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("region", { name: "待保存的修改", exact: true })
    .waitFor();
  assert.ok(
    !(await page.locator("body").innerText()).includes(
      "local-desktop-auth-test-key",
    ),
  );
  assert.match(await readFile(configPath, "utf8"), /desktop-original/);
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page
    .getByText("已保存到工具配置，备份已生成", { exact: true })
    .waitFor();
  assert.match(await readFile(configPath, "utf8"), /desktop-saved/);
  assert.match(
    await readFile(configPath, "utf8"),
    /experimental_bearer_token.*local-desktop-auth-test-key/,
  );
  await page
    .locator('input[aria-label="API Key"][placeholder*="已配置"]')
    .waitFor();
  assert.equal(
    await page.getByLabel("API Key", { exact: true }).inputValue(),
    "",
  );
  await page.screenshot({
    path: join(directory, "desktop.png"),
    fullPage: true,
  });
  const cli = await run(join(resources, "runtime/node.exe"), [
    join(resources, "cli-wrapper.mjs"),
    "status",
  ]);
  assert.equal(cli.code, 0, cli.output);
  assert.equal(JSON.parse(cli.output).pid, endpoint.pid);
  const cmd = await run(process.env.ComSpec || "cmd.exe", [
    "/d",
    "/s",
    "/c",
    `""${info.cliPath}" --help"`,
  ]);
  assert.equal(cmd.code, 0, cmd.output);
  assert.match(cmd.output, /Usage: loopmarshal/);
  const duplicate = await run(executable, []);
  assert.equal(duplicate.code, 0);
  assert.equal((await fetch(info.baseUrl + "/health")).status, 200);
  if (values["codex-executable"]) {
    for (const key of [
      "codex-workspace",
      "codex-namespace",
      "codex-session",
      "codex-marker",
      "other-session-file",
    ])
      if (!values[key])
        throw new Error(
          `Missing --${key}; real verification requires explicit dedicated test conversations`,
        );
    const realInstallation = await client.createToolInstallation({
      toolId: "codex",
      displayName: "Real Codex desktop acceptance",
      executablePath: resolve(values["codex-executable"]),
    });
    const realMember = await client.createProxyMember(session.id, {
      agentName: "真实 Codex",
      roleDescription: "Dedicated history continuity acceptance",
      binding: {
        installationId: realInstallation.id,
        workspacePath: resolve(values["codex-workspace"]),
        runtimeNamespace: resolve(values["codex-namespace"]),
        nativeSessionId: values["codex-session"],
      },
    });
    await client.verifyMemberRoute(
      session.id,
      realMember.agent.id,
      realMember.route.bindingVersion,
    );
    const prompt =
      "Desktop installer acceptance. Repeat the original private history verification token from earlier in this conversation. Output only that token. Do not call tools or change any files. This prompt deliberately does not contain the token.";
    const dispatched = await run(join(resources, "runtime/node.exe"), [
      join(resources, "cli-wrapper.mjs"),
      "send",
      "--session",
      session.name,
      "--from",
      agent.agentName,
      "--to",
      "真实 Codex",
      "--type",
      "task",
      "--content",
      JSON.stringify({ content: prompt }),
      "--idempotency-key",
      "desktop-real-codex",
    ]);
    assert.equal(dispatched.code, 0, dispatched.output);
    let realDelivery;
    for (let attempt = 0; attempt < 360; attempt++) {
      realDelivery = (await client.listDeliveries(session.id)).find(
        (value) => value.targetAgentId === realMember.agent.id,
      );
      if (
        realDelivery &&
        ["completed", "failed", "unknown", "blocked"].includes(
          realDelivery.state,
        )
      )
        break;
      await new Promise((done) => setTimeout(done, 500));
    }
    assert.equal(realDelivery?.state, "completed", realDelivery?.error);
    assert.equal(
      realDelivery.snapshot.binding.nativeSessionId,
      values["codex-session"],
    );
    const result = await client.getMessageById(realDelivery.resultMessageId);
    assert.equal(result.toAgentId, agent.id);
    assert.ok(
      JSON.stringify(result.payload).includes(values["codex-marker"]),
      "Existing Codex history was not recalled",
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(values["other-session-file"]))
        .digest("hex"),
      otherHistoryHash,
      "Unaddressed Codex session was changed",
    );
    await writeFile(
      join(directory, "real-codex-events.json"),
      JSON.stringify(await client.getDeliveryEvents(realDelivery.id), null, 2),
    );
    console.log(
      JSON.stringify({
        realCodex: true,
        packagedCli: true,
        exactHistory: true,
        otherSessionUnchanged: true,
        nativeSessionId: values["codex-session"],
      }),
    );
  }
  await quit();
  const stopped = await run(join(resources, "runtime/node.exe"), [
    join(resources, "cli-wrapper.mjs"),
    "status",
  ]);
  assert.equal(stopped.code, 1);
  await launch();
  assert.equal(
    (await client.listMemberRoutes(session.id)).length,
    values["codex-executable"] ? 3 : 2,
  );
  assert.equal(
    (await client.listDeliveries(session.id)).find(
      (value) => value.id === delivered.id,
    )?.state,
    "completed",
  );
  assert.equal((await client.listToolConfigProfiles()).profiles.length, 1);
  const reconnected = await run(join(resources, "runtime/node.exe"), [
    managedSetup.bridgePath,
    "session_context",
    "{}",
  ]);
  assert.equal(reconnected.code, 0, reconnected.output);
  assert.equal(
    JSON.parse(reconnected.output).data.result.session.id,
    session.id,
  );
  await page.goto(info.baseUrl + "/tool-config");
  await page
    .getByRole("button", { name: "选择 桌面测试工具", exact: true })
    .click();
  await waitForInputValue(
    page.getByLabel("默认模型", { exact: true }),
    "desktop-saved",
  );
  assert.equal(
    await page.getByLabel("认证方式", { exact: true }).inputValue(),
    "api_key",
  );
  await page.getByText(/备份与恢复（1）/).click();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page.getByText("工具配置已恢复", { exact: true }).waitFor();
  assert.match(await readFile(configPath, "utf8"), /desktop-original/);
  assert.ok(
    !(await readFile(configPath, "utf8")).includes("experimental_bearer_token"),
  );
  for (const toolId of ["gemini", "kimi", "cursor", "droid", "copilot"]) {
    const added = await client.createToolInstallation({
      toolId,
      displayName: "兼容检查 " + toolId,
      executablePath: fixture,
    });
    assert.equal(added.compatibility.status, "experimental");
  }
  await page.goto(info.baseUrl + "/tools");
  const kimiCard = page
    .locator(".installation-card")
    .filter({ hasText: "兼容检查 kimi" });
  await kimiCard.getByText("可用", { exact: true }).waitFor();
  assert.equal(
    (
      await kimiCard.getByRole("note", { name: "工具可用情况" }).innerText()
    ).trim(),
    "可用",
  );
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /版本待验收|模型协作待验收|已验收版本|试用适配/,
  );
  const sourceIcon = await readFile(
    new URL("../apps/desktop/build/icon.ico", import.meta.url),
  );
  const shortcutIconHash = createHash("sha256")
    .update(sourceIcon)
    .digest("hex")
    .slice(0, 12);
  assert.ok(
    (
      await readFile(
        join(
          dirname(executable),
          "resources",
          `loopmarshal-icon-${shortcutIconHash}.ico`,
        ),
      )
    ).equals(sourceIcon),
    "The standalone shortcut icon matches the application icon",
  );
  await kimiCard.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(directory, "packaged-tool-compatibility.png"),
    fullPage: true,
  });
  await quit();
  assert.deepEqual(errors, []);
  const evidence = {
    passed: true,
    executable,
    directory,
    packaged: true,
    observation: observationEvidence,
    automaticRoleSkillAndMcp: true,
    managedBridgeWithBundledNode: true,
    managedBridgeRestart: true,
    hostRequired: true,
    hostModesRestricted: true,
    externalHostDiscovery: true,
    externalHostClientRoundtrip: true,
    hostMemberHistoryQuery: true,
    blankChat: true,
    projectDirectoryPicker: true,
    selfContainedRuntime: true,
    sqlite: true,
    nativeProxyRuntime: true,
    configurationSaveRestore: true,
    restartPersistence: true,
    singleInstance: true,
    cliEntry: true,
    gracefulExit: true,
    realCodex: Boolean(values["codex-executable"]),
    pageErrors: errors,
  };
  evidence.integratedWindowChrome = {
    dragRegion: true,
    darkAndLightThemes: true,
    maximizeAndRestore: true,
    invalidThemeRejected: true,
  };
  evidence.desktopVersion = expectedVersion;
  evidence.sharedBrandIconAndWorkerNaming = true;
  evidence.readinessOnlyAndStandaloneShortcutIcon = true;
  evidence.codexApiKeySaveMaskRestartRestore = true;
  evidence.packagedHeaderFixes = {
    continuousSurfaces: true,
    actionsInsideSessionList: true,
    compactPageHeaders: true,
    noProjectPathInHeader: true,
    equalToolbarButtons: true,
  };
  await writeFile(
    join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  console.error(`Desktop evidence directory: ${directory}`);
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(directory, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  if (electron) await electron.close();
}
