import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { ProxyTargetSnapshot, ProxyToolId } from "@loopmarshal/protocol";
import { toolAvailability, toolCompatibility } from "@loopmarshal/protocol";
import {
  buildExtendedInvocation,
  ExtendedNativeSessionAdapter,
} from "../services/extended-native-session-adapter.js";
import { NativeCliSessionAdapter } from "../services/native-session-adapters.js";
import { installationCompatibility } from "../services/tool-compatibility-service.js";
import { resolveToolExecutable } from "../services/proxy-process.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const tools = ["gemini", "kimi", "cursor", "droid", "copilot"] as const;
function fixture(tool: ProxyToolId, behavior = "success") {
  const root = mkdtempSync(join(tmpdir(), "loopmarshal-extended-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "项目 A");
  mkdirSync(project);
  const namespace = join(
    root,
    tool === "gemini" ? ".gemini" : tool === "droid" ? ".factory" : "data",
  );
  mkdirSync(namespace);
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value) + "\n");
  };
  if (tool === "gemini")
    write(join(namespace, "tmp", "project", "chats", "history.json"), {
      sessionId: "exact",
      projectHash: createHash("sha256").update(project).digest("hex"),
      messages: [{ text: "x".repeat(300000) }],
    });
  if (tool === "kimi") {
    write(join(namespace, "session_index.jsonl"), {
      sessionId: "exact",
      workDir: project,
      sessionDir: "sessions/exact",
    });
    write(
      join(namespace, "sessions", "exact", "agents", "main", "wire.jsonl"),
      { role: "user", content: "history" },
    );
  }
  if (tool === "droid")
    write(join(namespace, "sessions", "history.jsonl"), {
      type: "session_start",
      id: "exact",
      cwd: project,
    });
  if (tool === "copilot")
    write(join(namespace, "session-state", "exact", "events.jsonl"), {
      type: "session.start",
      data: { sessionId: "exact", context: { cwd: project } },
    });
  const evidence = join(root, "evidence");
  if (tool === "cursor") {
    write(join(namespace, "chats", "workspace", "exact", "store.db"), {
      fixture: "native history",
    });
    write(
      join(
        evidence,
        createHash("sha256")
          .update(JSON.stringify([tool, namespace, "exact"]))
          .digest("hex") + ".json",
      ),
      { sessionId: "exact", workspace: project },
    );
  }
  const script = join(root, "fixture.cjs");
  const invoked = join(root, "invoked");
  writeFileSync(
    script,
    `
    const fs = require('node:fs');
    if(process.argv.includes('--version')) { console.log(${JSON.stringify(behavior === "old-kimi" ? "1.52.0" : "2.5.3")}); process.exit(0); }
    fs.writeFileSync(${JSON.stringify(invoked)}, 'started');
    const tool = ${JSON.stringify(tool)}, behavior = ${JSON.stringify(behavior)};
    if(behavior === 'auth') { console.error('Authentication required. Please run agent login first. token=private-secret'); process.exit(1); }
    const id = behavior === 'mismatch' ? 'other-session' : 'exact';
    const cwd = behavior === 'wrong-project' ? ${JSON.stringify(root)} : ${JSON.stringify(project)};
    const emit = event => console.log(JSON.stringify(event));
    emit({type:'system', session_id:id, cwd});
    if(tool === 'gemini') emit({type:'message', role:'assistant', content:'history answer'});
    else if(tool === 'kimi') emit({role:'assistant', content:'history answer'});
    else if(tool === 'droid') emit({type:'message', role:'assistant', text:'history answer'});
    else if(tool === 'copilot') emit({type:'assistant.message', data:{content:'history answer'}});
    else emit({type:'assistant', message:{content:[{type:'text',text:'history answer'}]}});
    if(behavior !== 'incomplete') {
      if(tool === 'kimi') emit({role:'meta', type:'session.resume_hint', session_id:id});
      else emit({type:'result', session_id:id, status:behavior === 'failure'?'error':'success'});
    }
    process.stdin.resume();
  `,
  );
  const snapshot: ProxyTargetSnapshot = {
    installation: {
      id: "tool",
      toolId: tool,
      displayName: tool,
      executablePath: script,
      executableArgs: [],
      environmentKeys: [],
      version: null,
      createdAt: "",
      updatedAt: "",
    },
    binding: {
      installationId: "tool",
      workspacePath: project,
      runtimeNamespace: namespace,
      nativeSessionId: "exact",
      endpoint: null,
    },
    nativeSessionKey: "test",
  };
  const context = () => ({
    signal: AbortSignal.timeout(10000),
    onStarted() {},
    onEvent() {},
  });
  return {
    root,
    project,
    namespace,
    snapshot,
    invoked,
    context,
    adapter: new ExtendedNativeSessionAdapter(evidence),
  };
}

describe("extended native sessions", () => {
  it.each(tools)(
    "stops %s before any process starts when its exact history is absent",
    async (tool) => {
      const f = fixture(tool);
      f.snapshot.binding.nativeSessionId = "missing";
      await expect(
        f.adapter.run(
          f.snapshot,
          "must not create another session",
          f.context(),
        ),
      ).rejects.toMatchObject({
        started: false,
        message: expect.stringMatching(/历史/),
      });
      expect(existsSync(f.invoked)).toBe(false);
    },
  );
  it.each(tools)(
    "resumes %s only with persisted workspace evidence",
    async (tool) => {
      const f = fixture(tool);
      const { result } = await f.adapter.run(
        f.snapshot,
        "continue",
        f.context(),
      );
      expect(result).toMatchObject({
        outcome: "reported",
        nativeSessionId: "exact",
        text: "history answer",
      });
    },
  );
  it.each(["mismatch", "wrong-project", "incomplete"])(
    "keeps %s vendor output uncertain",
    async (behavior) => {
      const f = fixture("kimi", behavior);
      expect(
        (await f.adapter.run(f.snapshot, "continue", f.context())).result
          .outcome,
      ).toBe("unknown");
    },
  );
  it("does not accept a plain assistant answer as Kimi's terminal result", async () => {
    const f = fixture("kimi", "incomplete");
    expect(
      (await f.adapter.run(f.snapshot, "continue", f.context())).result.outcome,
    ).toBe("unknown");
  });
  it("reports an explicit vendor failure rather than treating it as completion", async () => {
    const f = fixture("gemini", "failure");
    expect(
      (await f.adapter.run(f.snapshot, "continue", f.context())).result.outcome,
    ).toBe("failed");
  });
  it("rejects deprecated Kimi before a task starts", async () => {
    const f = fixture("kimi", "old-kimi");
    await expect(
      new NativeCliSessionAdapter().create(f.snapshot, "task", f.context()),
    ).rejects.toMatchObject({ started: false });
    expect(existsSync(f.invoked)).toBe(false);
  });
  it("shows a safe, actionable auth failure before a Cursor session exists", async () => {
    const f = fixture("cursor", "auth");
    await expect(
      f.adapter.run(f.snapshot, "task", f.context(), true),
    ).rejects.toMatchObject({
      started: false,
      message: expect.stringMatching(/登录/),
    });
    try {
      await f.adapter.run(f.snapshot, "task", f.context(), true);
    } catch (error) {
      expect(String(error)).not.toContain("private-secret");
    }
  });
  it("places Droid exec permissions after its subcommand without overriding them", () => {
    const f = fixture("droid");
    f.snapshot.installation.executableArgs = ["--auto", "low"];
    const plan = buildExtendedInvocation(f.snapshot, "task");
    expect(plan.args.slice(1, 4)).toEqual(["exec", "--auto", "low"]);
    expect(plan.env.FACTORY_HOME_OVERRIDE).toBe(f.root);
  });
  it("flags a broken Claude launcher without running or deleting it", () => {
    const f = fixture("claude");
    const launcher = join(f.root, "claude.cmd");
    writeFileSync(launcher, "must not execute");
    const packageRoot = join(
      f.root,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
    );
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@anthropic-ai/claude-code",
        bin: { claude: "bin/claude.exe" },
      }),
    );
    expect(
      installationCompatibility({
        ...f.snapshot.installation,
        executablePath: launcher,
      }),
    ).toMatchObject({
      status: "unavailable",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_launcher" }),
      ]),
    });
    expect(existsSync(launcher)).toBe(true);
    expect(existsSync(f.invoked)).toBe(false);
  });
  it("resolves Cursor's two aliases to the same bundled program", () => {
    const f = fixture("cursor");
    const install = join(f.root, "cursor-agent");
    const version = join(install, "versions", "2026.11.10-731fb78");
    mkdirSync(version, { recursive: true });
    for (const file of ["node.exe", "index.js"])
      writeFileSync(join(version, file), "fixture");
    writeFileSync(
      join(version, "package.json"),
      JSON.stringify({ name: "@anysphere/agent-cli-runtime" }),
    );
    const resolve = (alias: string) =>
      resolveToolExecutable({
        ...f.snapshot.installation,
        executablePath: join(install, alias),
      });
    expect(resolve("agent.cmd")).toEqual(resolve("cursor-agent.ps1"));
    expect(resolve("agent.cmd")).toEqual({
      command: join(version, "node.exe"),
      args: [join(version, "index.js")],
    });
  });
  it("does not label untested accounts or versions as verified", () => {
    for (const tool of tools)
      expect(toolCompatibility(tool).status).toBe("experimental");
    expect(toolCompatibility("codex", "0.153.4").status).toBe("verified");
    expect(toolCompatibility("codex", "0.153.40").status).toBe("limited");
    expect(toolCompatibility("codex", "0.153.40").label).toBe("版本待验收");
    expect(
      toolCompatibility("mimo", "0.1.16").issues.some(
        (issue) => issue.code === "server_required",
      ),
    ).toBe(true);
    expect(toolCompatibility("mimo").issues[0]?.code).toBe("server_required");
    expect(toolCompatibility("opencode").label).toBe("需启动本地服务");
    expect(toolCompatibility("qwen", "0.27.0").label).toBe("需调整启动参数");
    expect(toolCompatibility("qwen", "0.27.0", ["--bare"]).label).toBe(
      "模型协作待验收",
    );
    expect(toolCompatibility("gemini").label).toBe("模型协作待验收");
  });
  it("separates user readiness from internal acceptance evidence", () => {
    for (const tool of [
      "codex",
      "claude",
      "gemini",
      "kimi",
      "cursor",
      "droid",
      "copilot",
    ] as const) {
      expect(toolAvailability(toolCompatibility(tool))).toEqual({
        status: "available",
      });
    }
    expect(toolAvailability(toolCompatibility("codex", "0.153.40"))).toEqual({
      status: "available",
    });
    const server = toolCompatibility("mimo");
    expect(toolAvailability(server)).toEqual({ status: "available" });
    expect(toolAvailability(server, null, "session")).toMatchObject({
      status: "setup_required",
      action: expect.stringContaining("服务地址"),
    });
    expect(toolAvailability(server, "http://127.0.0.1:4096")).toEqual({
      status: "available",
    });
    expect(toolAvailability(toolCompatibility("qwen", "0.27.0")).status).toBe(
      "setup_required",
    );
    expect(
      toolAvailability(toolCompatibility("qwen", "0.27.0", ["--bare"])),
    ).toEqual({ status: "available" });
    expect(toolAvailability(toolCompatibility("qwen", "0.28.0"))).toEqual({
      status: "available",
    });
    expect(toolAvailability(toolCompatibility("kimi", "1.52.0")).status).toBe(
      "setup_required",
    );
    expect(toolAvailability(toolCompatibility("kimi", "2.5.3"))).toEqual({
      status: "available",
    });
    const broken = {
      ...server,
      status: "unavailable" as const,
      issues: [
        {
          code: "invalid_launcher",
          severity: "error" as const,
          message: "入口不存在",
          action: "修复安装",
        },
        ...server.issues,
      ],
    };
    expect(toolAvailability(broken, "http://127.0.0.1:4096")).toEqual({
      status: "unavailable",
      reason: "入口不存在",
      action: "修复安装",
    });
  });
});
