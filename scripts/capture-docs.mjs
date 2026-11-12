import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

const { values } = parseArgs({
  options: {
    playwright: { type: "string" },
    browser: { type: "string" },
    output: { type: "string", default: "assets/screenshots" },
  },
});
for (const name of ["playwright", "browser"])
  if (!values[name]) throw new Error(`Provide --${name}`);

const { chromium } = await import(
  pathToFileURL(resolve(values.playwright)).href
);
const root = await mkdtemp(join(tmpdir(), "loopmarshal-docs-"));
const output = resolve(values.output);
let core;
let browser;
const screenshots = [];

try {
  const project = join(root, "product-workspace");
  const codexRoot = join(root, "codex");
  const claudeRoot = join(root, "claude");
  await Promise.all([
    mkdir(project),
    mkdir(join(codexRoot, "sessions"), { recursive: true }),
    mkdir(claudeRoot),
    mkdir(output, { recursive: true }),
  ]);
  await writeFile(
    join(project, "README.md"),
    "# 商品管理台\n\n演示项目：React + TypeScript，商品搜索与分类筛选。\n",
  );
  await writeFile(
    join(codexRoot, "config.toml"),
    'model = "project-codex"\nmodel_provider = "project-api"\n\n[model_providers.project-api]\nname = "项目模型服务"\nbase_url = "https://api.example.com/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nenv_key = "OPENAI_API_KEY"\n',
  );
  await writeFile(
    join(claudeRoot, "settings.json"),
    JSON.stringify(
      {
        env: {
          ANTHROPIC_MODEL: "project-claude",
          ANTHROPIC_BASE_URL: "https://api.example.com/anthropic",
        },
      },
      null,
      2,
    ),
  );
  const fixture = join(root, "docs-fixture.cjs");
  // Only this local fixture is executed. Screenshots do not invoke vendor CLIs or models.
  await writeFile(
    fixture,
    `if(process.argv.includes('--version')){console.log('docs-fixture-1');process.exit(0)}process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'docs-host'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已明确本轮范围：完成商品搜索与分类筛选，保留现有接口。我会安排前端实现、核实回报，并把确认后的规则同步到本会话知识库。'}}));console.log(JSON.stringify({type:'turn.completed'}))});`,
  );
  await writeFile(
    join(codexRoot, "sessions", "docs-host.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "docs-host", cwd: project },
    }) + "\n",
  );
  process.env.LOOPMARSHAL_WEB_DIST_PATH = resolve("apps/web/dist");
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
    root,
    "preferences.json",
  );
  process.env.CODEX_HOME = codexRoot;
  process.env.CLAUDE_CONFIG_DIR = claudeRoot;
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
  const codex = await client.createToolInstallation({
    toolId: "codex",
    displayName: "Codex",
    executablePath: fixture,
  });
  const claude = await client.createToolInstallation({
    toolId: "claude",
    displayName: "Claude Code",
    executablePath: fixture,
  });
  await client.createToolConfigProfile({
    installationId: codex.id,
    name: "项目开发配置",
    configRoot: codexRoot,
  });
  await client.createToolConfigProfile({
    installationId: claude.id,
    name: "项目开发配置",
    configRoot: claudeRoot,
  });

  browser = await chromium.launch({
    executablePath: resolve(values.browser),
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const capture = async (name) => {
    await page.locator(".spinner").waitFor({ state: "hidden" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(output, name),
      fullPage: true,
      animations: "disabled",
    });
    screenshots.push(name);
  };

  await page.goto(baseUrl + "/tool-config?installationId=" + codex.id);
  await page.getByLabel("认证方式", { exact: true }).waitFor();
  await capture("quick-start-config.png");

  await page.setViewportSize({ width: 1440, height: 1180 });
  await page.goto(baseUrl);
  await page
    .getByRole("button", { name: "新建协作", exact: true })
    .first()
    .click();
  const create = page.getByRole("dialog", { name: "新建协作", exact: true });
  await create
    .getByLabel("会话名称", { exact: true })
    .fill("商品管理台 · 搜索与筛选");
  await create.getByLabel("项目目录", { exact: true }).fill(project);
  await create.getByLabel("主控名称", { exact: true }).fill("项目主控");
  await create
    .getByLabel("主控运行方式", { exact: true })
    .selectOption("managed_proxy");
  await create
    .getByLabel("主控 Worker", { exact: true })
    .selectOption(codex.id);
  await create.getByRole("textbox", { name: /工具数据目录/ }).fill(codexRoot);
  await create
    .locator('section[aria-label="主控"]')
    .getByRole("note", { name: "工具可用情况", exact: true })
    .getByText("可用", { exact: true })
    .waitFor();
  assert.equal(
    await create.getByLabel("已有会话编号", { exact: true }).count(),
    0,
  );
  await create.locator(".dialog-body").evaluate((node) => {
    node.scrollTop = 0;
  });
  await capture("quick-start-create.png");
  await create
    .getByRole("button", { name: "添加 Worker", exact: true })
    .click();
  const workerCard = create.locator('section[aria-label="执行者"]');
  await workerCard.getByLabel("执行者名称", { exact: true }).fill("前端开发");
  await workerCard
    .getByLabel("执行者运行方式", { exact: true })
    .selectOption("managed_proxy");
  await workerCard
    .getByLabel("执行者 Worker", { exact: true })
    .selectOption(claude.id);
  await workerCard
    .getByRole("textbox", { name: /工具数据目录/ })
    .fill(claudeRoot);
  await workerCard
    .getByLabel("执行者职责", { exact: true })
    .fill(
      "实现搜索与分类筛选，验证空结果、失败重试及键盘操作，并向项目主控回报",
    );
  await workerCard
    .getByRole("note", { name: "工具可用情况", exact: true })
    .getByText("可用", { exact: true })
    .waitFor();
  await create.locator(".dialog-body").evaluate((node) => {
    const card = node.querySelector('section[aria-label="执行者"]');
    node.scrollTop +=
      card.getBoundingClientRect().top - node.getBoundingClientRect().top - 16;
  });
  await capture("quick-start-worker.png");
  await create
    .getByRole("button", { name: "添加知识库维护者", exact: true })
    .click();
  const keeperCard = create.locator('section[aria-label="知识库维护者"]');
  await keeperCard
    .getByLabel("知识库维护者名称", { exact: true })
    .fill("知识库维护");
  await keeperCard
    .getByLabel("知识库维护者运行方式", { exact: true })
    .selectOption("managed_proxy");
  await keeperCard
    .getByLabel("知识库维护者 Worker", { exact: true })
    .selectOption(codex.id);
  await keeperCard
    .getByRole("textbox", { name: /工具数据目录/ })
    .fill(codexRoot);
  assert.equal(
    await create
      .getByRole("button", { name: "创建协作", exact: true })
      .isEnabled(),
    true,
    "The documented Host, Worker, and Keeper form must be complete",
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });

  const setup = await client.createSessionSetup({
    sessionName: "商品管理台 · 搜索与筛选",
    projectPath: project,
    agents: [
      {
        name: "项目主控",
        role: "host",
        duty: "理解需求、编排成员、核实回报并维护项目决策",
        mode: "managed_proxy",
        binding: {
          installationId: codex.id,
          workspacePath: project,
          runtimeNamespace: codexRoot,
          nativeSessionId: "docs-host",
        },
      },
      {
        name: "前端开发",
        role: "worker",
        duty: "实现搜索与分类筛选，验证空结果、失败重试及键盘操作",
        mode: "mcp_await",
      },
      {
        name: "知识库维护",
        role: "knowledge_keeper",
        duty: "核实已确认的项目事实，维护分层知识并回报变更",
        mode: "cli_await",
      },
    ],
  });
  const sid = setup.session.id;
  assert.deepEqual(setup.warnings, [], "The demo Host binding must be usable");
  const host = setup.agent;
  const worker = setup.members.find((member) => member.role === "worker");
  await page.goto(baseUrl);
  await page
    .getByRole("heading", { name: setup.session.name, exact: true })
    .waitFor();
  const composer = page.getByLabel("发送给 Host 的消息", { exact: true });
  await composer.fill(
    "给商品列表增加关键字搜索与分类筛选。保留现有接口，失败时保留列表并提供重试；请安排成员执行，并整理确认后的规则。",
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText(/^已明确本轮范围/).waitFor();
  await capture("quick-start-conversation.png");

  await client.upsertKnowledge({
    sessionId: sid,
    level: "l1",
    slug: "product-goals",
    title: "搜索与筛选的目标与约束",
    content:
      "# 搜索与筛选\n\n让用户更快定位商品，保留现有商品接口。\n\n## 验收标准\n\n- 关键字和分类可以组合筛选。\n- 空结果提供清除筛选入口。\n- 请求失败时保留已有列表，并允许重新加载。\n\n## 已确认的边界\n\n本轮不调整商品数据结构，不引入新的搜索服务。",
  });
  await client.upsertKnowledge({
    sessionId: sid,
    level: "l2",
    slug: "filter-behavior",
    title: "筛选状态与错误恢复",
    content:
      "# 筛选行为\n\n搜索与分类共同决定当前筛选条件。清除筛选回到未筛选列表；请求失败保留当前列表和条件，不显示为无商品。",
  });
  await client.updateSessionInsight({
    sessionId: sid,
    updatedByAgentId: host.id,
    objective: "让用户快速定位商品，并清楚理解筛选结果",
    activePlanSummary: "完成筛选交互，复核错误恢复，再邀请用户验收。",
    acceptanceCriteria: [
      "搜索与分类可以组合",
      "空结果可清除筛选",
      "请求失败可重试",
    ],
    completedItems: ["已确认接口复用与失败保留列表的规则"],
    pendingItems: ["核实前端实现与验证记录"],
    blockers: [],
    reviewStatus: "in_progress",
    readyForReview: false,
  });
  await page.getByRole("button", { name: "实时动态", exact: true }).click();
  const activity = page.getByRole("region", { name: "实时动态", exact: true });
  await activity.getByText("正在关注新的协作动态", { exact: true }).waitFor();
  await client.sendMessage({
    sessionId: sid,
    fromAgentId: host.id,
    toAgentId: worker.id,
    type: "task",
    payload: "实现关键字与分类组合筛选，补齐空结果和接口失败后的重试入口。",
  });
  await client.sendMessage({
    sessionId: sid,
    fromAgentId: worker.id,
    toAgentId: host.id,
    type: "progress",
    payload: "正在复用商品查询接口，检查筛选条件与列表状态的同步。",
  });
  await activity.getByText(/正在复用商品查询接口/).waitFor();
  await capture("quick-start-activity.png");

  await page.goto(baseUrl + "/knowledge");
  await page.getByRole("button", { name: /搜索与筛选的目标与约束/ }).click();
  await page
    .locator("article")
    .getByRole("heading", { name: "搜索与筛选", exact: true })
    .waitFor();
  await capture("quick-start-knowledge.png");
  assert.deepEqual(
    errors,
    [],
    "Documentation screenshots must have no page errors",
  );
  console.log(
    JSON.stringify({
      output,
      screenshots,
      demoData: true,
      realModelCalls: false,
    }),
  );
} finally {
  await browser?.close();
  await core?.close();
  await rm(root, { recursive: true, force: true });
}
