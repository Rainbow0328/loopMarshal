import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

const { values } = parseArgs({
  options: {
    playwright: { type: "string" },
    browser: { type: "string" },
    artifacts: { type: "string" },
  },
});
if (!values.playwright || !values.browser || !values.artifacts)
  throw new Error("Provide --playwright, --browser and --artifacts paths");
const { chromium } = await import(
  pathToFileURL(resolve(values.playwright)).href
);
const artifacts = resolve(values.artifacts);
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "loopmarshal-session-browser-"));
const cliPath = resolve("apps/cli/dist/apps/cli/src/index.js");
const mcpPath = resolve("apps/cli/dist/apps/cli/src/mcp-stdio-server.js");
async function attachThroughMcp(cwd, env, args, toolName = "attach") {
  const child = spawn(process.execPath, [mcpPath], {
    cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((done) => child.once("exit", done));
  try {
    const result = await new Promise((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP attach timed out: ${stderr}`)),
        30000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`MCP exited before responding: ${stderr}`));
      });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const message = JSON.parse(line);
          if (message.id !== 2) continue;
          clearTimeout(timer);
          if (message.error || message.result?.isError)
            reject(new Error(JSON.stringify(message)));
          else done(JSON.parse(message.result.content[0].text));
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }) + "\n",
      );
    });
    return result;
  } finally {
    child.stdin.end();
    child.kill();
    await exited;
  }
}
let core;
let browser;
let page;
try {
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
    root,
    "preferences.json",
  );
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(
    join(project, "README.md"),
    "# Session project\nBROWSER_PROJECT_42",
  );
  const namespace = join(root, "native");
  await mkdir(join(namespace, "sessions"), { recursive: true });
  const executable = join(root, "native-fixture.cjs");
  await writeFile(
    executable,
    `if(process.argv.includes('--version')){console.log('session-browser-1');process.exit(0)}let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
    const fs=require('node:fs');fs.mkdirSync(require('node:path').join(process.env.CODEX_HOME,'sessions'),{recursive:true});fs.appendFileSync(require('node:path').join(process.env.CODEX_HOME,'sessions','browser-host.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'browser-host',cwd:process.cwd()}})+'\\n');
    const script=prompt.match(/Script: ([^\\r\\n]+)/)[1];
    for(const tool of ['session_context','query_messages']){
      const args=tool==='query_messages'?{memberName:'IDE 代码审查'}:{};
      const result=require('node:child_process').spawnSync(process.execPath,[script,tool,JSON.stringify(args)],{encoding:'utf8',windowsHide:true});
      if(result.status!==0){console.error(result.stderr+result.stdout);process.exit(1)}
      const response=JSON.parse(result.stdout);if(!response.data?.success)throw new Error(JSON.stringify(response));
    }
    console.log(JSON.stringify({type:'thread.started',thread_id:'browser-host'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NATIVE_HOST_BROWSER_OK'}}));console.log(JSON.stringify({type:'turn.completed'}))});`,
  );
  core = await startCoreServer({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "core.sqlite"),
  });
  const baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  const { token } = await (await fetch(baseUrl + "/api/local-auth")).json();
  const client = createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
  const installed = await client.createToolInstallation({
    toolId: "codex",
    displayName: "Browser Codex",
    executablePath: executable,
  });
  browser = await chromium.launch({
    executablePath: resolve(values.browser),
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let sessionListRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/sessions"
    )
      sessionListRequests++;
  });
  await page.goto(baseUrl);
  await page
    .getByRole("button", { name: "新建协作", exact: true })
    .first()
    .click();
  const dialog = page.locator(".modal-backdrop");
  const submit = dialog.getByRole("button", {
    name: /创建协作|检查配置/,
    exact: true,
  });
  await dialog.getByLabel("会话名称", { exact: true }).fill("浏览器项目会话 A");
  assert.equal(await submit.getAttribute("aria-disabled"), "true");
  await dialog.getByLabel("项目目录", { exact: true }).fill(project);
  assert.deepEqual(
    await dialog
      .getByLabel("主控运行方式", { exact: true })
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["core_runtime", "managed_proxy"],
  );
  assert.equal(
    await dialog.getByLabel("执行者名称", { exact: true }).count(),
    0,
  );
  assert.equal(
    await dialog.getByLabel("知识库维护者名称", { exact: true }).count(),
    0,
  );
  await dialog.getByText(/选择模型或本机 Worker 即可/).waitFor();
  assert.equal(await dialog.locator("details[open]").count(), 0);
  await dialog.getByLabel("主控模型", { exact: true }).selectOption("");
  assert.equal(await submit.getAttribute("aria-disabled"), "true");
  await dialog
    .getByLabel("主控运行方式", { exact: true })
    .selectOption("managed_proxy");
  assert.equal(await submit.getAttribute("aria-disabled"), "true");
  await dialog
    .getByLabel("主控 Worker", { exact: true })
    .selectOption(installed.id);
  assert.equal(
    await dialog.getByLabel("会话处理方式", { exact: true }).inputValue(),
    "create",
  );
  assert.equal(
    await dialog.getByLabel("主控已有会话编号", { exact: true }).count(),
    0,
  );
  await dialog.getByLabel("主控工具数据目录", { exact: true }).fill(namespace);
  assert.equal(await submit.getAttribute("aria-disabled"), "false");
  await dialog.getByLabel("主控名称", { exact: true }).fill(" ");
  assert.equal(await submit.getAttribute("aria-disabled"), "true");
  await dialog.getByLabel("主控名称", { exact: true }).fill("主控");
  await dialog
    .getByRole("button", { name: "添加 Worker", exact: true })
    .click();
  await dialog.getByLabel("执行者名称", { exact: true }).fill("IDE 代码审查");
  await dialog
    .getByLabel("执行者运行方式", { exact: true })
    .selectOption("mcp_await");
  await dialog
    .getByRole("button", { name: "添加 Worker", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "添加知识库维护者", exact: true })
    .click();
  assert.equal(
    await dialog
      .getByLabel("知识库维护者运行方式", { exact: true })
      .inputValue(),
    "core_runtime",
  );
  await page.screenshot({
    path: join(artifacts, "create-session.png"),
    fullPage: true,
  });
  const setupResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/sessions/setup") &&
      r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "创建协作", exact: true }).click();
  const setup = await (await setupResponse).json();
  assert.equal(setup.success, true, JSON.stringify(setup));
  const a = setup.data;
  await page
    .getByRole("heading", { name: "浏览器项目会话 A", exact: true })
    .waitFor();
  assert.equal(await page.locator(".modal-backdrop").count(), 0);
  assert.equal(a.session.projectPath.toLowerCase(), project.toLowerCase());
  assert.equal(a.members.length, 4);
  const managedMembers = (await client.getSessionConsole(a.session.id)).members;
  assert.ok(
    managedMembers.every((member) => member.automaticSetup?.status === "ready"),
  );
  assert.equal(
    new Set(managedMembers.map((member) => member.automaticSetup.bridgePath))
      .size,
    4,
  );
  assert.equal(
    await page.getByText("协作配置已就绪", { exact: true }).count(),
    0,
  );
  await page.locator("textarea").fill("请先理解当前项目");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("NATIVE_HOST_BROWSER_OK", { exact: true }).waitFor();
  assert.equal(
    (await client.listMemberRoutes(a.session.id)).find(
      (member) => member.agent.role === "host",
    ).route.binding.nativeSessionId,
    "browser-host",
  );
  await page.screenshot({
    path: join(artifacts, "host-main.png"),
    fullPage: true,
  });
  const ide = a.members.find((m) => m.agentName === "IDE 代码审查");
  await client.sendMessage({
    sessionId: a.session.id,
    fromAgentId: a.agent.id,
    toAgentId: ide.id,
    type: "task",
    payload: "ONLY_IDE_REVIEW_MESSAGE",
  });
  await page.getByRole("button", { name: "成员 (4)", exact: true }).click();
  const membersDialog = page.getByRole("dialog", {
    name: "会话成员",
    exact: true,
  });
  await membersDialog
    .locator(".member-directory-row")
    .filter({ hasText: "知识库维护者" })
    .first()
    .waitFor();
  await page.screenshot({
    path: join(artifacts, "session-members.png"),
    fullPage: true,
  });
  await membersDialog
    .locator(".member-directory-row")
    .filter({ hasText: "IDE 代码审查" })
    .getByRole("button", { name: "查看消息", exact: true })
    .click();
  const messagesDialog = page.getByRole("dialog", {
    name: "会话消息",
    exact: true,
  });
  await messagesDialog
    .getByText("ONLY_IDE_REVIEW_MESSAGE", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await client.upsertKnowledge({
    sessionId: a.session.id,
    level: "l1",
    slug: "a-decision",
    title: "A 专属决策",
    content: "A_ONLY_KNOWLEDGE_CONTENT",
  });
  const projectB = join(root, "project-b");
  await mkdir(projectB);
  const env = {
    ...process.env,
    LOOPMARSHAL_HOME: join(root, "home"),
    LOOPMARSHAL_BASE_URL: baseUrl,
    LOOPMARSHAL_PORT: new URL(baseUrl).port,
    LOOPMARSHAL_HOST: "127.0.0.1",
  };
  const run = promisify(execFile);
  await run(
    process.execPath,
    [
      cliPath,
      "attach",
      "CLI 项目主控",
      "--session",
      "浏览器项目会话 B",
      "--role",
      "host",
      "--duty",
      "从项目 B 指挥协作",
    ],
    { cwd: projectB, env, windowsHide: true },
  );
  const sessionB = await client.getSessionByName("浏览器项目会话 B");
  const b = {
    session: sessionB,
    agent: (await client.getMembers(sessionB.id)).find(
      (agent) => agent.role === "host",
    ),
  };
  await client.sendMessage({
    sessionId: b.session.id,
    fromAgentId: b.agent.id,
    toAgentId: b.agent.id,
    type: "instruction",
    payload: "EXTERNAL_HOST_PRESERVED_MESSAGE",
  });
  assert.equal(b.session.projectPath.toLowerCase(), projectB.toLowerCase());
  const requestsBeforeRefresh = sessionListRequests;
  await page.waitForTimeout(6000);
  assert.equal(
    sessionListRequests,
    requestsBeforeRefresh,
    "Session lists should not poll or refresh on background message events",
  );
  assert.equal(
    await page
      .locator('select[aria-label="当前会话"] option')
      .filter({ hasText: "浏览器项目会话 B" })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(
    (id) =>
      [
        ...document.querySelectorAll('select[aria-label="当前会话"] option'),
      ].some((option) => option.value === id),
    b.session.id,
  );
  assert.equal(sessionListRequests, requestsBeforeRefresh + 1);
  await attachThroughMcp(root, env, {
    name: "IDE 项目主控",
    session: "MCP 项目会话 C",
    role: "host",
    duty: "通过 MCP 指挥项目 A",
    projectPath: project,
  });
  const c = await client.getSessionByName("MCP 项目会话 C");
  assert.equal(c.projectPath.toLowerCase(), project.toLowerCase());
  await page.getByRole("button", { name: "打开已有协作", exact: true }).click();
  await dialog
    .getByLabel("打开会话 浏览器项目会话 B", { exact: true })
    .waitFor();
  await dialog.getByLabel("打开会话 MCP 项目会话 C", { exact: true }).waitFor();
  await dialog.getByLabel("扫描项目目录", { exact: true }).fill(projectB);
  await dialog.getByRole("button", { name: "开始扫描", exact: true }).click();
  await dialog.getByText(/找到 1 个会话/).waitFor();
  assert.equal(
    await dialog.getByLabel("打开会话 MCP 项目会话 C", { exact: true }).count(),
    0,
  );
  await page.screenshot({
    path: join(artifacts, "discover-sessions.png"),
    fullPage: true,
  });
  await dialog.getByLabel("打开会话 浏览器项目会话 B", { exact: true }).click();
  await page
    .getByRole("heading", { name: "浏览器项目会话 B", exact: true })
    .waitFor();
  await page.getByText("CLI 项目主控", { exact: true }).first().waitFor();
  await page
    .getByText("EXTERNAL_HOST_PRESERVED_MESSAGE", { exact: true })
    .first()
    .waitFor();
  const preserved = await client.claimNext(b.agent.id);
  await client.completeMessage(preserved.id, { agentId: b.agent.id });
  await run(
    process.execPath,
    [
      cliPath,
      "attach",
      "Frontend",
      "--session",
      "浏览器项目会话 B",
      "--role",
      "worker",
      "--duty",
      "Develop",
    ],
    { cwd: projectB, env, windowsHide: true },
  );
  const frontend = (await client.getMembers(b.session.id)).find(
    (member) => member.agentName === "Frontend",
  );
  await client.sendMessage({
    sessionId: b.session.id,
    fromAgentId: b.agent.id,
    toAgentId: frontend.id,
    type: "task",
    payload: "CLI_FRONTEND_TASK",
  });
  const pendingWorker = await client.getInbox(frontend.id);
  const cliHistory = JSON.parse(
    (
      await run(
        process.execPath,
        [
          cliPath,
          "messages",
          "CLI 项目主控",
          "--session",
          "浏览器项目会话 B",
          "--member",
          "Frontend",
        ],
        { cwd: projectB, env, windowsHide: true },
      )
    ).stdout,
  );
  assert.equal(cliHistory.success, true);
  assert.ok(JSON.stringify(cliHistory).includes("CLI_FRONTEND_TASK"));
  const mcpHistory = await attachThroughMcp(
    projectB,
    env,
    {
      name: "CLI 项目主控",
      session: "浏览器项目会话 B",
      memberName: "Frontend",
    },
    "query_messages",
  );
  assert.equal(mcpHistory.success, true);
  assert.deepEqual(await client.getInbox(frontend.id), pendingWorker);
  const composer = page.getByRole("textbox", {
    name: "发送给 Host 的消息",
    exact: true,
  });
  assert.equal(await composer.getAttribute("placeholder"), null);
  assert.equal(
    await page.locator(".prompt-suggestions, .conversation-start").count(),
    0,
  );
  await composer.fill("请检查前端任务并回复到这里");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("等待 Host 接收", { exact: true }).waitFor();
  const claimed = JSON.parse(
    (
      await run(
        process.execPath,
        [cliPath, "await", "CLI 项目主控", "--session", "浏览器项目会话 B"],
        { cwd: projectB, env, windowsHide: true },
      )
    ).stdout,
  );
  assert.equal(claimed.op, "PROCESS_CLAIMED_MESSAGE");
  assert.ok(JSON.stringify(claimed).includes("请检查前端任务并回复到这里"));
  await run(
    process.execPath,
    [
      cliPath,
      "resolve",
      "CLI 项目主控",
      "--session",
      "浏览器项目会话 B",
      "--summary",
      "已检查前端任务，答复回到客户端",
    ],
    { cwd: projectB, env, windowsHide: true },
  );
  await page
    .getByText("已检查前端任务，答复回到客户端", { exact: true })
    .waitFor();
  const reply = (await client.listMessages(b.session.id)).find(
    (message) => message.payload?.kind === "host_reply",
  );
  assert.equal(reply.processingStatus, "processed");
  await page.screenshot({
    path: join(artifacts, "external-host-chat.png"),
    fullPage: true,
  });
  assert.equal(
    (await client.getMembers(b.session.id)).find(
      (agent) => agent.role === "host",
    ).id,
    b.agent.id,
  );
  await page.getByRole("button", { name: "打开已有协作", exact: true }).click();
  await dialog.getByLabel("打开会话 MCP 项目会话 C", { exact: true }).click();
  await page
    .getByRole("heading", { name: "MCP 项目会话 C", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /成员 \(1\)/ }).click();
  await page
    .getByRole("dialog", { name: "会话成员", exact: true })
    .getByText("IDE 项目主控", { exact: true })
    .first()
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".conversation-thread").innerText(), "");
  await page.screenshot({
    path: join(artifacts, "blank-host-chat.png"),
    fullPage: true,
  });
  await client.upsertKnowledge({
    sessionId: b.session.id,
    level: "l1",
    slug: "b-decision",
    title: "B 专属决策",
    content: "B_ONLY_KNOWLEDGE_CONTENT",
  });
  await page.goto(baseUrl + "/knowledge");
  await page
    .getByLabel("知识库会话", { exact: true })
    .selectOption(a.session.id);
  await page.getByRole("button", { name: /A 专属决策/ }).click();
  await page
    .locator("article")
    .getByText("A_ONLY_KNOWLEDGE_CONTENT", { exact: true })
    .waitFor();
  await page
    .getByLabel("知识库会话", { exact: true })
    .selectOption(b.session.id);
  await page
    .locator("article")
    .getByText("B_ONLY_KNOWLEDGE_CONTENT", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("A_ONLY_KNOWLEDGE_CONTENT", { exact: true }).count(),
    0,
  );
  await client.upsertKnowledge({
    sessionId: b.session.id,
    level: "l1",
    slug: "b-decision",
    title: "B 专属决策",
    content: "B_LIVE_UPDATED_KNOWLEDGE",
  });
  await page
    .locator("article")
    .getByText("B_LIVE_UPDATED_KNOWLEDGE", { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(artifacts, "session-knowledge.png"),
    fullPage: true,
  });
  await page.goto(baseUrl);
  await page
    .getByRole("heading", { name: "浏览器项目会话 B", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectRequired: true,
      mixedCreation: true,
      nativeHostCreatedOnFirstMessage: true,
      hostFocused: true,
      hostRequired: true,
      hostModesRestricted: true,
      optionalMembers: true,
      automaticRoleSkillAndTools: true,
      independentMemberBindings: true,
      externalCliHost: true,
      externalMcpHost: true,
      manualSessionRefresh: true,
      noSessionListPolling: true,
      projectFilteredDiscovery: true,
      existingHostPreserved: true,
      memberMessages: true,
      hostHistoryQueryCliAndMcp: true,
      nonConsumingHistory: true,
      externalHostClientRoundtrip: true,
      blankChat: true,
      keeperVisible: true,
      sessionKnowledgeIsolation: true,
      automaticDocumentOpen: true,
      liveKnowledge: true,
      sharedSelection: true,
      pageErrors: errors.length,
      artifacts,
    }),
  );
} catch (error) {
  if (page) {
    await page.screenshot({
      path: join(artifacts, "failure.png"),
      fullPage: true,
    });
    await writeFile(
      join(artifacts, "failure.txt"),
      await page.locator("body").innerText(),
    );
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (core) await core.close();
  await rm(root, { recursive: true, force: true });
}
