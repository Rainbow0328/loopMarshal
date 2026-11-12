import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startCoreServer } from "../runtime.js";
import type {
  ManagedAgentSetup,
  ProxyTargetSnapshot,
} from "@loopmarshal/protocol";
import {
  buildNativeCreateInvocation,
  buildNativeInvocation,
} from "../services/native-session-adapters.js";
import { managedSkillVersion } from "../services/managed-collaboration-skill.js";
import { MemberCredentialService } from "../services/member-credential-service.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loopmarshal-managed-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const previous = [
    process.env.LOOPMARSHAL_KNOWLEDGE_ROOT,
    process.env.LOOPMARSHAL_USER_PREFERENCES_PATH,
  ];
  process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(root, "knowledge");
  process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
    root,
    "preferences.json",
  );
  cleanup.push(() => {
    for (const [index, name] of [
      "LOOPMARSHAL_KNOWLEDGE_ROOT",
      "LOOPMARSHAL_USER_PREFERENCES_PATH",
    ].entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  });
  const project = join(root, "project");
  mkdirSync(project);
  const config = {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "core.sqlite"),
  };
  let core = await startCoreServer(config);
  cleanup.push(() => core.close());
  const base = () =>
    `http://127.0.0.1:${(core.server.server.address() as { port: number }).port}`;
  const managementToken = async () =>
    ((await (await fetch(base() + "/api/local-auth")).json()) as any).token;
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    bearer?: string,
  ) => {
    const response = await fetch(base() + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(bearer
          ? { authorization: `Bearer ${bearer}` }
          : { "x-loopmarshal-management-token": await managementToken() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const setup = async (name = "managed") => {
    const response = await request("/api/sessions/setup", "POST", {
      sessionName: name,
      projectPath: project,
      agents: [
        {
          role: "host",
          name: "Host",
          duty: "Coordinate",
          mode: "core_runtime",
          modelConfigId: "default-model",
        },
        {
          role: "worker",
          name: "Developer",
          duty: "Implement",
          mode: "core_runtime",
          modelConfigId: "default-model",
        },
        {
          role: "knowledge_keeper",
          name: "Keeper",
          duty: "Maintain facts",
          mode: "core_runtime",
          modelConfigId: "default-model",
        },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.data;
  };
  const manifests = async (sessionId: string): Promise<ManagedAgentSetup[]> => {
    const response = await request(`/api/sessions/${sessionId}/console`);
    return response.body.data.console.members.map(
      (member: any) => member.automaticSetup,
    );
  };
  const connection = (setup: ManagedAgentSetup) =>
    JSON.parse(
      readFileSync(join(dirname(setup.bridgePath), "connection.json"), "utf8"),
    );
  return {
    root,
    project,
    request,
    setup,
    manifests,
    connection,
    get core() {
      return core;
    },
    base,
    restart: async () => {
      await core.close();
      core = await startCoreServer(config);
    },
  };
}

function bridge(path: string) {
  const child = spawn(process.execPath, [path, "--mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once("exit", () => done());
        child.kill();
      }),
  );
  const pending = new Map<number, (reply: any) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
  });
  let sequence = 0;
  return (method: string, params = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 6000);
      pending.set(id, (reply) => {
        clearTimeout(timeout);
        pending.delete(id);
        reply.error
          ? reject(new Error(reply.error.message))
          : resolve(reply.result);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
}

describe("automatically managed member collaboration", () => {
  it("prepares independent role Skills and tools with no manual selection or project/global config changes", async () => {
    const f = await fixture();
    writeFileSync(join(f.project, "config.toml"), "USER_CONFIG_UNCHANGED");
    const a = await f.setup();
    const b = await f.setup("second");
    const setups = await f.manifests(a.session.id);
    expect(setups).toHaveLength(3);
    expect(new Set(setups.map((setup) => setup.bridgePath)).size).toBe(3);
    expect(
      (await f.manifests(b.session.id)).every(
        (setup) => !setups.some((old) => old.bridgePath === setup.bridgePath),
      ),
    ).toBe(true);
    for (const setup of setups) {
      expect(setup).toMatchObject({
        status: "ready",
        transport: "in_process",
        skillVersion: managedSkillVersion,
      });
      expect(setup.tools).toContain("session_context");
      expect(readFileSync(setup.skillPath, "utf8")).toContain(a.session.id);
      expect(readFileSync(setup.mcpConfigPath, "utf8")).toContain(
        setup.bridgePath.replaceAll("\\", "\\\\"),
      );
      expect(JSON.stringify(setup)).not.toContain(f.connection(setup).token);
    }
    expect(setups.find((setup) => setup.role === "host")!.tools).toContain(
      "dispatch_task",
    );
    expect(
      setups.find((setup) => setup.role === "worker")!.tools,
    ).not.toContain("knowledge_update");
    expect(
      setups.find((setup) => setup.role === "knowledge_keeper")!.tools,
    ).toContain("knowledge_update");
    expect(readFileSync(join(f.project, "config.toml"), "utf8")).toBe(
      "USER_CONFIG_UNCHANGED",
    );
    expect(existsSync(join(f.project, ".codex"))).toBe(false);
  });

  it("serves a real stdio MCP connection, fresh knowledge and exact member identity", async () => {
    const f = await fixture();
    const created = await f.setup();
    const setups = await f.manifests(created.session.id);
    const keeper = setups.find((setup) => setup.role === "knowledge_keeper")!;
    const mcp = bridge(keeper.bridgePath);
    expect(
      (await mcp("initialize", { protocolVersion: "2024-11-05" })).capabilities
        .tools,
    ).toBeDefined();
    expect(
      (await mcp("tools/list")).tools.map((tool: any) => tool.name),
    ).toEqual(keeper.tools);
    const context = JSON.parse(
      (
        await mcp("tools/call", {
          name: "session_context",
          arguments: { sessionId: "unrelated", agentId: "imposter" },
        })
      ).content[0].text,
    );
    expect(context.success).toBe(true);
    expect(context.result.session.id).toBe(created.session.id);
    expect(context.result.members).toHaveLength(3);
    const result = await mcp("tools/call", {
      name: "knowledge_update",
      arguments: {
        level: "l2",
        slug: "managed",
        title: "Facts",
        content: "LATEST_MANAGED_FACTS",
      },
    });
    expect(result.isError).toBe(false);
    const doc = JSON.parse(
      (
        await mcp("tools/call", {
          name: "knowledge_read",
          arguments: { level: "l2", slug: "managed" },
        })
      ).content[0].text,
    );
    expect(JSON.stringify(doc)).toContain("LATEST_MANAGED_FACTS");
    expect(
      (await mcp("resources/read", { uri: "loopmarshal://member/skill" }))
        .contents[0].text,
    ).toContain(created.session.id);
    const another = await f.setup("knowledge-isolation");
    expect(
      (
        await f.request(
          `/api/knowledge/l2/managed?sessionId=${another.session.id}`,
        )
      ).status,
    ).toBe(404);
  });

  it.each(["stdin", "file"] as const)(
    "preserves multiline knowledge with spaces, Unicode, quotes and Windows paths through command %s",
    async (transport) => {
      const f = await fixture();
      const created = await f.setup();
      const keeper = (await f.manifests(created.session.id)).find(
        (setup) => setup.role === "knowledge_keeper",
      )!;
      const content =
        '# 知识库\nnode --test\n文本有  两个空格与 "引号"\nC:\\Program Files\\工具\\config.json';
      const input = {
        level: "l2",
        slug: "stdin-round-trip",
        title: "Knowledge with spaces",
        content,
      };
      const jsonPath = join(f.root, "参数 with spaces.json");
      writeFileSync(jsonPath, "\uFEFF" + JSON.stringify(input));
      const child = spawn(
        process.execPath,
        [
          keeper.bridgePath,
          "knowledge_update",
          transport === "stdin" ? "--stdin" : `@${jsonPath}`,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      let error = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
      const completed = new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });
      child.stdin.end(
        transport === "stdin" ? JSON.stringify(input) : undefined,
      );
      expect(await completed, error).toBe(0);
      expect(JSON.parse(output).data.success).toBe(true);
      const document = await f.request(
        `/api/knowledge/l2/stdin-round-trip?sessionId=${created.session.id}`,
      );
      expect(document.status).toBe(200);
      expect(document.body.data.document.content).toBe(content);
    },
  );

  it("denies Worker escalation, other identities and management access on the server", async () => {
    const f = await fixture();
    const a = await f.setup();
    const b = await f.setup("other");
    const worker = (await f.manifests(a.session.id)).find(
      (setup) => setup.role === "worker",
    )!;
    const token = f.connection(worker).token;
    const call = (toolName: string, identity = {}) =>
      f.request(
        "/api/mcp/call",
        "POST",
        {
          sessionId: a.session.id,
          agentId: worker.agentId,
          toolName,
          arguments: {},
          ...identity,
        },
        token,
      );
    expect((await call("session_context")).status).toBe(200);
    for (const tool of [
      "query_messages",
      "knowledge_update",
      "dispatch_task",
      "claim_next",
      "ai_collab_await_event",
    ])
      expect((await call(tool)).status).toBe(403);
    expect(
      (
        await call("session_context", {
          sessionId: b.session.id,
          agentId: b.agent.id,
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("session_context", { agentId: a.agent.id })).status,
    ).toBe(403);
    expect(
      (await f.request("/api/models", "GET", undefined, token)).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          `/api/sessions/${a.session.id}/agent-setups/refresh`,
          "POST",
          {},
          token,
        )
      ).status,
    ).toBe(403);
  });

  it("returns client replies through an external Host's scoped MCP bridge", async () => {
    const f = await fixture();
    const attached = (
      await f.request("/api/sessions/attach", "POST", {
        sessionName: "external",
        projectPath: f.project,
        agentName: "IDE Host",
        role: "host",
        roleDescription: "Coordinate",
      })
    ).body.data;
    const worker = (
      await f.request("/api/sessions/attach", "POST", {
        sessionName: "external",
        agentName: "Frontend",
        role: "worker",
        roleDescription: "Implement",
      })
    ).body.data.agent;
    const host = (await f.manifests(attached.session.id)).find(
      (setup) => setup.role === "host",
    )!;
    const mcp = bridge(host.bridgePath);
    expect(
      (await mcp("tools/list")).tools.map((tool: any) => tool.name),
    ).toContain("query_messages");
    await f.request("/api/messages/send", "POST", {
      sessionId: attached.session.id,
      fromAgentId: worker.id,
      toAgentId: attached.agent.id,
      type: "progress",
      payload: "SCOPED_FRONTEND_PROGRESS",
    });
    const query = JSON.parse(
      (
        await mcp("tools/call", {
          name: "query_messages",
          arguments: { memberName: "Frontend" },
        })
      ).content[0].text,
    );
    expect(query.success).toBe(true);
    expect(JSON.stringify(query)).toContain("SCOPED_FRONTEND_PROGRESS");
    const input = (
      await f.request("/api/messages/send", "POST", {
        sessionId: attached.session.id,
        fromAgentId: attached.agent.id,
        toAgentId: attached.agent.id,
        type: "instruction",
        payload: { kind: "web_user_message", content: "Please review" },
      })
    ).body.data;
    const call = async (name: string, args = {}) =>
      JSON.parse(
        (await mcp("tools/call", { name, arguments: args })).content[0].text,
      );
    expect(
      (await call("claim_next", { types: ["instruction"] })).result.id,
    ).toBe(input.id);
    expect(
      (
        await call("resolve_message", {
          messageId: input.id,
          summary: "SCOPED_HOST_REPLY",
        })
      ).success,
    ).toBe(true);
    const history = await call("query_messages", { memberName: "IDE Host" });
    expect(
      history.result.messages.find(
        (message: any) => message.payload?.kind === "host_reply",
      ),
    ).toMatchObject({
      processingStatus: "processed",
      payload: { content: "SCOPED_HOST_REPLY" },
    });
  });

  it("repairs missing files, rotates lost/revoked credentials and reconnects an existing bridge after restart", async () => {
    const f = await fixture();
    const created = await f.setup();
    const host = (await f.manifests(created.session.id)).find(
      (setup) => setup.role === "host",
    )!;
    const original = f.connection(host);
    const mcp = bridge(host.bridgePath);
    const refresh = () =>
      f.request(
        `/api/sessions/${created.session.id}/agent-setups/refresh`,
        "POST",
        {},
      );
    expect((await refresh()).status).toBe(200);
    expect(f.connection(host).token).toBe(original.token);
    rmSync(host.skillPath);
    rmSync(host.mcpConfigPath);
    expect((await refresh()).status).toBe(200);
    expect(existsSync(host.skillPath)).toBe(true);
    expect(existsSync(host.mcpConfigPath)).toBe(true);
    const credentials = new MemberCredentialService(
      f.core.databaseManager.connection,
    );
    credentials.revoke(
      created.session.id,
      host.agentId,
      credentials.authenticate(original.token).id,
    );
    await refresh();
    const rotated = f.connection(host).token;
    expect(rotated).not.toBe(original.token);
    rmSync(join(dirname(host.bridgePath), "connection.json"));
    await refresh();
    expect(() => credentials.authenticate(rotated)).toThrow();
    const repaired = f.connection(host);
    await f.restart();
    expect(f.connection(host).token).toBe(repaired.token);
    expect(f.connection(host).baseUrl).toBe(f.base());
    const result = await mcp("tools/call", { name: "session_context" });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain(created.session.id);
  });

  it("cleans up deleted members and sessions while preserving other members and unrelated files", async () => {
    const f = await fixture();
    const a = await f.setup();
    const b = await f.setup("preserved");
    const setups = await f.manifests(a.session.id);
    const worker = setups.find((setup) => setup.role === "worker")!;
    const token = f.connection(worker).token;
    const unrelated = join(f.root, "agent-setups", "user-notes.txt");
    writeFileSync(unrelated, "KEEP");
    expect(
      (await f.request(`/api/agents/${worker.agentId}/leave`, "POST", {}))
        .status,
    ).toBe(200);
    expect(existsSync(worker.bridgePath)).toBe(false);
    expect(() =>
      new MemberCredentialService(
        f.core.databaseManager.connection,
      ).authenticate(token),
    ).toThrow();
    expect(
      (
        await f.request(`/api/sessions/${a.session.id}`, "DELETE", {
          requesterAgentId: a.agent.id,
        })
      ).status,
    ).toBe(200);
    expect(setups.every((setup) => !existsSync(setup.bridgePath))).toBe(true);
    expect(
      (await f.manifests(b.session.id)).every((setup) =>
        existsSync(setup.bridgePath),
      ),
    ).toBe(true);
    expect(readFileSync(unrelated, "utf8")).toBe("KEEP");
  });

  it("injects native Codex and Claude MCP configuration without changing their saved session or credentials", async () => {
    const f = await fixture();
    const created = await f.setup();
    const setup = (await f.manifests(created.session.id))[0]!;
    for (const toolId of ["codex", "claude"] as const) {
      const snapshot: ProxyTargetSnapshot = {
        installation: {
          id: "native",
          toolId,
          displayName: toolId,
          executablePath: process.execPath,
          executableArgs: [],
          environmentKeys: [],
          version: "fixture",
          createdAt: "",
          updatedAt: "",
        },
        binding: {
          installationId: "native",
          workspacePath: f.project,
          runtimeNamespace: f.root,
          nativeSessionId: "exact-existing-history",
          endpoint: null,
        },
        nativeSessionKey: "key",
      };
      const plan = buildNativeInvocation(snapshot, "TASK", setup);
      expect(plan.args).toContain("exact-existing-history");
      expect(plan.args).not.toContain("--last");
      expect(plan.args.join(" ")).not.toContain(f.connection(setup).token);
      if (toolId === "codex") {
        expect(plan.args).toContain(
          `mcp_servers.${setup.serverName}.required=true`,
        );
        expect(plan.args).toContain("features.multi_agent=false");
        expect(
          buildNativeCreateInvocation(
            snapshot,
            "first task",
            "new-session",
            setup,
          ).args,
        ).toContain("features.multi_agent=false");
      } else {
        expect(plan.args).toContain(setup.mcpConfigPath);
        expect(plan.args).toContain("--plugin-dir");
      }
    }
  });

  it("refuses a dangling directory link in an owned configuration path", async () => {
    const f = await fixture();
    const created = await f.setup();
    const setup = (await f.manifests(created.session.id))[0]!;
    const skills = dirname(dirname(setup.skillPath));
    rmSync(skills, { recursive: true, force: true });
    symlinkSync(join(f.root, "missing-target"), skills, "junction");
    try {
      expect(
        (
          await f.request(
            `/api/sessions/${created.session.id}/agent-setups/refresh`,
            "POST",
            {},
          )
        ).status,
      ).toBe(400);
    } finally {
      rmSync(skills, { force: true });
    }
    expect(existsSync(join(f.root, "missing-target"))).toBe(false);
  });
});
