import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProxyTargetSnapshot, ProxyToolId } from "@loopmarshal/protocol";
import {
  buildNativeCreateInvocation,
  buildNativeInvocation,
  discoverNativeSessions,
  NativeCliSessionAdapter,
} from "../services/native-session-adapters.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const operation of cleanup.splice(0).reverse()) operation();
});

function fixture(toolId: ProxyToolId = "codex", behavior = "success") {
  const directory = mkdtempSync(join(tmpdir(), "loopmarshal-native-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, "fake-cli.cjs");
  writeFileSync(
    script,
    `
    const behavior = ${JSON.stringify(behavior)};
    const tool = ${JSON.stringify(toolId)};
    if (process.argv.includes('--version')) { console.log('fixture-tool 1.0'); process.exit(0); }
    let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', text => input += text);
    process.stdin.on('end', () => {
      const id = behavior === 'mismatch' ? 'wrong-session' : 'native-123';
      if (behavior === 'incomplete') { console.log(JSON.stringify({type:'log', text:'done'})); return; }
      if (tool === 'codex') {
        console.log(JSON.stringify({type:'thread.started', thread_id:id}));
        console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:input}}));
        if (behavior === 'upstream-failure') {
          console.log(JSON.stringify({type:'turn.failed',error:{message:'Upstream request failed',codex_error_info:'other'}}));
          process.exitCode = 1; return;
        }
        console.log(JSON.stringify({type:'turn.completed'}));
      } else if (tool === 'zcode') {
        console.log(JSON.stringify({type:'result',sessionId:id,response:'zcode result',projection:{status:'idle'}}));
      } else {
        console.log(JSON.stringify({type:'system',session_id:id}));
        console.log(JSON.stringify({type:'result',session_id:id,result:'native result',is_error:false}));
      }
    });
  `,
  );
  const timestamp = new Date().toISOString();
  const snapshot: ProxyTargetSnapshot = {
    installation: {
      id: "installation",
      toolId,
      displayName: toolId,
      executablePath: process.execPath,
      executableArgs: [script],
      environmentKeys: [],
      version: "1.0",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    binding: {
      installationId: "installation",
      workspacePath: directory,
      runtimeNamespace: directory,
      nativeSessionId: "native-123",
      endpoint: null,
    },
    nativeSessionKey: "resource",
  };
  const archiveDirectory = join(
    directory,
    toolId === "codex" ? "sessions" : "projects",
  );
  mkdirSync(archiveDirectory);
  const record =
    toolId === "codex"
      ? { type: "session_meta", payload: { id: "native-123", cwd: directory } }
      : { sessionId: "native-123", cwd: directory };
  writeFileSync(
    join(archiveDirectory, "native-123.jsonl"),
    JSON.stringify(record) + "\n",
  );
  if (toolId === "zcode") {
    mkdirSync(join(directory, ".zcode", "cli", "db"), { recursive: true });
    const database = new DatabaseSync(
      join(directory, ".zcode", "cli", "db", "db.sqlite"),
    );
    database.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
    database
      .prepare("INSERT INTO session VALUES (?, ?)")
      .run("native-123", directory);
    database.close();
  }
  return { directory, snapshot, adapter: new NativeCliSessionAdapter() };
}

describe("native session adapters", () => {
  it.each(["codex", "claude", "qwen", "zcode"] as const)(
    "discovers only %s sessions saved for the selected workspace",
    (toolId) => {
      const f = fixture(toolId);
      const result = discoverNativeSessions(toolId, f.directory, f.directory);
      expect(result).toMatchObject({
        truncated: false,
        sessions: [{ id: "native-123", workspacePath: f.directory }],
      });
      expect(result.sessions).toHaveLength(1);
    },
  );

  it.each(["codex", "claude", "qwen", "zcode"] as const)(
    "verifies %s saved identity and reads a native result",
    async (toolId) => {
      const f = fixture(toolId);
      expect(
        await f.adapter.verify(f.snapshot, AbortSignal.timeout(5000)),
      ).toMatchObject({ version: "fixture-tool 1.0" });
      const result = await f.adapter.execute(
        f.snapshot,
        "literal `backticks` $(input) 中文",
        {
          signal: AbortSignal.timeout(5000),
          onStarted: () => {},
          onEvent: () => {},
        },
      );
      expect(result).toMatchObject({
        outcome: "reported",
        nativeSessionId: "native-123",
        exitCode: 0,
      });
      if (toolId === "codex") expect(result.text).toContain("$(input)");
    },
  );

  it("rejects missing or mismatched persisted sessions instead of selecting another history", async () => {
    const f = fixture();
    f.snapshot.binding.nativeSessionId = "different-id";
    await expect(
      f.adapter.verify(f.snapshot, AbortSignal.timeout(5000)),
    ).rejects.toThrow(/exact ID/);
  });

  it.each(["mismatch", "incomplete"])(
    "keeps %s output uncertain even with exit code zero",
    async (behavior) => {
      const f = fixture("codex", behavior);
      const result = await f.adapter.execute(f.snapshot, "task", {
        signal: AbortSignal.timeout(5000),
        onStarted: () => {},
        onEvent: () => {},
      });
      expect(result.outcome).toBe("unknown");
    },
  );

  it.each(["create", "execute"] as const)(
    "preserves the model failure reason during %s instead of reporting commentary as the error",
    async (operation) => {
      const f = fixture("codex", "upstream-failure");
      const events: Array<{ type: string; payload: unknown }> = [];
      const context = {
        signal: AbortSignal.timeout(5000),
        onStarted: () => {},
        onEvent: (type: string, payload: unknown) => {
          events.push({ type, payload });
        },
      };
      const response = await f.adapter[operation](
        f.snapshot,
        "I will check the project.",
        context,
      );
      const result = "result" in response ? response.result : response;
      expect(result).toMatchObject({
        outcome: "failed",
        nativeSessionId: "native-123",
        exitCode: 1,
      });
      expect(result.text).toMatch(
        /^Native execution failed: Upstream request failed/,
      );
      expect(result.text).toContain(
        "Partial output:\nI will check the project.",
      );
      expect(events).toContainEqual({
        type: "turn.failed",
        payload: expect.objectContaining({ error: "Upstream request failed" }),
      });
    },
  );

  it.each(["mimo", "opencode"] as const)(
    "uses the exact %s server session for verification and message delivery",
    async (toolId) => {
      const f = fixture(toolId);
      const requests: string[] = [];
      const { createServer } = await import("node:http");
      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.setHeader("Content-Type", "application/json");
        if (request.url?.startsWith("/session/status")) response.end("{}");
        else if (request.method === "GET")
          response.end(
            JSON.stringify({ id: "native-123", directory: f.directory }),
          );
        else {
          request.resume();
          request.on("end", () =>
            response.end(
              JSON.stringify({
                info: {
                  role: "assistant",
                  sessionID: "native-123",
                  time: { completed: Date.now() },
                },
                parts: [{ type: "text", text: "server result" }],
              }),
            ),
          );
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No port");
        f.snapshot.binding.endpoint = `http://127.0.0.1:${address.port}`;
        await f.adapter.verify(f.snapshot, AbortSignal.timeout(5000));
        const result = await f.adapter.execute(f.snapshot, "task", {
          signal: AbortSignal.timeout(5000),
          onStarted: () => {},
          onEvent: () => {},
        });
        expect(result).toMatchObject({
          outcome: "reported",
          nativeSessionId: "native-123",
          text: "server result",
        });
        expect(requests[0]).toContain("GET /session/native-123?");
        expect(requests[1]).toContain("GET /session/status?");
        expect(requests[2]).toContain("POST /session/native-123/message?");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("never emits last/fork flags or inherits unrelated model credentials", () => {
    const f = fixture();
    const key = "LOOPMARSHAL_TEST_SECRET";
    process.env[key] = "secret";
    try {
      const invocation = buildNativeInvocation(f.snapshot, "task");
      expect(invocation.args).toContain("native-123");
      expect(invocation.args).toContain("--skip-git-repo-check");
      expect(invocation.args).not.toContain("--last");
      expect(invocation.args).not.toContain("--fork");
      expect(invocation.env[key]).toBeUndefined();
      expect(invocation.env.CODEX_HOME).toBe(f.directory);
    } finally {
      delete process.env[key];
    }
  });

  it("starts a new Codex conversation in the user-selected non-Git project", () => {
    const f = fixture();
    const invocation = buildNativeCreateInvocation(
      f.snapshot,
      "first task",
      "unused-new-session-id",
    );
    expect(invocation.args).toContain("exec");
    expect(invocation.args).toContain("--skip-git-repo-check");
    expect(invocation.args).toContain("--json");
    expect(invocation.input).toContain("first task");
    expect(invocation.cwd).toBe(f.directory);
  });

  it("refuses a server session that already has an active writer", async () => {
    const f = fixture("opencode");
    const { createServer } = await import("node:http");
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.startsWith("/session/status")
            ? { "native-123": { type: "busy" } }
            : { id: "native-123", directory: f.directory },
        ),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing port");
      f.snapshot.binding.endpoint = `http://127.0.0.1:${address.port}`;
      await expect(
        f.adapter.verify(f.snapshot, AbortSignal.timeout(5000)),
      ).rejects.toThrow(/busy/);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
