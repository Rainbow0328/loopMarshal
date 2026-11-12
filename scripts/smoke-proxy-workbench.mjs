import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startCoreServer } from "@loopmarshal/core";
import { createLoopMarshalClient } from "@loopmarshal/sdk";

// Use an existing Playwright installation and browser; do not change project dependencies.
const { values } = parseArgs({
  options: {
    playwright: { type: "string" },
    browser: { type: "string" },
    screenshot: { type: "string" },
  },
});
if (!values.playwright || !values.browser)
  throw new Error(
    "Provide --playwright <playwright-core entry> and --browser <browser executable>",
  );
const { chromium } = await import(
  pathToFileURL(resolve(values.playwright)).href
);
const directory = await mkdtemp(join(tmpdir(), "loopmarshal-web-proxy-"));
let core;
let browser;
let page;
try {
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(directory, "knowledge");
  const namespace = join(directory, "tool-data");
  await mkdir(join(namespace, "sessions"), { recursive: true });
  process.env.CODEX_HOME = namespace;
  const executable = join(directory, "fixture.cjs");
  await writeFile(
    executable,
    `if(process.argv.includes('--version')){console.log('ui-fixture-1');process.exit(0)}let text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'native-ui'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'UI_HISTORY_OK'}}));console.log(JSON.stringify({type:'turn.completed'}))});`,
  );
  await writeFile(
    join(namespace, "sessions", "native-ui.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "native-ui", cwd: directory },
    }) + "\n",
  );
  const nativeConfigPath = join(namespace, "config.toml");
  const originalConfig =
    '# Preserve this comment\nmodel = "original-ui-model"\n[unknown]\nkeep = true\n';
  await writeFile(nativeConfigPath, originalConfig);
  core = await startCoreServer({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(directory, "core.sqlite"),
  });
  const baseUrl = `http://127.0.0.1:${core.server.server.address().port}`;
  const { token } = await (await fetch(`${baseUrl}/api/local-auth`)).json();
  const client = createLoopMarshalClient({
    baseUrl,
    headers: { "x-loopmarshal-management-token": token },
  });
  const created = await client.createSession({
    sessionName: "工作台路由验收",
    agentName: "主控",
    displayName: "主控",
    platform: "generic",
    capabilities: [],
    connectionMode: "skill-bridge",
  });
  browser = await chromium.launch({
    executablePath: resolve(values.browser),
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "查看绑定", exact: true }).click();
  const panel = page.locator(".modal-backdrop");
  await panel.getByRole("tab", { name: "添加与调整", exact: true }).click();
  await panel.getByText("添加工具安装位置", { exact: true }).click();
  await panel
    .getByLabel("可执行文件的完整路径", { exact: true })
    .fill(executable);
  const installationsRefreshed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/tool-installations") &&
      response.request().method() === "GET",
  );
  await panel
    .getByRole("button", { name: "保存安装位置", exact: true })
    .click();
  await installationsRefreshed;
  await panel.getByLabel("成员名称", { exact: true }).fill("前端开发");
  await panel
    .getByLabel("成员职责", { exact: true })
    .fill("验证工作台与指定原生历史");
  await panel
    .getByLabel("会话处理方式", { exact: true })
    .selectOption("existing");
  await panel.getByLabel("项目目录", { exact: true }).fill(directory);
  await panel
    .getByLabel("工具配置与会话数据目录", { exact: true })
    .fill(namespace);
  await panel.getByLabel("已有会话编号", { exact: true }).fill("native-ui");
  await panel.getByRole("button", { name: "添加成员", exact: true }).click();
  const frontend = panel
    .locator(".member-route-card")
    .filter({ hasText: "前端开发" });
  await frontend.getByRole("button", { name: "验证会话", exact: true }).click();
  await frontend.getByText("已就绪", { exact: false }).first().waitFor();
  await panel.getByRole("tab", { name: "添加与调整", exact: true }).click();
  await panel.getByLabel(/^接入方式/).selectOption("mcp_await");
  await panel.getByLabel("成员名称", { exact: true }).fill("代码审查");
  await panel.getByLabel("成员职责", { exact: true }).fill("使用原 MCP 等待链");
  await panel.getByRole("button", { name: "添加成员", exact: true }).click();
  await panel
    .locator(".member-route-card")
    .filter({ hasText: "代码审查" })
    .getByText("MCP 等待接入", { exact: true })
    .waitFor();
  await frontend.getByText("连接信息与高级设置", { exact: true }).click();
  await frontend.getByText("发送凭证", { exact: true }).click();
  await frontend.getByLabel("凭证用途", { exact: true }).fill("UI 验收");
  await frontend.getByRole("button", { name: "签发", exact: true }).click();
  await frontend
    .getByText("请保存此凭证，关闭后不再显示：", { exact: false })
    .waitFor();
  await frontend
    .locator("details > div")
    .filter({ hasText: "UI 验收" })
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await frontend.getByText("已撤销", { exact: false }).waitFor();
  assert.equal(
    await frontend
      .locator("code")
      .filter({ hasText: /^lm_member_/ })
      .count(),
    0,
  );
  const member = (await client.listMemberRoutes(created.session.id)).find(
    (value) => value.agent.agentName === "前端开发",
  );
  const sent = await client.sendMessage({
    sessionId: created.session.id,
    fromAgentId: created.agent.id,
    toAgentId: member.agent.id,
    type: "task",
    payload: "Verify UI",
    idempotencyKey: "ui-test",
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (
      (await client.listDeliveries(created.session.id)).some(
        (delivery) =>
          delivery.messageId === sent.id && delivery.state === "completed",
      )
    )
      break;
    await new Promise((done) => setTimeout(done, 100));
  }
  await panel.getByRole("tab", { name: "投递记录", exact: true }).click();
  await panel.getByText("已回报，待 Host 验收", { exact: true }).waitFor();
  await panel.getByText("查看事件与处理", { exact: true }).click();
  await panel.getByText("工具回报", { exact: true }).click();
  await panel.getByText(/UI_HISTORY_OK/).waitFor();
  if (values.screenshot)
    await page.screenshot({ path: resolve(values.screenshot), fullPage: true });
  await page.goto(`${baseUrl}/tools`);
  await page
    .getByRole("heading", { name: "发现 Worker", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "扫描本机", exact: true }).click();
  await page.getByRole("heading", { name: "扫描发现", exact: true }).waitFor();
  const installation = (await client.listToolInstallations())[0];
  await page
    .getByRole("button", {
      name: `编辑 ${installation.displayName} 安装设置`,
      exact: true,
    })
    .click();
  if (values.screenshot)
    await page.screenshot({
      path: resolve(values.screenshot) + ".installation.png",
      fullPage: true,
    });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(
    await page.evaluate(() => ({
      page: document.documentElement.scrollWidth > innerWidth + 1,
      dialog: [...document.querySelectorAll(".dialog-panel:not([inert])")].some(
        (node) => node.scrollWidth > node.clientWidth + 1,
      ),
    })),
    { page: false, dialog: false },
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByLabel("连接名称", { exact: true }).fill("UI 连接设置验收");
  await page.getByRole("button", { name: "保存安装设置", exact: true }).click();
  await page.getByText("安装设置已更新", { exact: true }).waitFor();
  assert.equal(
    (await client.listToolInstallations()).find(
      (item) => item.id === installation.id,
    )?.displayName,
    "UI 连接设置验收",
  );
  await page.getByRole("link", { name: /配置地址、密钥和模型/ }).click();
  await page
    .getByRole("heading", { name: "UI 连接设置验收", exact: true })
    .waitFor();
  assert.ok(
    new URL(page.url()).searchParams.get("installationId") === installation.id,
  );
  await page.goto(`${baseUrl}/tool-config`);
  await page.getByRole("heading", { name: "工具配置", exact: true }).waitFor();
  await page.getByRole("button", { name: "扫描本机工具", exact: true }).click();
  await page
    .getByRole("dialog", { name: "发现本机工具", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(
    await page.evaluate(() => ({
      page: document.documentElement.scrollWidth > innerWidth + 1,
      main:
        document.querySelector(".app-main").scrollWidth >
        document.querySelector(".app-main").clientWidth + 1,
    })),
    { page: false, main: false },
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.waitForFunction(() =>
    Boolean(
      document.querySelector(
        'input[aria-label="默认模型"], input[aria-label="配置名称"]',
      ),
    ),
  );
  if (
    await page
      .getByRole("button", { name: "其他配置目录", exact: true })
      .count()
  )
    await page
      .getByRole("button", { name: "其他配置目录", exact: true })
      .click();
  await page.getByLabel("配置名称", { exact: true }).fill("UI 配置验收");
  await page.getByLabel("工具配置目录", { exact: true }).fill(namespace);
  await page
    .getByRole("button", { name: "继续设置模型与密钥", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "默认模型", exact: true })
    .fill("updated-ui-model");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("region", { name: "待保存的修改", exact: true })
    .waitFor();
  assert.equal(await readFile(nativeConfigPath, "utf8"), originalConfig);
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page
    .getByText("已保存到工具配置，备份已生成", { exact: true })
    .waitFor();
  assert.equal(
    await readFile(nativeConfigPath, "utf8"),
    originalConfig.replace("original-ui-model", "updated-ui-model"),
  );
  await page.getByText(/备份与恢复（1）/).click();
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await page.getByRole("button", { name: "确认恢复", exact: true }).click();
  await page.getByText("工具配置已恢复", { exact: true }).waitFor();
  assert.equal(await readFile(nativeConfigPath, "utf8"), originalConfig);
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="默认模型"]')?.value ===
      "original-ui-model",
  );
  if (values.screenshot)
    await page.screenshot({
      path: resolve(values.screenshot) + ".config.png",
      fullPage: true,
    });
  await page
    .getByRole("textbox", { name: "默认模型", exact: true })
    .fill("must-not-overwrite");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page
    .getByRole("region", { name: "待保存的修改", exact: true })
    .waitFor();
  await writeFile(nativeConfigPath, '# External change\nmodel = "external"\n');
  await page.getByRole("button", { name: "确认写入", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "外部修改" }).waitFor();
  assert.equal(
    await readFile(nativeConfigPath, "utf8"),
    '# External change\nmodel = "external"\n',
  );
  const denied = await fetch(`${baseUrl}/api/tool-config/profiles`);
  assert.equal(denied.status, 403);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      browser: true,
      proxyBinding: true,
      awaitMember: true,
      verification: true,
      credentialIssueAndRevoke: true,
      deliveryReport: true,
      nativeConfigPreview: true,
      nativeConfigSave: true,
      nativeConfigRestore: true,
      externalConfigConflict: true,
      configManagementAuth: true,
      pageErrors: errors.length,
    }),
  );
} catch (error) {
  if (page && values.screenshot) {
    await page.screenshot({ path: resolve(values.screenshot), fullPage: true });
    await writeFile(
      `${resolve(values.screenshot)}.txt`,
      await page.locator("body").innerText(),
    );
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (core) await core.close();
  await rm(directory, { recursive: true, force: true });
}
