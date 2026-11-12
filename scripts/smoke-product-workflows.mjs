import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "node:http";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

const { values } = parseArgs({
  options: {
    playwright: { type: "string" },
    browser: { type: "string" },
    artifacts: { type: "string" },
  },
});
for (const key of ["playwright", "browser", "artifacts"])
  if (!values[key]) throw new Error(`Provide --${key}`);
const { chromium } = await import(
  pathToFileURL(resolve(values.playwright)).href
);
const artifacts = resolve(values.artifacts);
await mkdir(artifacts, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "loopmarshal-product-ui-"));
let core, browser, page, nativeHealthServer;
const evidence = { screenshots: [], errors: [] };
try {
  process.env.LOOPMARSHAL_WEB_DIST_PATH = resolve("apps/web/dist");
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
    root,
    "preferences.json",
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
  browser = await chromium.launch({
    executablePath: resolve(values.browser),
    headless: true,
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  let sessionSocketCount = 0;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/ws") sessionSocketCount++;
  });
  const screenshot = async (name) => {
    await page.screenshot({ path: join(artifacts, name), fullPage: true });
    evidence.screenshots.push(name);
  };
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const assertFits = async (label) =>
    assert.deepEqual(
      await page.evaluate(() => ({
        page: document.documentElement.scrollWidth > innerWidth + 1,
        main: (() => {
          const node = document.querySelector(".app-main");
          return node.scrollWidth > node.clientWidth + 1;
        })(),
        dialog: [
          ...document.querySelectorAll(".dialog-panel:not([inert])"),
        ].some((node) => node.scrollWidth > node.clientWidth + 1),
      })),
      { page: false, main: false, dialog: false },
      label,
    );

  await page.goto(baseUrl);
  await page
    .getByRole("heading", { name: "让你的 AI 团队，围绕项目协作", exact: true })
    .waitFor();
  await screenshot("welcome.png");

  const project = join(root, "电商管理台");
  await mkdir(project);
  await writeFile(
    join(project, "README.md"),
    "# 商品管理台\nReact + TypeScript. Maintain session-specific project knowledge.\n",
  );
  const namespace = join(root, "codex-profile");
  await mkdir(join(namespace, "sessions"), { recursive: true });
  const history = join(namespace, "sessions", "ui-host.jsonl");
  await writeFile(
    history,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "ui-host", cwd: project },
    }) + "\n",
  );
  const fixture = join(root, "fixture.cjs");
  await writeFile(
    fixture,
    `if(process.argv.includes('--version')){console.log('ui-fixture-1');process.exit(0)}if(process.argv.includes('debug')&&process.argv.includes('config')){console.log('{}');process.exit(0)}process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'ui-host'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已收到补充意见，将更新会话计划。'}}));console.log(JSON.stringify({type:'turn.completed'}))});`,
  );
  const installation = await client.createToolInstallation({
    toolId: "codex",
    displayName: "Codex · 项目主控",
    executablePath: fixture,
  });
  const setup = await client.createSessionSetup({
    sessionName: "商品管理台 · 搜索与筛选",
    projectPath: project,
    agents: [
      {
        role: "host",
        name: "项目主控",
        duty: "理解项目、编排成员、核实回报并验收",
        mode: "managed_proxy",
        binding: {
          installationId: installation.id,
          workspacePath: project,
          runtimeNamespace: namespace,
          nativeSessionId: "ui-host",
        },
      },
      {
        role: "worker",
        name: "前端开发",
        duty: "实现商品搜索与筛选，验证键盘交互",
        mode: "mcp_await",
      },
      {
        role: "knowledge_keeper",
        name: "项目知识维护",
        duty: "核实并记录当前会话的设计决策",
        mode: "cli_await",
      },
    ],
  });
  const sid = setup.session.id,
    host = setup.agent;
  const worker = setup.members.find(
    (member) => member.agentName === "前端开发",
  );
  await client.sendMessage({
    sessionId: sid,
    fromAgentId: host.id,
    toAgentId: host.id,
    type: "system",
    payload: {
      content:
        "已阅读项目结构。本轮优先完成搜索与筛选的交互，复用现有商品接口。",
    },
  });
  const task = await client.sendMessage({
    sessionId: sid,
    fromAgentId: host.id,
    toAgentId: worker.id,
    type: "task",
    correlationId: "search-filter-review",
    payload: {
      content: "实现商品搜索与分类筛选，补齐空结果、加载与接口失败状态。",
    },
  });
  await client.sendMessage({
    sessionId: sid,
    fromAgentId: worker.id,
    toAgentId: host.id,
    type: "result",
    correlationId: task.correlationId,
    payload: {
      content:
        "搜索与分类筛选已实现，组合筛选与空结果检查通过。接口失败后的重试逻辑仍需确认。",
    },
  });
  await client.updateSessionInsight({
    sessionId: sid,
    updatedByAgentId: host.id,
    objective: "让用户快速定位商品，并能清楚理解筛选结果",
    activePlanSummary:
      "先核实筛选交互与失败重试，再同步项目知识，最后邀请用户验收。",
    acceptanceCriteria: [
      "搜索与分类可以组合",
      "空结果可清除筛选",
      "失败后能重新加载",
    ],
    completedItems: ["搜索与分类交互已有成员回报"],
    pendingItems: ["Host 复核失败重试及验证记录"],
    blockers: [],
    reviewStatus: "in_progress",
    readyForReview: false,
  });
  await client.upsertKnowledge({
    sessionId: sid,
    level: "l1",
    slug: "product-goals",
    title: "搜索与筛选的验收标准",
    content:
      "# 搜索与筛选\n\n- 支持关键字与分类组合\n- 空结果提供清除筛选入口\n- 接口失败可重新加载\n\n## 决策\n保留现有商品接口，先验证交互闭环。",
  });
  await page.reload();
  await page
    .getByRole("heading", { name: setup.session.name, exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator(".session-overview, .host-panel-header, .host-binding")
      .count(),
    0,
  );
  assert.ok(
    await page
      .locator(".host-panel")
      .evaluate(
        (node) => node.clientWidth / node.parentElement.clientWidth > 0.96,
      ),
    "Conversation uses the full workspace width",
  );
  assert.equal(
    await page
      .locator(".conversation-thread")
      .getByText(/搜索与分类筛选已实现|实现商品搜索与分类筛选/)
      .count(),
    0,
    "Internal dispatch and worker reports stay out of the user conversation",
  );
  assert.equal(
    await page
      .locator(".conversation-thread .message-meta > strong")
      .getByText("前端开发", { exact: true })
      .count(),
    0,
  );
  await screenshot("workbench-light.png");
  await page.getByRole("button", { name: "进展", exact: true }).click();
  await dialog("会话进展")
    .getByRole("heading", { name: "让用户快速定位商品，并能清楚理解筛选结果" })
    .waitFor();
  await dialog("会话进展")
    .getByText("已回报 · 待 Host 验收", { exact: true })
    .waitFor();
  assert.equal(
    await dialog("会话进展")
      .getByRole("heading", { name: "会话进展", exact: true })
      .count(),
    1,
  );
  assert.deepEqual(
    await dialog("会话进展").evaluate((node) =>
      [
        ...node.querySelectorAll(
          ".overview-copy, .task-preview p, .overview-plan, .team-preview-copy small",
        ),
      ]
        .filter((item) => item.getClientRects().length)
        .map((item) => parseFloat(getComputedStyle(item).fontSize) >= 14)
        .filter((ok) => !ok),
    ),
    [],
    "Progress text is readable without zooming",
  );
  await screenshot("session-progress-readable.png");
  await page
    .locator(".task-preview")
    .filter({ hasText: "前端开发" })
    .first()
    .click();
  await dialog("消息详情")
    .getByText("任务：前端开发 / 已回报，待 Host 验收", { exact: true })
    .waitFor();
  await dialog("消息详情")
    .getByText(/相关消息（[1-9]\d* 条）/)
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.classList.contains("task-preview"),
    ),
    true,
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "成员 (3)", exact: true }).click();
  const directory = dialog("会话成员");
  assert.equal(await directory.locator(".member-directory-row").count(), 3);
  await directory
    .locator(".member-directory-row")
    .filter({ hasText: "项目主控" })
    .getByText("Host", { exact: true })
    .waitFor();
  assert.equal(await directory.locator(".conversation-message").count(), 0);
  await screenshot("members.png");
  await directory
    .locator(".member-directory-row")
    .filter({ hasText: "前端开发" })
    .getByRole("button", { name: "查看消息", exact: true })
    .click();
  const browserDialog = dialog("会话消息");
  assert.equal(
    await browserDialog.getByLabel("按成员筛选消息").inputValue(),
    worker.id,
  );
  await browserDialog.getByLabel("搜索会话消息").fill("组合筛选");
  assert.equal(await browserDialog.locator(".conversation-message").count(), 1);
  await browserDialog
    .getByRole("button", { name: "详情", exact: true })
    .click();
  assert.equal(
    await browserDialog.evaluate((node) => node.parentElement.inert),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await dialog("消息详情").evaluate((node) =>
      node.contains(document.activeElement),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await browserDialog.evaluate((node) =>
      node.contains(document.activeElement),
    ),
    true,
  );
  await page.keyboard.press("Escape");
  evidence.taskReportAndNestedDialogs = true;
  evidence.membersIncludeHostAndIndependentMessageBrowser = true;

  // Live activity starts at opening time, while history remains searchable.
  for (let attempt = 0; attempt < 200; attempt++) {
    const previous = await client.listDeliveries(sid);
    if (
      previous.length &&
      previous.every((delivery) => delivery.state === "completed")
    )
      break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(
    (await client.listDeliveries(sid)).every(
      (delivery) => delivery.state === "completed",
    ),
  );
  const socketsBeforeActivity = sessionSocketCount;
  await page.getByRole("button", { name: "实时动态", exact: true }).click();
  const live = page.getByRole("region", { name: "实时动态", exact: true });
  await live.getByText("正在关注新的协作动态", { exact: true }).waitFor();
  assert.equal(
    sessionSocketCount,
    socketsBeforeActivity,
    "The activity panel must reuse the workbench session connection",
  );
  assert.equal(
    await live.locator(".activity-item").count(),
    0,
    "Opening live activity must not replay previous messages",
  );
  const liveTask = await client.sendMessage({
    sessionId: sid,
    fromAgentId: host.id,
    toAgentId: worker.id,
    type: "instruction",
    payload: "LIVE_ONLY_TASK · **请检查筛选键盘操作**",
  });
  await live.getByText(/LIVE_ONLY_TASK/).waitFor();
  assert.equal(
    await page
      .locator(".conversation-thread")
      .getByText(/LIVE_ONLY_TASK/)
      .count(),
    0,
  );
  const liveRow = live
    .locator(".activity-item")
    .filter({ hasText: "LIVE_ONLY_TASK" })
    .first();
  await liveRow.getByRole("button", { name: "查看详情", exact: true }).click();
  await dialog("动态详情")
    .locator("strong")
    .getByText("请检查筛选键盘操作", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  assert.equal(
    await live.count(),
    1,
    "Closing detail keeps live activity open",
  );
  // Finish the earlier pending task before claiming the new instruction.
  let claimedLive;
  for (let attempt = 0; attempt < 3; attempt++) {
    claimedLive = await client.claimNext(worker.id, {
      types: ["task", "instruction"],
    });
    if (!claimedLive) break;
    await client.completeMessage(claimedLive.id, { agentId: worker.id });
    if (claimedLive.id === liveTask.id) break;
  }
  assert.equal(claimedLive?.id, liveTask.id);
  await live.getByText("前端开发 · 已处理", { exact: true }).first().waitFor();
  await live.getByRole("button", { name: "查看对话历史", exact: true }).click();
  await browserDialog.getByLabel("搜索会话消息").fill("LIVE_ONLY_TASK");
  await browserDialog
    .locator(".message-preview")
    .getByText(/LIVE_ONLY_TASK/)
    .waitFor();
  await page.keyboard.press("Escape");
  await live.getByRole("button", { name: "关闭实时动态", exact: true }).click();
  await page.getByRole("button", { name: "实时动态", exact: true }).click();
  await live.getByText("正在关注新的协作动态", { exact: true }).waitFor();
  assert.equal(
    await live.locator(".activity-item").count(),
    0,
    "Reopening starts a new live view",
  );
  for (let index = 0; index < 14; index++)
    await client.sendMessage({
      sessionId: sid,
      fromAgentId: worker.id,
      toAgentId: host.id,
      type: "progress",
      payload: `LIVE_SCROLL_${index} · ${"正在验证筛选交互。".repeat(10)}`,
    });
  await live.getByText(/LIVE_SCROLL_13/).waitFor();
  await page.waitForFunction(() => {
    const node = document.querySelector(".activity-stream");
    return node.scrollHeight - node.scrollTop - node.clientHeight < 4;
  });
  await screenshot("live-activity.png");
  await live.getByRole("button", { name: "关闭实时动态", exact: true }).click();
  evidence.liveOnlyNewEventsAndHistory = true;
  assert.equal(
    sessionSocketCount,
    socketsBeforeActivity,
    "Opening and closing activity must not create extra session connections",
  );
  evidence.sharedSessionConnection = true;
  assert.equal(
    (await fetch(`${baseUrl}/activity?sessionId=${sid}`)).status,
    200,
    "Observation document loads normally",
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/sessions/${sid}/activity`)).status,
    403,
    "Execution data still requires management authentication",
  );
  const observer = await browser.newPage();
  await observer.goto(
    `${baseUrl}/activity?${new URLSearchParams({ sessionId: sid, memberId: worker.id })}`,
  );
  await observer
    .getByRole("heading", { name: "运行观察", exact: true })
    .waitFor();
  assert.equal(await observer.locator(".app-sidebar").count(), 0);
  await observer
    .getByRole("button", { name: "查看对话历史", exact: true })
    .click();
  await observer
    .getByRole("dialog", { name: "会话消息", exact: true })
    .waitFor();
  assert.equal(
    await observer.getByLabel("按成员筛选消息").inputValue(),
    worker.id,
  );
  await observer.close();
  evidence.observerHistoryDeepLink = true;

  await client.updateSessionInsight({
    sessionId: sid,
    updatedByAgentId: host.id,
    blockers: ["请确认接口错误时是否保留已有商品列表"],
    reviewStatus: "needs_user_input",
    reviewReason: "需要明确失败状态后再验收",
  });
  await page.getByRole("button", { name: "进展", exact: true }).click();
  await dialog("会话进展").getByText("等待你的补充", { exact: true }).waitFor();
  await page
    .getByRole("dialog", { name: "会话进展", exact: true })
    .getByText("请确认接口错误时是否保留已有商品列表", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await screenshot("workbench-dark.png");
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();

  let sends = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/messages/send"
    )
      sends++;
  });
  const composer = page.getByRole("textbox", {
    name: "发送给 Host 的消息",
    exact: true,
  });
  await composer.fill("保留已有列表，并提供重试入口");
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  assert.equal(sends, 0);
  await composer.press("Shift+Enter");
  assert.equal(sends, 0);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page
    .getByText("已收到补充意见，将更新会话计划。", { exact: true })
    .last()
    .waitFor();
  assert.equal(sends, 1);
  evidence.imeAndHostDelivery = true;

  // A failed request keeps the draft and provides a retry in the same composer.
  await page.route("**/api/messages/send", (route) => route.abort("failed"));
  await composer.fill("发送失败后保留这条内容");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator(".composer-error").waitFor();
  assert.equal(await composer.inputValue(), "发送失败后保留这条内容");
  await page.unroute("**/api/messages/send");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".composer-input")?.value === "",
  );
  assert.equal(await page.locator(".composer-error").count(), 0);
  evidence.sendFailureKeepsDraft = true;

  // Incoming messages must not pull someone away from older conversation history.
  for (let index = 0; index < 18; index++)
    await client.sendMessage({
      sessionId: setup.session.id,
      fromAgentId: setup.agent.id,
      toAgentId: setup.agent.id,
      type: "progress",
      payload: {
        kind: "host_reply",
        content: `SCROLL_HISTORY_${index} · ${"已核对当前任务与成员执行记录。".repeat(14)}`,
      },
    });
  await page.getByText(/^SCROLL_HISTORY_17/).waitFor();
  const conversation = page.locator(".host-conversation");
  await conversation.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(150);
  await client.sendMessage({
    sessionId: setup.session.id,
    fromAgentId: setup.agent.id,
    toAgentId: setup.agent.id,
    type: "progress",
    payload: {
      kind: "host_reply",
      content: "LATEST_MESSAGE_WITHOUT_SCROLL_JUMP",
    },
  });
  await page.getByRole("button", { name: "查看新消息", exact: true }).waitFor();
  assert.equal(await conversation.evaluate((node) => node.scrollTop), 0);
  await page.getByRole("button", { name: "查看新消息", exact: true }).click();
  await page.waitForFunction(() => {
    const node = document.querySelector(".host-conversation");
    return node.scrollHeight - node.scrollTop - node.clientHeight < 4;
  });
  evidence.readHistoryWithoutScrollJump = true;

  const markdown =
    "## 验证结果\n\n**已完成**：保持 Markdown 结构。\n\n```ts\nconst sample = 123;\n```\n\n| 检查 | 结果 |\n| --- | --- |\n| 消息 | 通过 |\n\n" +
    "更多验证记录。\n".repeat(150);
  await client.sendMessage({
    sessionId: sid,
    fromAgentId: host.id,
    toAgentId: host.id,
    type: "progress",
    payload: { kind: "host_reply", content: markdown },
  });
  await page.getByRole("button", { name: "对话历史", exact: true }).click();
  await browserDialog.getByLabel("搜索会话消息").fill("验证结果");
  const compact = browserDialog.locator(".conversation-message");
  await compact
    .locator(".message-preview")
    .getByText(/^验证结果/)
    .waitFor();
  assert.ok(
    await compact
      .locator(".message-preview")
      .evaluate((node) => node.clientHeight < 145),
  );
  assert.equal(
    await compact.getByRole("button", { name: "详情", exact: true }).count(),
    1,
  );
  assert.equal(
    await compact
      .getByRole("button", { name: "查看完整消息", exact: true })
      .count(),
    0,
  );
  await compact.getByRole("button", { name: "详情", exact: true }).click();
  await dialog("消息详情")
    .locator(".message-detail-content strong")
    .getByText("已完成", { exact: true })
    .waitFor();
  await dialog("消息详情")
    .locator(".message-detail-content pre code")
    .getByText("const sample = 123;", { exact: true })
    .waitFor();
  assert.equal(
    await dialog("消息详情").locator(".message-detail-content table").count(),
    1,
  );
  await page.keyboard.press("Escape");
  await browserDialog.getByLabel("搜索会话消息").fill("");
  await page.waitForFunction(
    () =>
      document.querySelectorAll(".message-browser-list .conversation-message")
        .length > 20,
  );
  const browsedHistory = browserDialog.locator(".message-browser-list");
  await browsedHistory.evaluate((node) => {
    node.scrollTop = 550;
  });
  await page.waitForTimeout(100);
  assert.ok(await browsedHistory.evaluate((node) => node.scrollTop > 0));
  const anchorId = await browsedHistory.evaluate((node) =>
    [...node.querySelectorAll(".conversation-message")]
      .find(
        (item) =>
          item.getBoundingClientRect().bottom >
          node.getBoundingClientRect().top + 20,
      )
      ?.getAttribute("data-message-id"),
  );
  const anchor = browsedHistory.locator(`[data-message-id="${anchorId}"]`);
  const before = await anchor.boundingBox();
  await client.sendMessage({
    sessionId: sid,
    fromAgentId: host.id,
    toAgentId: host.id,
    type: "progress",
    payload: "MESSAGE_BROWSER_NO_SCROLL_JUMP",
  });
  await browsedHistory
    .getByText("MESSAGE_BROWSER_NO_SCROLL_JUMP", { exact: true })
    .waitFor({ state: "attached" });
  const after = await anchor.boundingBox();
  assert.ok(
    Math.abs(after.y - before.y) < 3,
    "Reading an old message stays in place when new messages arrive",
  );
  await screenshot("message-browser.png");
  await page.keyboard.press("Escape");
  evidence.markdownPreviewAndStableMessageBrowser = true;

  // A large history has bounded initial DOM size; search still covers older records.
  for (let index = 0; index < 230; index++)
    await client.sendMessage({
      sessionId: sid,
      fromAgentId: host.id,
      toAgentId: worker.id,
      type: "progress",
      payload: `BATCHED_HISTORY_${String(index).padStart(3, "0")}`,
    });
  await page.getByRole("button", { name: "对话历史", exact: true }).click();
  await browserDialog.getByLabel("搜索会话消息").fill("BATCHED_HISTORY_");
  await browserDialog
    .getByText("230 条消息 · 最新在前", { exact: true })
    .waitFor();
  assert.equal(
    await browserDialog.locator(".conversation-message").count(),
    100,
  );
  assert.equal(
    await browserDialog
      .getByText("BATCHED_HISTORY_000", { exact: true })
      .count(),
    0,
  );
  await browserDialog.getByRole("button", { name: /加载更多消息/ }).click();
  assert.equal(
    await browserDialog.locator(".conversation-message").count(),
    200,
  );
  await browserDialog.getByLabel("搜索会话消息").fill("BATCHED_HISTORY_000");
  await browserDialog
    .getByText("1 条消息 · 最新在前", { exact: true })
    .waitFor();
  await browserDialog
    .getByText("BATCHED_HISTORY_000", { exact: true })
    .waitFor();
  assert.equal(await browserDialog.locator(".conversation-message").count(), 1);
  await screenshot("batched-message-history.png");
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .locator(".conversation-thread")
      .getByText(/BATCHED_HISTORY_/)
      .count(),
    0,
  );
  evidence.boundedHistoryRenderingAndFullSearch = true;

  await page.getByRole("button", { name: "查看绑定", exact: true }).click();
  await dialog("成员绑定与接入")
    .getByText("ui-host", { exact: true })
    .waitFor();
  assert.equal(
    await dialog("成员绑定与接入")
      .getByText("已登记身份", { exact: true })
      .count(),
    2,
  );
  await dialog("成员绑定与接入")
    .getByRole("tab", { name: "投递记录", exact: true })
    .click();
  await dialog("成员绑定与接入")
    .getByText("已回报，待 Host 验收", { exact: true })
    .first()
    .waitFor();
  await screenshot("member-deliveries.png");
  await page.keyboard.press("Escape");

  // Unsafe content remains inert in both conversation and knowledge readers.
  const unsafe =
    '[危险链接](javascript:alert(1))\n[属性测试](https://example.org/`x" onmouseover="alert`/)\n```x" onmouseover="alert(1)\n<img src=x onerror=alert(1)>\n```';
  await client.upsertKnowledge({
    sessionId: sid,
    level: "l3",
    slug: "render-check",
    title: "渲染检查",
    content: unsafe,
  });
  await page.goto(baseUrl + "/knowledge");
  await page.getByRole("button", { name: /搜索与筛选的验收标准/ }).click();
  await screenshot("knowledge.png");
  await page.getByRole("button", { name: /渲染检查/ }).click();
  await page.locator("article").getByText("危险链接").waitFor();
  assert.equal(
    await page
      .locator(
        'article [onmouseover], article [onerror], article img, article a[href^="javascript:"]',
      )
      .count(),
    0,
  );
  await page
    .getByRole("textbox", { name: "搜索知识文档" })
    .fill("不存在的知识");
  await page.getByText("没有匹配的文档", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await page.getByRole("button", { name: "变更记录", exact: true }).click();
  await dialog("知识库变更记录")
    .getByText("l1/product-goals", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  evidence.knowledgeAndSafeRendering = true;

  // Use an independent configuration profile so task routing cannot race file restoration.
  const configNamespace = join(root, "config-editor");
  await mkdir(configNamespace);
  const deliveryDeadline = Date.now() + 15000;
  while (Date.now() < deliveryDeadline) {
    if (
      !(await client.listDeliveries(sid)).some((item) =>
        ["queued", "delivering", "awaiting_result"].includes(item.state),
      )
    )
      break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(
    !(await client.listDeliveries(sid)).some((item) =>
      ["queued", "delivering", "awaiting_result", "unknown"].includes(
        item.state,
      ),
    ),
    "Fixture deliveries must settle before editing configuration",
  );
  await writeFile(
    join(configNamespace, "config.toml"),
    '# Keep this comment\nmodel = "original-model"\n',
  );
  process.env.CODEX_HOME = configNamespace;
  const configProfile = await client.createToolConfigProfile({
    installationId: installation.id,
    configRoot: configNamespace,
    workspacePath: project,
    name: "项目主控配置",
  });
  await page.goto(baseUrl + "/tool-config");
  await page.getByRole("button", { name: "项目主控配置", exact: true }).click();
  await page
    .getByRole("textbox", { name: "默认模型", exact: true })
    .fill("review-model");
  assert.equal(await page.locator(".native-config-document").count(), 1);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("region", { name: "待保存的修改", exact: true })
    .waitFor();
  assert.match(
    await readFile(join(configNamespace, "config.toml"), "utf8"),
    /original-model/,
  );
  await screenshot("config-preview.png");
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page
    .getByText("已保存到工具配置，备份已生成", { exact: true })
    .waitFor();
  assert.match(
    await readFile(join(configNamespace, "config.toml"), "utf8"),
    /review-model/,
  );
  await page.getByText(/备份与恢复（1）/).click();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page.getByText("工具配置已恢复", { exact: true }).waitFor();
  assert.match(
    await readFile(join(configNamespace, "config.toml"), "utf8"),
    /original-model/,
  );
  await page.getByLabel("认证方式", { exact: true }).selectOption("api_key");
  assert.equal(
    await page
      .getByRole("button", { name: "保存修改", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByLabel("API Key", { exact: true }).fill("local-ui-codex-key");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("region", { name: "待保存的修改", exact: true })
    .waitFor();
  assert.ok(
    !(await page.locator("body").innerText()).includes("local-ui-codex-key"),
  );
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('input[aria-label="API Key"]')
      ?.placeholder.includes("已配置"),
  );
  assert.equal(
    await page.getByLabel("API Key", { exact: true }).inputValue(),
    "",
  );
  assert.match(
    await readFile(join(configNamespace, "config.toml"), "utf8"),
    /experimental_bearer_token.*local-ui-codex-key/,
  );
  await screenshot("codex-direct-key.png");
  await page
    .getByRole("textbox", { name: "默认模型", exact: true })
    .fill("preserve-key-model");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".config-preview"));
  assert.match(
    await readFile(join(configNamespace, "config.toml"), "utf8"),
    /local-ui-codex-key/,
  );
  await page
    .getByLabel("认证方式", { exact: true })
    .selectOption("environment");
  assert.equal(
    await page.getByLabel("密钥环境变量名", { exact: true }).inputValue(),
    "OPENAI_API_KEY",
  );
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".config-preview"));
  const envConfig = await readFile(
    join(configNamespace, "config.toml"),
    "utf8",
  );
  assert.match(envConfig, /env_key.*OPENAI_API_KEY/);
  assert.ok(!envConfig.includes("experimental_bearer_token"));
  await screenshot("codex-environment-key.png");
  evidence.codexAuthenticationSelectionAndMaskedKeys = true;
  await page
    .getByRole("textbox", { name: "默认模型", exact: true })
    .fill("conflicting-change");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("region", { name: "待保存的修改", exact: true })
    .waitFor();
  await writeFile(
    join(configNamespace, "config.toml"),
    'model = "external-change"\n',
  );
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /重新读取|改变|修改/ })
    .waitFor();
  assert.match(
    await readFile(join(configNamespace, "config.toml"), "utf8"),
    /external-change/,
  );
  evidence.configPreviewSaveRestoreConflict = true;

  // Claude has a separate connection form and respects its existing env model source.
  const claudeRoot = join(root, "claude-config");
  await mkdir(claudeRoot);
  await writeFile(
    join(claudeRoot, "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_MODEL: "claude-custom",
        ANTHROPIC_AUTH_TOKEN: "fixture-private-token",
        ANTHROPIC_BASE_URL: "https://api.example.test",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-custom",
      },
      permissions: { allow: ["Read"] },
    }),
  );
  const claude = await client.createToolInstallation({
    toolId: "claude",
    displayName: "Claude Code",
    executablePath: fixture,
  });
  await client.createToolConfigProfile({
    installationId: claude.id,
    configRoot: claudeRoot,
    name: "Claude 用户配置",
  });
  await page.goto(baseUrl + "/tool-config?installationId=" + claude.id);
  await page.getByRole("textbox", { name: "默认模型", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "默认模型", exact: true })
      .inputValue(),
    "claude-custom",
  );
  assert.equal(
    await page
      .getByRole("textbox", { name: "API 地址", exact: true })
      .inputValue(),
    "https://api.example.test",
  );
  assert.equal(
    await page.getByLabel("认证令牌", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    (await page.locator("body").innerText()).includes("fixture-private-token"),
    false,
  );
  await page.locator(".native-extra-fields > summary").click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Sonnet 对应模型", exact: true })
      .inputValue(),
    "sonnet-custom",
  );
  await page
    .getByRole("textbox", { name: "默认模型", exact: true })
    .fill("claude-updated");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page
    .getByText("已保存到工具配置，备份已生成", { exact: true })
    .waitFor();
  const claudeSaved = JSON.parse(
    await readFile(join(claudeRoot, "settings.json"), "utf8"),
  );
  assert.equal(claudeSaved.env.ANTHROPIC_MODEL, "claude-updated");
  assert.equal(claudeSaved.env.ANTHROPIC_AUTH_TOKEN, "fixture-private-token");
  assert.deepEqual(claudeSaved.permissions, { allow: ["Read"] });
  await screenshot("claude-config.png");
  evidence.claudeEnvModelAndSecretPreservation = true;

  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const route of [
      "/",
      "/knowledge",
      "/models",
      "/tools",
      "/tool-config",
      "/mcp",
      "/preferences",
    ]) {
      await page.goto(baseUrl + route);
      await page.locator("h1").waitFor();
      await page.locator(".spinner").waitFor({ state: "hidden" });
      await assertFits(`${width} ${route}`);
      if (route !== "/") {
        assert.equal(await page.locator(".page-eyebrow").count(), 0);
        assert.ok(
          await page
            .locator(".page-header")
            .evaluate(
              (node) => node.clientHeight < (innerWidth > 1000 ? 130 : 210),
            ),
          `${route} has a compact header`,
        );
      }
    }
    await page.goto(baseUrl);
    await page
      .getByRole("heading", { name: setup.session.name, exact: true })
      .waitFor();
    if (width <= 800) {
      await page.getByRole("button", { name: "进展", exact: true }).click();
      await dialog("会话进展")
        .getByRole("heading", {
          name: "让用户快速定位商品，并能清楚理解筛选结果",
          exact: true,
        })
        .waitFor();
      await assertFits(`${width} session progress`);
      await screenshot(`progress-${width}.png`);
      await page.keyboard.press("Escape");
    }
    if (width === 390) {
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await page.keyboard.press("Shift+Tab");
      assert.equal(
        await page
          .locator(".app-sidebar")
          .evaluate((node) => node.contains(document.activeElement)),
        true,
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page
          .getByRole("button", { name: "打开导航", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
      await page.getByRole("button", { name: "新建协作", exact: true }).click();
      await assertFits("390 creation");
      await screenshot("create-mobile.png");
      await page.keyboard.press("Escape");
    }
    await screenshot(`workbench-${width}.png`);
    await page.getByRole("button", { name: "实时动态", exact: true }).click();
    await page
      .getByRole("region", { name: "实时动态", exact: true })
      .getByText("正在关注新的协作动态", { exact: true })
      .waitFor();
    await assertFits(`${width} live activity`);
    const liveBounds = await page.locator(".session-activity").boundingBox();
    assert.ok(
      liveBounds.width >= Math.min(width - 40, 300) &&
        liveBounds.x >= 0 &&
        liveBounds.x + liveBounds.width <= width + 1,
    );
    await screenshot(`live-activity-${width}.png`);
    await page
      .getByRole("button", { name: "关闭实时动态", exact: true })
      .click();
  }
  evidence.responsive = [1440, 1280, 768, 390];

  // A failed Host binding must remain visible and repairable, including Host itself.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const blockedSetup = await client.createSessionSetup({
    sessionName: "Host 接入修复验收",
    projectPath: project,
    agents: [
      {
        role: "host",
        name: "待验证主控",
        duty: "核对已有原生会话",
        mode: "managed_proxy",
        binding: {
          installationId: installation.id,
          workspacePath: project,
          runtimeNamespace: namespace,
          nativeSessionId: "missing-ui-host",
        },
      },
    ],
  });
  assert.ok(blockedSetup.warnings.length > 0);
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await dialog("切换协作会话")
    .getByRole("button", { name: "刷新", exact: true })
    .click();
  await dialog("切换协作会话")
    .getByRole("option", { name: blockedSetup.session.name, exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "发送给 Host 的消息", exact: true })
    .fill("验证前不能发送");
  assert.equal(
    await page.getByRole("button", { name: "发送", exact: true }).isEnabled(),
    false,
  );
  await page.getByRole("button", { name: "查看配置", exact: true }).click();
  const hostCard = dialog("成员绑定与接入")
    .locator(".member-route-card")
    .filter({ hasText: "待验证主控" });
  await hostCard.getByRole("button", { name: "接入设置", exact: true }).click();
  await dialog("成员绑定与接入")
    .getByLabel("已有会话编号", { exact: true })
    .fill("repaired-ui-host");
  await dialog("成员绑定与接入")
    .getByLabel("调整说明", { exact: true })
    .fill("修正准确的原生会话编号");
  await writeFile(
    join(namespace, "sessions", "repaired-ui-host.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "repaired-ui-host", cwd: project },
    }) + "\n",
  );
  await dialog("成员绑定与接入")
    .getByRole("button", { name: "保存调整", exact: true })
    .click();
  await hostCard.getByText("repaired-ui-host", { exact: true }).waitFor();
  await hostCard.getByRole("button", { name: "验证会话", exact: true }).click();
  await hostCard.getByText("已就绪", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find(
        (node) => node.textContent.trim() === "发送",
      )?.disabled,
  );
  evidence.blockedHostRepair = true;
  await page.getByRole("button", { name: "新建协作", exact: true }).click();
  const creation = dialog("新建协作");
  const summarySizes = await creation
    .locator(".create-summary p, .create-summary small, .create-summary strong")
    .evaluateAll((nodes) =>
      nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    );
  assert.ok(
    summarySizes.length > 0 && summarySizes.every((size) => size >= 14),
    "Creation summary uses readable type",
  );
  await screenshot("create-desktop.png");
  await page.keyboard.press("Escape");
  evidence.readableCreationSummary = true;

  // Real discovery metadata must be visible beside the scanned/selected tool.
  const scanRoot = join(root, "scan");
  await mkdir(scanRoot);
  await writeFile(
    join(scanRoot, "gemini"),
    "#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('0.68.0');process.exit(0)}throw Error('Must never execute a model task');\n",
  );
  await writeFile(join(scanRoot, "claude.cmd"), "@exit /b 99\n");
  const brokenPackage = join(
    scanRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-code",
  );
  await mkdir(brokenPackage, { recursive: true });
  await writeFile(
    join(brokenPackage, "package.json"),
    JSON.stringify({
      name: "@anthropic-ai/claude-code",
      bin: { claude: "missing.exe" },
    }),
  );
  process.env.PATH = scanRoot + delimiter + process.env.PATH;
  const gemini = await client.createToolInstallation({
    toolId: "gemini",
    displayName: "Gemini CLI",
    executablePath: join(scanRoot, "gemini"),
  });
  const broken = await client.createToolInstallation({
    toolId: "claude",
    displayName: "损坏的 Claude 入口",
    executablePath: join(scanRoot, "claude.cmd"),
  });
  const kimi = await client.createToolInstallation({
    toolId: "kimi",
    displayName: "Kimi Code CLI",
    executablePath: fixture,
  });
  const cursor = await client.createToolInstallation({
    toolId: "cursor",
    displayName: "Cursor CLI",
    executablePath: fixture,
  });
  const mimo = await client.createToolInstallation({
    toolId: "mimo",
    displayName: "MiMo Code",
    executablePath: fixture,
  });
  for (const tool of ["droid", "copilot"])
    await client.createToolInstallation({
      toolId: tool,
      displayName: tool,
      executablePath: fixture,
    });
  await page.goto(baseUrl + "/tools");
  await page
    .getByRole("button", { name: "发现 Worker", exact: true })
    .first()
    .click();
  const scanRows = page.locator(".scan-result-row");
  await scanRows
    .filter({ hasText: join(scanRoot, "claude.cmd") })
    .getByText("不可用", { exact: true })
    .waitFor();
  await scanRows
    .filter({ hasText: join(scanRoot, "claude.cmd") })
    .getByText(/实际程序文件不存在/)
    .waitFor();
  await scanRows
    .filter({ hasText: join(scanRoot, "gemini") })
    .getByText("可用", { exact: true })
    .waitFor();
  assert.ok(
    (
      await page
        .getByRole("region", { name: "发现的 Worker", exact: true })
        .boundingBox()
    ).y < 250,
    "Scan results appear above saved installations",
  );
  await screenshot("compatibility-scan.png");
  await assertFits("Compatibility scan");
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "新建协作", exact: true }).click();
  const toolSelection = dialog("新建协作").getByLabel("主控 Worker", {
    exact: true,
  });
  await dialog("新建协作")
    .getByLabel("主控运行方式", { exact: true })
    .selectOption("managed_proxy");
  await toolSelection.selectOption(kimi.id);
  await dialog("新建协作")
    .getByRole("note", { name: "工具可用情况" })
    .getByText("可用", { exact: true })
    .waitFor();
  assert.equal(
    await toolSelection.locator(`option[value="${broken.id}"]`).isDisabled(),
    true,
  );
  await dialog("新建协作")
    .getByRole("note", { name: "工具可用情况" })
    .scrollIntoViewIfNeeded();
  await screenshot("compatibility-selection.png");
  await toolSelection.selectOption(cursor.id);
  await dialog("新建协作")
    .getByRole("note", { name: "工具可用情况" })
    .getByText("可用", { exact: true })
    .waitFor();
  assert.equal(
    await dialog("新建协作").locator('option[value="existing"]').isDisabled(),
    true,
  );
  await toolSelection.selectOption(mimo.id);
  const readiness = dialog("新建协作").getByRole("note", {
    name: "工具可用情况",
  });
  await readiness.getByText("不可用", { exact: true }).waitFor();
  await readiness.getByText(/先启动该工具的会话服务/).waitFor();
  let healthy = true;
  nativeHealthServer = createServer((request, response) => {
    assert.equal(request.url, "/global/health");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ healthy, version: "0.1.16" }));
  });
  await new Promise((done) => nativeHealthServer.listen(0, "127.0.0.1", done));
  await dialog("新建协作")
    .getByLabel("主控服务地址", { exact: true })
    .fill(`http://127.0.0.1:${nativeHealthServer.address().port}`);
  await readiness.getByText("可用", { exact: true }).waitFor();
  healthy = false;
  await readiness
    .getByRole("button", { name: "重新校验 mimo", exact: true })
    .click();
  await readiness.getByText("不可用", { exact: true }).waitFor();
  healthy = true;
  await readiness
    .getByRole("button", { name: "重新校验 mimo", exact: true })
    .click();
  await readiness.getByText("可用", { exact: true }).waitFor();
  evidence.actualServiceHealthAndRecheck = true;
  await page.keyboard.press("Escape");
  const cursorRoot = join(root, "cursor-config");
  await mkdir(cursorRoot);
  await writeFile(
    join(cursorRoot, "cli-config.json"),
    '{"network":{"useHttp1ForAgent":false}}',
  );
  await client.createToolConfigProfile({
    installationId: cursor.id,
    configRoot: cursorRoot,
    name: "Cursor 配置",
  });
  await page.goto(baseUrl + "/tool-config?installationId=" + cursor.id);
  await page.getByLabel("使用 HTTP/1.1", { exact: true }).selectOption("true");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page
    .getByText("已保存到工具配置，备份已生成", { exact: true })
    .waitFor();
  assert.equal(
    JSON.parse(await readFile(join(cursorRoot, "cli-config.json"), "utf8"))
      .network.useHttp1ForAgent,
    true,
  );
  assert.equal(await page.getByLabel("API 密钥", { exact: true }).count(), 0);
  await screenshot("cursor-config.png");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(baseUrl + "/tools");
    await page
      .locator(".installation-card")
      .filter({ hasText: "Kimi Code CLI" })
      .waitFor();
    await assertFits(`${width} compatibility notices`);
  }
  evidence.compatibilityScanSelectionAndBooleanConfig = true;

  await page.setViewportSize({ width: 1440, height: 900 });
  for (let index = 1; index <= 5; index++)
    await client.createToolInstallation({
      toolId: "codex",
      displayName: `列表密度验收 ${index}`,
      executablePath: fixture,
    });
  await page.goto(baseUrl + "/tools");
  const compactTools = page.locator(".installation-catalog .installation-card");
  await compactTools.filter({ hasText: "列表密度验收 5" }).waitFor();
  const heights = await compactTools.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().height),
  );
  const availableHeights = await compactTools
    .filter({ has: page.locator(".tool-availability.is-available") })
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
  assert.ok(
    heights.length >= 10 &&
      availableHeights.every((height) => height <= 115) &&
      heights.every((height) => height <= 150),
    JSON.stringify(heights),
  );
  assert.ok(
    await compactTools.evaluateAll(
      (nodes) =>
        nodes.filter(
          (node) => node.getBoundingClientRect().bottom < innerHeight,
        ).length >= 6,
    ),
  );
  const kimiNotice = compactTools
    .filter({ hasText: "Kimi Code CLI" })
    .getByRole("note", { name: "工具可用情况" });
  await kimiNotice.getByText("可用", { exact: true }).waitFor();
  assert.equal((await kimiNotice.innerText()).trim(), "可用");
  await compactTools
    .filter({ hasText: "MiMo Code" })
    .getByText("可用", { exact: true })
    .waitFor();
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /版本待验收|模型协作待验收|已验收版本|试用适配/,
  );
  assert.equal(
    await compactTools.locator("details").count(),
    0,
    "Available tools have no compatibility details to expand",
  );
  await page
    .locator(".page-container")
    .evaluate((node) => (node.scrollTop = 0));
  await screenshot("compact-assistant-directory.png");
  evidence.compactAssistantDirectory = {
    count: heights.length,
    maxHeight: Math.max(...heights),
    sixVisible: true,
    readinessOnly: true,
  };

  // A long session list stays bounded; its actions remain available while scrolling.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/?sessionId=${sid}`);
  await page
    .getByRole("heading", { name: setup.session.name, exact: true })
    .waitFor();
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
  assert.equal(await page.locator(".workbench-project").count(), 0);
  const extraSessions = [];
  for (let index = 1; index <= 32; index++)
    extraSessions.push(
      (
        await client.createSession({
          sessionName: `会话列表验收 ${String(index).padStart(2, "0")} · 较长的项目协作名称用于检查列表换行与边界`,
          agentName: `主控${index}`,
          displayName: `主控${index}`,
          platform: "generic",
          capabilities: [],
          connectionMode: "skill-bridge",
        })
      ).session,
    );
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  const switcher = dialog("切换协作会话");
  await switcher.getByRole("button", { name: "刷新", exact: true }).click();
  await switcher
    .getByRole("option", { name: extraSessions.at(-1).name, exact: true })
    .waitFor({ state: "attached" });
  assert.ok(
    await switcher
      .locator(".session-switcher-list")
      .evaluate(
        (node) =>
          node.clientHeight <= 320 && node.scrollHeight > node.clientHeight,
      ),
  );
  const actionBounds = await switcher
    .locator(".session-switcher-actions")
    .boundingBox();
  await switcher.locator(".session-switcher-list").hover();
  await page.mouse.wheel(0, 900);
  await page.waitForFunction(
    () => document.querySelector(".session-switcher-list").scrollTop > 0,
  );
  assert.equal(
    (await switcher.locator(".session-switcher-actions").boundingBox()).y,
    actionBounds.y,
  );
  const popupBounds = await switcher.boundingBox();
  assert.ok(
    popupBounds.y + popupBounds.height < 900,
    "Long session list stays inside the window",
  );
  await screenshot("session-switcher-long-list.png");
  await switcher
    .getByLabel("搜索会话", { exact: true })
    .fill("会话列表验收 32");
  assert.equal(await switcher.getByRole("option").count(), 1);
  await switcher.getByRole("option").click();
  await page
    .getByRole("heading", { name: extraSessions.at(-1).name, exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "切换会话", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await switcher.getByLabel("搜索会话", { exact: true }).fill("不存在的会话");
  await switcher.getByText("没有匹配的会话", { exact: true }).waitFor();
  await switcher.getByLabel("搜索会话", { exact: true }).fill("商品管理台");
  await switcher.getByLabel("搜索会话", { exact: true }).press("ArrowDown");
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { name: setup.session.name, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "切换会话", exact: true }).click();
  await switcher
    .getByRole("button", { name: "打开已有协作", exact: true })
    .click();
  await dialog("打开已有协作").waitFor();
  assert.equal(await switcher.count(), 0);
  await page.keyboard.press("Escape");
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "切换会话", exact: true }).click();
    await page.waitForFunction(
      ({ width, height }) => {
        const bounds = document
          .querySelector(".session-switcher-popover")
          ?.getBoundingClientRect();
        return (
          bounds &&
          bounds.x >= 0 &&
          bounds.right <= width &&
          bounds.bottom <= height
        );
      },
      { width, height: 844 },
    );
    const bounds = await switcher.boundingBox();
    assert.ok(
      bounds.x >= 0 &&
        bounds.x + bounds.width <= width &&
        bounds.y + bounds.height <= 844,
      JSON.stringify({ width, bounds }),
    );
    await screenshot(`session-switcher-${width}.png`);
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .getByRole("button", { name: "切换会话", exact: true })
        .evaluate((node) => node === document.activeElement),
      true,
    );
  }
  evidence.boundedSessionSwitchingAndHeaderCleanup = true;
  evidence.singleMessageDetailEntry = true;
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
  await writeFile(
    join(artifacts, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
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
  if (nativeHealthServer)
    await new Promise((done) => nativeHealthServer.close(done));
  if (browser) await browser.close();
  if (core) await core.close();
  await rm(root, { recursive: true, force: true });
}
