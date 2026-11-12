import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  NativeSessionBinding,
  NativeSessionCandidate,
  NativeSessionDiscoveryResult,
  ProxyTargetSnapshot,
  ProxyToolId,
  ManagedAgentSetup,
} from "@loopmarshal/protocol";
import {
  proxyEnvironment,
  resolveToolExecutable,
  runProxyProcess,
  type ProxyProcessPlan,
} from "./proxy-process.js";
import {
  discoverExtendedSessions,
  extendedNativeTools,
  ExtendedNativeSessionAdapter,
} from "./extended-native-session-adapter.js";

export type NativeTurnResult = {
  outcome: "reported" | "failed" | "blocked" | "unknown";
  text: string;
  nativeSessionId: string | null;
  exitCode: number | null;
};
export type NativeExecutionContext = {
  signal: AbortSignal;
  onEvent: (type: string, payload: unknown) => void;
  onStarted: (pid: number) => void;
  automaticSetup?: ManagedAgentSetup;
};
export interface NativeSessionAdapter {
  verify(
    snapshot: ProxyTargetSnapshot,
    signal: AbortSignal,
  ): Promise<{ version: string; evidence: string }>;
  create?(
    snapshot: ProxyTargetSnapshot,
    prompt: string,
    context: NativeExecutionContext,
  ): Promise<{
    nativeSessionId: string;
    version: string;
    result: NativeTurnResult;
  }>;
  execute(
    snapshot: ProxyTargetSnapshot,
    prompt: string,
    context: NativeExecutionContext,
  ): Promise<NativeTurnResult>;
  abort?(snapshot: ProxyTargetSnapshot): Promise<void>;
}

function nativeErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error;
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? (error as { message: unknown }).message
        : event.type === "error"
          ? event.message
          : null;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 8192)
    : null;
}

function nativeReport(
  text: string,
  failed: boolean,
  error: string | null,
): string {
  if (failed)
    return `${error ? `Native execution failed: ${error}` : "Native turn failed."}${text ? `\n\nPartial output:\n${text}` : ""}`;
  return text || "Native turn completed without final text.";
}

function samePath(a: string, b: string): boolean {
  const left = realpathSync(a);
  const right = realpathSync(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function header(path: string, maxBytes = 2 * 1024 * 1024): string {
  const descriptor = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(Math.min(statSync(path).size, maxBytes));
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function sessionFiles(root: string, id?: string): string[] {
  const pending = [root];
  const matches: string[] = [];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.shift()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 30000)
        throw new Error(
          "Session discovery limit exceeded. Select a more specific data directory.",
        );
      if (
        entry.isDirectory() &&
        !["node_modules", ".git", "cache", "logs"].includes(entry.name)
      )
        pending.push(join(directory, entry.name));
      else if (
        entry.isFile() &&
        (!id || entry.name.includes(id)) &&
        /\.jsonl?$/.test(entry.name)
      )
        matches.push(join(directory, entry.name));
    }
  }
  return matches;
}

function recordsFromSessionFile(
  file: string,
  maxBytes?: number,
): Array<Record<string, unknown>> {
  const text = header(file, maxBytes);
  const records: Array<Record<string, unknown>> = [];
  try {
    records.push(JSON.parse(text) as Record<string, unknown>);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* Ignore incomplete/non-JSON header lines. */
      }
    }
  }
  return records;
}

function nativeRecord(
  toolId: ProxyToolId,
  record: Record<string, unknown>,
): { id: string; cwd?: string; projectHash?: string } | null {
  if (toolId === "codex" && record.type !== "session_meta") return null;
  const value =
    toolId === "codex"
      ? (record.payload as Record<string, unknown> | undefined)
      : record;
  if (!value) return null;
  const id = value.sessionId ?? value.session_id ?? value.id;
  if (typeof id !== "string" || !id.trim()) return null;
  const cwd = value.cwd ?? value.directory ?? value.workingDirectory;
  return {
    id,
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(typeof value.projectHash === "string"
      ? { projectHash: value.projectHash }
      : {}),
  };
}

/** Lists persisted native sessions for a project without selecting a session implicitly. */
export function discoverNativeSessions(
  toolId: ProxyToolId,
  runtimeNamespace: string,
  workspacePath: string,
): NativeSessionDiscoveryResult {
  if (extendedNativeTools.includes(toolId))
    return {
      sessions: discoverExtendedSessions(
        toolId,
        runtimeNamespace,
        workspacePath,
      ),
      truncated: false,
    };
  if (["mimo", "opencode"].includes(toolId) || !runtimeNamespace.trim())
    return { sessions: [], truncated: false };
  const result = new Map<string, NativeSessionCandidate>();
  if (toolId === "zcode") {
    const path = zcodeDatabasePath({
      installationId: "discovery",
      workspacePath,
      runtimeNamespace,
      nativeSessionId: "discovery",
      endpoint: null,
    });
    if (!existsSync(path)) return { sessions: [], truncated: false };
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = database
        .prepare("PRAGMA table_info(session)")
        .all() as Array<{ name: string }>;
      if (
        !["id", "directory"].every((name) =>
          columns.some((column) => column.name === name),
        )
      )
        return { sessions: [], truncated: false };
      const rows = database
        .prepare("SELECT id, directory FROM session")
        .all() as Array<{ id: string; directory: string }>;
      for (const row of rows) {
        try {
          if (samePath(row.directory, workspacePath))
            result.set(row.id, {
              id: row.id,
              workspacePath: row.directory,
              updatedAt: null,
            });
        } catch {
          /* Ignore stale workspace records. */
        }
      }
    } finally {
      database.close();
    }
    return { sessions: [...result.values()], truncated: false };
  }
  const roots =
    toolId === "codex"
      ? [
          join(runtimeNamespace, "sessions"),
          join(runtimeNamespace, "archived_sessions"),
        ]
      : toolId === "claude"
        ? [join(runtimeNamespace, "projects")]
        : [runtimeNamespace];
  const projectHash = createHash("sha256")
    .update(resolve(workspacePath))
    .digest("hex");
  let truncated = false;
  for (const root of roots.filter(existsSync)) {
    const candidates = sessionFiles(root)
      .map((file) => {
        try {
          return { file, modified: statSync(file).mtime.toISOString() };
        } catch {
          return { file, modified: "" };
        }
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    truncated ||= candidates.length > 500;
    for (const { file, modified } of candidates.slice(0, 500)) {
      for (const record of recordsFromSessionFile(file, 64 * 1024)) {
        const identity = nativeRecord(toolId, record);
        if (!identity) continue;
        let matches = false;
        try {
          matches = Boolean(
            identity.cwd &&
              existsSync(identity.cwd) &&
              samePath(identity.cwd, workspacePath),
          );
        } catch {
          matches = false;
        }
        if (toolId === "qwen" && identity.projectHash === projectHash)
          matches = true;
        if (matches && !result.has(identity.id))
          result.set(identity.id, {
            id: identity.id,
            workspacePath,
            updatedAt: modified || null,
          });
      }
    }
  }
  return {
    sessions: [...result.values()].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    ),
    truncated,
  };
}

/** Only accepts persisted identity plus workspace evidence, never filename/most-recent alone. */
function verifySavedSession(
  toolId: ProxyToolId,
  binding: NativeSessionBinding,
): string {
  if (toolId === "zcode") {
    const path = zcodeDatabasePath(binding);
    if (!existsSync(path))
      throw new Error(
        "ZCode session database does not exist in this namespace.",
      );
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const columns = database
        .prepare("PRAGMA table_info(session)")
        .all() as Array<{ name: string }>;
      if (
        !["id", "directory"].every((name) =>
          columns.some((column) => column.name === name),
        )
      ) {
        throw new Error(
          "This ZCode database format has not been verified by the adapter.",
        );
      }
      const row = database
        .prepare("SELECT id, directory FROM session WHERE id = ?")
        .get(binding.nativeSessionId) as
        | { id: string; directory: string }
        | undefined;
      if (!row || !samePath(row.directory, binding.workspacePath))
        throw new Error("ZCode session ID or workspace does not match.");
      return path;
    } finally {
      database.close();
    }
  }
  const roots =
    toolId === "codex"
      ? [
          join(binding.runtimeNamespace, "sessions"),
          join(binding.runtimeNamespace, "archived_sessions"),
        ]
      : toolId === "claude"
        ? [join(binding.runtimeNamespace, "projects")]
        : [binding.runtimeNamespace];
  for (const root of roots.filter(existsSync)) {
    for (const file of sessionFiles(root, binding.nativeSessionId)) {
      const records = recordsFromSessionFile(file);
      let identity = false;
      let workspace = false;
      for (const record of records) {
        if (toolId === "codex" && record.type !== "session_meta") continue;
        const value =
          toolId === "codex"
            ? (record.payload as Record<string, unknown> | undefined)
            : record;
        if (!value) continue;
        const id = value.sessionId ?? value.session_id ?? value.id;
        if (id !== binding.nativeSessionId) continue;
        identity = true;
        const cwd = value.cwd ?? value.directory ?? value.workingDirectory;
        if (
          typeof cwd === "string" &&
          existsSync(cwd) &&
          samePath(cwd, binding.workspacePath)
        )
          workspace = true;
        if (
          toolId === "qwen" &&
          value.projectHash ===
            createHash("sha256")
              .update(resolve(binding.workspacePath))
              .digest("hex")
        )
          workspace = true;
      }
      if (identity && workspace) return file;
    }
  }
  throw new Error(
    "No saved session with the exact ID and matching workspace was verified. The session was not created or replaced.",
  );
}

function zcodeProfile(binding: NativeSessionBinding): {
  home: string;
  storage: string;
  database: string;
} {
  const root =
    basename(binding.runtimeNamespace).toLowerCase() === ".zcode"
      ? binding.runtimeNamespace
      : join(binding.runtimeNamespace, ".zcode");
  if (!existsSync(root))
    throw new Error(
      "Select the actual .zcode directory or its parent profile directory.",
    );
  const storage = join(root, "cli");
  return {
    home: dirname(root),
    storage,
    database: join(storage, "db", "db.sqlite"),
  };
}

function zcodeDatabasePath(binding: NativeSessionBinding): string {
  return zcodeProfile(binding).database;
}

export function buildNativeInvocation(
  snapshot: ProxyTargetSnapshot,
  prompt: string,
  automaticSetup?: ManagedAgentSetup,
): ProxyProcessPlan {
  const { installation, binding } = snapshot;
  const executable = resolveToolExecutable(installation);
  const environment = proxyEnvironment(installation);
  let args: string[];
  let input: string | undefined;
  if (installation.toolId === "codex") {
    environment.CODEX_HOME = binding.runtimeNamespace;
    // LoopMarshal has already had the user select this workspace. Codex otherwise refuses
    // non-Git project folders before it can accept a first message or resume its session.
    args = [
      "exec",
      "resume",
      binding.nativeSessionId,
      "--skip-git-repo-check",
      "--json",
      "-",
    ];
    input = prompt;
    if (automaticSetup) {
      // LoopMarshal members have their own identities and task lifecycle. Native
      // subagent tools cannot address them and must not compete with this MCP.
      args.push("-c", "features.multi_agent=false");
      const prefix = `mcp_servers.${automaticSetup.serverName}`;
      args.push(
        "-c",
        `${prefix}.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `${prefix}.args=${JSON.stringify([automaticSetup.bridgePath, "--mcp"])}`,
        "-c",
        `${prefix}.enabled=true`,
        "-c",
        `${prefix}.required=true`,
      );
    }
  } else if (installation.toolId === "claude") {
    environment.CLAUDE_CONFIG_DIR = binding.runtimeNamespace;
    args = [
      "--print",
      "--resume",
      binding.nativeSessionId,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    input = prompt;
    if (automaticSetup)
      args.push(
        "--mcp-config",
        automaticSetup.mcpConfigPath,
        "--plugin-dir",
        dirname(automaticSetup.mcpConfigPath),
        "--allowedTools",
        automaticSetup.tools
          .map((name) => `mcp__${automaticSetup.serverName}__${name}`)
          .join(","),
      );
  } else if (installation.toolId === "qwen") {
    environment.QWEN_HOME = binding.runtimeNamespace;
    environment.QWEN_RUNTIME_DIR = binding.runtimeNamespace;
    args = [
      "--resume",
      binding.nativeSessionId,
      "--prompt",
      prompt,
      "--output-format",
      "stream-json",
    ];
  } else if (installation.toolId === "zcode") {
    const profile = zcodeProfile(binding);
    environment.HOME = profile.home;
    environment.USERPROFILE = profile.home;
    environment.ZCODE_DATA_BASE_DIR = profile.home;
    environment.ZCODE_STORAGE_DIR = profile.storage;
    environment.ZCODE_SESSION_DB_PATH = profile.database;
    // Official headless default is yolo; default to approval-requiring build instead.
    args = [
      "--resume",
      binding.nativeSessionId,
      "--prompt",
      prompt,
      "--cwd",
      binding.workspacePath,
      "--mode",
      binding.zcodeMode ?? "build",
      "--output-format",
      "stream-json",
    ];
  } else {
    args = [
      "run",
      "--session",
      binding.nativeSessionId,
      "--format",
      "json",
      prompt,
    ];
  }
  if (!input && Buffer.byteLength(prompt) > 16000)
    throw new Error(
      "This tool invocation requires a shorter prompt; the task was not truncated.",
    );
  return {
    command: executable.command,
    args: [...executable.args, ...args],
    cwd: binding.workspacePath,
    env: environment,
    ...(input !== undefined ? { input } : {}),
  };
}

export function buildNativeCreateInvocation(
  snapshot: ProxyTargetSnapshot,
  prompt: string,
  nativeSessionId: string,
  automaticSetup?: ManagedAgentSetup,
): ProxyProcessPlan {
  const { installation, binding } = snapshot;
  const executable = resolveToolExecutable(installation);
  const environment = proxyEnvironment(installation);
  let args: string[];
  let input: string | undefined;
  if (installation.toolId === "codex") {
    environment.CODEX_HOME = binding.runtimeNamespace;
    args = ["exec", "--skip-git-repo-check", "--json", "-"];
    input = prompt;
  } else if (installation.toolId === "claude") {
    environment.CLAUDE_CONFIG_DIR = binding.runtimeNamespace;
    args = [
      "--print",
      "--session-id",
      nativeSessionId,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    input = prompt;
  } else if (installation.toolId === "qwen") {
    environment.QWEN_HOME = binding.runtimeNamespace;
    environment.QWEN_RUNTIME_DIR = binding.runtimeNamespace;
    args = [
      "--session-id",
      nativeSessionId,
      "--prompt",
      prompt,
      "--output-format",
      "stream-json",
    ];
  } else if (installation.toolId === "zcode") {
    const profile = zcodeProfile(binding);
    environment.HOME = profile.home;
    environment.USERPROFILE = profile.home;
    environment.ZCODE_DATA_BASE_DIR = profile.home;
    environment.ZCODE_STORAGE_DIR = profile.storage;
    environment.ZCODE_SESSION_DB_PATH = profile.database;
    args = [
      "--prompt",
      prompt,
      "--cwd",
      binding.workspacePath,
      "--mode",
      binding.zcodeMode ?? "build",
      "--output-format",
      "stream-json",
    ];
  } else {
    throw new Error(
      "This tool creates sessions through its running server endpoint.",
    );
  }
  if (automaticSetup && installation.toolId === "codex") {
    args.push("-c", "features.multi_agent=false");
    const prefix = `mcp_servers.${automaticSetup.serverName}`;
    args.push(
      "-c",
      `${prefix}.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `${prefix}.args=${JSON.stringify([automaticSetup.bridgePath, "--mcp"])}`,
      "-c",
      `${prefix}.enabled=true`,
      "-c",
      `${prefix}.required=true`,
    );
  }
  if (automaticSetup && installation.toolId === "claude")
    args.push(
      "--mcp-config",
      automaticSetup.mcpConfigPath,
      "--plugin-dir",
      dirname(automaticSetup.mcpConfigPath),
      "--allowedTools",
      automaticSetup.tools
        .map((name) => `mcp__${automaticSetup.serverName}__${name}`)
        .join(","),
    );
  if (!input && Buffer.byteLength(prompt) > 16000)
    throw new Error(
      "This tool invocation requires a shorter prompt; the task was not truncated.",
    );
  return {
    command: executable.command,
    args: [...executable.args, ...args],
    cwd: binding.workspacePath,
    env: environment,
    ...(input !== undefined ? { input } : {}),
  };
}

export class NativeCliSessionAdapter implements NativeSessionAdapter {
  private readonly extended: ExtendedNativeSessionAdapter;
  constructor(evidenceDirectory?: string) {
    this.extended = new ExtendedNativeSessionAdapter(evidenceDirectory);
  }
  public async create(
    snapshot: ProxyTargetSnapshot,
    prompt: string,
    context: NativeExecutionContext,
  ): Promise<{
    nativeSessionId: string;
    version: string;
    result: NativeTurnResult;
  }> {
    const toolId = snapshot.installation.toolId;
    if (extendedNativeTools.includes(toolId)) {
      const version = await this.extended.version(snapshot, context.signal);
      const result = await this.extended.run(snapshot, prompt, context, true);
      return { ...result, version };
    }
    if (snapshot.binding.endpoint) {
      if (!["mimo", "opencode"].includes(toolId))
        throw new Error(
          "Only MiMo and OpenCode support server session creation.",
        );
      const created = (await this.serverRequest(
        snapshot,
        "POST",
        "/session",
        {},
        context.signal,
      )) as { id?: string; directory?: string };
      if (!created.id)
        throw new Error("Native server did not return a session ID.");
      const sessionInfo = created.directory
        ? created
        : ((await this.serverRequest(
            {
              ...snapshot,
              binding: { ...snapshot.binding, nativeSessionId: created.id },
            },
            "GET",
            "",
            undefined,
            context.signal,
          )) as { id?: string; directory?: string });
      if (
        sessionInfo.id !== created.id ||
        !sessionInfo.directory ||
        !samePath(sessionInfo.directory, snapshot.binding.workspacePath)
      )
        throw new Error(
          "Native server did not return a session for the selected workspace.",
        );
      const createdSnapshot = {
        ...snapshot,
        binding: { ...snapshot.binding, nativeSessionId: created.id },
      };
      const version = await this.version(snapshot, context.signal);
      const result = await this.executeServer(createdSnapshot, prompt, context);
      return { nativeSessionId: created.id, version, result };
    }
    if (["mimo", "opencode"].includes(toolId))
      throw new Error(
        "This tool requires a running server endpoint to create a session.",
      );
    const requestedId = randomUUID();
    const plan = buildNativeCreateInvocation(
      snapshot,
      prompt,
      requestedId,
      context.automaticSetup,
    );
    let sessionId: string | null =
      toolId === "claude" || toolId === "qwen" ? requestedId : null;
    let structuredEventCount = 0;
    let unparsedLineCount = 0;
    const eventTypes = new Set<string>();
    let text = "";
    let completed = false;
    let failed = false;
    let blocked = false;
    let nativeError: string | null = null;
    const result = await runProxyProcess(plan, {
      signal: context.signal,
      timeoutMs: 60 * 60 * 1000,
      onStarted: context.onStarted,
      onLine: (line) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          unparsedLineCount++;
          return;
        }
        structuredEventCount++;
        nativeError = nativeErrorMessage(event) ?? nativeError;
        if (typeof event.type === "string") eventTypes.add(event.type);
        const id =
          event.thread_id ??
          event.session_id ??
          event.sessionID ??
          event.sessionId;
        if (typeof id === "string") sessionId = id;
        const item = event.item as { type?: string; text?: string } | undefined;
        if (toolId === "codex") {
          if (
            event.type === "item.completed" &&
            item?.type === "agent_message" &&
            item.text
          )
            text += item.text;
          if (event.type === "turn.completed") completed = true;
          if (event.type === "turn.failed") {
            failed = true;
            completed = true;
          }
        } else if (event.type === "result") {
          completed = true;
          failed =
            event.is_error === true ||
            (typeof event.subtype === "string" &&
              event.subtype.startsWith("error"));
          if (typeof event.result === "string") text = event.result;
          if (typeof event.response === "string") text = event.response;
          const projection = event.projection as
            | { status?: string }
            | undefined;
          if (toolId === "zcode") {
            completed = ["idle", "error", "blocked"].includes(
              projection?.status ?? "",
            );
            failed = projection?.status === "error";
            blocked = projection?.status === "blocked";
          }
        }
        const message = event.message as
          | { content?: Array<{ type?: string; text?: string }> }
          | undefined;
        if (event.type === "assistant" && message?.content && !completed)
          for (const part of message.content)
            if (part.type === "text" && part.text) text += part.text;
        if (blocked)
          context.onEvent("input_required", {
            reason: "Native tool requires permission or user input",
          });
        context.onEvent(String(event.type ?? "native_event"), {
          nativeSessionId: sessionId,
          completed,
          failed,
          ...(nativeErrorMessage(event) ? { error: nativeError } : {}),
        });
      },
    });
    if (!sessionId || !completed) {
      const observedTypes = [...eventTypes].slice(0, 12);
      const reason = !sessionId
        ? "Native tool did not return a new session ID"
        : "Native tool did not return a terminal event";
      context.onEvent("native_session_creation_incomplete", {
        exitCode: result.exitCode,
        structuredEventCount,
        unparsedLineCount,
        eventTypes: observedTypes,
        hasStderr: Boolean(result.stderr.trim()),
      });
      const detail = `Exit code: ${result.exitCode ?? "unknown"}; structured events: ${structuredEventCount}${observedTypes.length ? ` (${observedTypes.join(", ")})` : ""}; non-JSON lines: ${unparsedLineCount}; diagnostic output: ${result.stderr.trim() ? "available in the local tool process log" : "none"}.`;
      return {
        nativeSessionId: sessionId ?? "",
        version: await this.version(snapshot, context.signal),
        result: {
          outcome: "unknown",
          text: `${reason}. ${detail}`,
          nativeSessionId: sessionId,
          exitCode: result.exitCode,
        },
      };
    }
    const createdSnapshot = {
      ...snapshot,
      binding: { ...snapshot.binding, nativeSessionId: sessionId },
    };
    const evidence = await this.verify(createdSnapshot, context.signal);
    const version = evidence.version;
    const turn: NativeTurnResult = {
      outcome:
        failed || result.exitCode !== 0
          ? "failed"
          : blocked
            ? "blocked"
            : "reported",
      text: nativeReport(text, failed || result.exitCode !== 0, nativeError),
      nativeSessionId: sessionId,
      exitCode: result.exitCode,
    };
    context.onEvent(
      turn.outcome === "reported" ? "turn_completed" : "fatal_error",
      { nativeSessionId: sessionId, exitCode: result.exitCode },
    );
    return { nativeSessionId: sessionId, version, result: turn };
  }

  private async version(
    snapshot: ProxyTargetSnapshot,
    signal: AbortSignal,
  ): Promise<string> {
    const executable = resolveToolExecutable(snapshot.installation);
    let version = "";
    const probe = await runProxyProcess(
      {
        command: executable.command,
        args: [...executable.args, "--version"],
        cwd: snapshot.binding.workspacePath,
        env: proxyEnvironment(),
      },
      {
        signal,
        timeoutMs: 15000,
        onLine: (line) => {
          version += line.slice(0, 256);
        },
      },
    );
    if (probe.exitCode !== 0 || !version.trim())
      throw new Error("Tool version probe failed.");
    return version.trim();
  }

  public async verify(
    snapshot: ProxyTargetSnapshot,
    signal: AbortSignal,
  ): Promise<{ version: string; evidence: string }> {
    if (extendedNativeTools.includes(snapshot.installation.toolId)) {
      this.extended.assertSession(snapshot);
      return {
        version: await this.extended.version(snapshot, signal),
        evidence: "准确原生会话与项目历史已校验",
      };
    }
    const executable = resolveToolExecutable(snapshot.installation);
    let version = "";
    const probe = await runProxyProcess(
      {
        command: executable.command,
        args: [...executable.args, "--version"],
        cwd: snapshot.binding.workspacePath,
        env: proxyEnvironment(),
      },
      {
        signal,
        timeoutMs: 15000,
        onLine: (line) => {
          version += line.slice(0, 256);
        },
      },
    );
    if (probe.exitCode !== 0 || !version.trim())
      throw new Error("Tool version probe failed.");
    if (snapshot.binding.endpoint) {
      if (!["mimo", "opencode"].includes(snapshot.installation.toolId))
        throw new Error("This adapter does not support a server endpoint.");
      const session = (await this.sessionRequest(
        snapshot,
        "GET",
        "",
        undefined,
        signal,
      )) as { id?: string; directory?: string };
      if (
        session.id !== snapshot.binding.nativeSessionId ||
        !session.directory ||
        !samePath(session.directory, snapshot.binding.workspacePath)
      ) {
        throw new Error(
          "Server session ID or workspace does not match the binding.",
        );
      }
      const statuses = (await this.serverRequest(
        snapshot,
        "GET",
        "/session/status",
        undefined,
        signal,
      )) as Record<string, { type?: string }>;
      const status = statuses[snapshot.binding.nativeSessionId];
      if (status && status.type !== "idle")
        throw new Error(
          "Native server session is busy. Wait for its current writer to stop before verifying again.",
        );
      return {
        version: version.trim(),
        evidence: "Exact server session ID and workspace verified",
      };
    }
    if (["mimo", "opencode"].includes(snapshot.installation.toolId)) {
      throw new Error(
        "This tool requires an explicit running server endpoint for reliable session verification.",
      );
    }
    const evidence = verifySavedSession(
      snapshot.installation.toolId,
      snapshot.binding,
    );
    return {
      version: version.trim(),
      evidence: `Saved session verified: ${evidence}`,
    };
  }

  public async execute(
    snapshot: ProxyTargetSnapshot,
    prompt: string,
    context: NativeExecutionContext,
  ): Promise<NativeTurnResult> {
    if (extendedNativeTools.includes(snapshot.installation.toolId))
      return (await this.extended.run(snapshot, prompt, context)).result;
    if (snapshot.binding.endpoint)
      return this.executeServer(snapshot, prompt, context);
    const plan = buildNativeInvocation(
      snapshot,
      prompt,
      context.automaticSetup,
    );
    let confirmedId: string | null = null;
    let mismatch = false;
    let completed = false;
    let failed = false;
    let blocked = false;
    let text = "";
    let nativeError: string | null = null;
    const toolId = snapshot.installation.toolId;
    const result = await runProxyProcess(plan, {
      signal: context.signal,
      timeoutMs: 60 * 60 * 1000,
      onStarted: context.onStarted,
      onLine: (line) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        nativeError = nativeErrorMessage(event) ?? nativeError;
        const id =
          event.thread_id ??
          event.session_id ??
          event.sessionID ??
          event.sessionId;
        if (typeof id === "string") {
          if (id !== snapshot.binding.nativeSessionId) mismatch = true;
          else {
            if (!confirmedId)
              context.onEvent("session_confirmed", { nativeSessionId: id });
            confirmedId = id;
          }
        }
        const item = event.item as
          | { type?: string; text?: string; server?: string; tool?: string }
          | undefined;
        if (toolId === "codex") {
          if (
            event.type === "item.completed" &&
            item?.type === "agent_message" &&
            item.text
          )
            text += item.text;
          if (event.type === "turn.completed") completed = true;
          if (event.type === "turn.failed") {
            failed = true;
            completed = true;
          }
        } else {
          if (event.type === "result") {
            completed = true;
            failed =
              event.is_error === true ||
              (typeof event.subtype === "string" &&
                event.subtype.startsWith("error"));
            if (typeof event.result === "string") text = event.result;
            if (toolId === "zcode") {
              if (typeof event.response === "string") text = event.response;
              const projection = event.projection as
                | { status?: string }
                | undefined;
              completed =
                projection?.status === "idle" ||
                projection?.status === "error" ||
                projection?.status === "blocked";
              failed = projection?.status === "error";
              blocked = projection?.status === "blocked";
            }
            blocked ||=
              Array.isArray(event.permission_denials) &&
              event.permission_denials.length > 0;
          }
          const message = event.message as
            | { content?: Array<{ type?: string; text?: string }> }
            | undefined;
          if (event.type === "assistant" && message?.content && !completed) {
            for (const part of message.content)
              if (part.type === "text" && part.text) text += part.text;
          }
        }
        if (text.length > 1024 * 1024)
          throw new Error("Final report is too large.");
        if (
          event.type === "item.started" &&
          item?.type &&
          !["reasoning", "agent_message"].includes(item.type)
        ) {
          const managed =
            item.type === "mcp_tool_call" &&
            item.server === context.automaticSetup?.serverName &&
            context.automaticSetup?.tools.includes(item.tool ?? "");
          context.onEvent("tool_activity", {
            toolType: item.type,
            ...(managed ? { server: item.server, name: item.tool } : {}),
          });
        }
        if (event.type === "assistant") {
          const content = (
            event.message as
              | { content?: Array<{ type?: string; name?: string }> }
              | undefined
          )?.content;
          for (const part of content ?? [])
            if (part.type === "tool_use")
              context.onEvent("tool_activity", { name: part.name ?? "tool" });
        }
        if (blocked)
          context.onEvent("input_required", {
            reason: "Native tool requires permission or user input",
          });
        if (
          [
            "thread.started",
            "system",
            "turn.completed",
            "turn.failed",
            "result",
          ].includes(String(event.type))
        ) {
          context.onEvent(String(event.type), {
            nativeSessionId: typeof id === "string" ? id : null,
            completed,
            failed,
            blocked,
            ...(nativeErrorMessage(event) ? { error: nativeError } : {}),
          });
        }
      },
    });
    if (mismatch || !confirmedId || !completed)
      return {
        outcome: "unknown",
        text: mismatch
          ? "Tool returned a different native session ID."
          : "No verified native session and terminal event were received.",
        nativeSessionId: confirmedId,
        exitCode: result.exitCode,
      };
    context.onEvent(
      failed || result.exitCode !== 0
        ? "fatal_error"
        : blocked
          ? "input_required"
          : "turn_completed",
      { nativeSessionId: confirmedId, exitCode: result.exitCode },
    );
    return {
      outcome:
        failed || result.exitCode !== 0
          ? "failed"
          : blocked
            ? "blocked"
            : "reported",
      text: nativeReport(text, failed || result.exitCode !== 0, nativeError),
      nativeSessionId: confirmedId,
      exitCode: result.exitCode,
    };
  }

  public async abort(snapshot: ProxyTargetSnapshot): Promise<void> {
    if (snapshot.binding.endpoint)
      await this.sessionRequest(
        snapshot,
        "POST",
        "/abort",
        {},
        AbortSignal.timeout(10000),
      );
  }

  private async executeServer(
    snapshot: ProxyTargetSnapshot,
    prompt: string,
    context: NativeExecutionContext,
  ): Promise<NativeTurnResult> {
    const response = (await this.sessionRequest(
      snapshot,
      "POST",
      "/message",
      { parts: [{ type: "text", text: prompt }] },
      context.signal,
    )) as {
      info?: {
        sessionID?: string;
        role?: string;
        error?: unknown;
        time?: { completed?: number };
      };
      parts?: Array<{ type?: string; text?: string }>;
    };
    const id = response.info?.sessionID ?? null;
    const terminal =
      response.info?.role === "assistant" &&
      Boolean(response.info.time?.completed);
    context.onEvent("server_result", {
      nativeSessionId: id,
      terminal,
      failed: Boolean(response.info?.error),
    });
    if (id !== snapshot.binding.nativeSessionId || !terminal)
      return {
        outcome: "unknown",
        text: "Server response identity or completion evidence is missing.",
        nativeSessionId: id,
        exitCode: null,
      };
    context.onEvent("session_confirmed", { nativeSessionId: id });
    context.onEvent(response.info?.error ? "fatal_error" : "turn_completed", {
      nativeSessionId: id,
    });
    return {
      outcome: response.info?.error ? "failed" : "reported",
      nativeSessionId: id,
      exitCode: null,
      text:
        response.parts
          ?.filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n") || "Native turn completed.",
    };
  }

  private async sessionRequest(
    snapshot: ProxyTargetSnapshot,
    method: string,
    suffix: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.serverRequest(
      snapshot,
      method,
      `/session/${encodeURIComponent(snapshot.binding.nativeSessionId)}${suffix}`,
      body,
      signal,
    );
  }

  private async serverRequest(
    snapshot: ProxyTargetSnapshot,
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(`${snapshot.binding.endpoint}${path}`);
    url.searchParams.set("directory", snapshot.binding.workspacePath);
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(
          snapshot.binding.workspacePath,
        ),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(60 * 60 * 1000)]),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`Native server returned HTTP ${response.status}.`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Native server returned an empty response.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024)
          throw new Error("Native server response exceeded the capture limit.");
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
