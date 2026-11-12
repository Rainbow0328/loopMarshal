import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseJsonPrefix } from "jsonc-parser";
import type {
  ManagedAgentSetup,
  NativeSessionCandidate,
  ProxyTargetSnapshot,
  ProxyToolId,
} from "@loopmarshal/protocol";
import type {
  NativeExecutionContext,
  NativeTurnResult,
} from "./native-session-adapters.js";
import {
  ProxyProcessError,
  proxyEnvironment,
  resolveToolExecutable,
  runProxyProcess,
  type ProxyProcessPlan,
} from "./proxy-process.js";

export const extendedNativeTools: readonly ProxyToolId[] = [
  "gemini",
  "kimi",
  "cursor",
  "droid",
  "copilot",
];
const samePath = (a: string, b: string) => {
  try {
    const left = realpathSync(a);
    const right = realpathSync(b);
    return process.platform === "win32"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  } catch {
    return false;
  }
};
const json = (path: string): Record<string, any> | null => {
  try {
    if (statSync(path).size > 2 * 1024 * 1024) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
function files(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const pending = [root];
  let count = 0;
  while (pending.length) {
    for (const entry of readdirSync(pending.shift()!, {
      withFileTypes: true,
    })) {
      if (++count > 20000)
        throw new Error("会话记录过多，请选择更具体的工具数据目录。");
      const path = join(entry.parentPath, entry.name);
      if (
        entry.isDirectory() &&
        !["node_modules", ".git", "cache", "logs"].includes(entry.name)
      )
        pending.push(path);
      else if (entry.isFile() && /\.(jsonl?|db)$/.test(entry.name))
        result.push(path);
    }
  }
  return result;
}

/** Vendor records are read only; no guessed recent-session selection or fallback creation. */
export function discoverExtendedSessions(
  tool: ProxyToolId,
  root: string,
  workspace: string,
): NativeSessionCandidate[] {
  if (!root || tool === "cursor") return [];
  const result = new Map<string, NativeSessionCandidate>();
  if (tool === "kimi") {
    const index = join(root, "session_index.jsonl");
    if (existsSync(index)) {
      if (statSync(index).size > 16 * 1024 * 1024)
        throw new Error("Kimi 会话索引过大，请先在官方工具中整理。");
      for (const line of readFileSync(index, "utf8").split(/\r?\n/)) {
        let record: Record<string, any>;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          typeof record.sessionId !== "string" ||
          typeof record.workDir !== "string" ||
          typeof record.sessionDir !== "string" ||
          !samePath(record.workDir, workspace)
        )
          continue;
        const sessionDirectory = resolve(root, record.sessionDir);
        if (
          !sessionDirectory.startsWith(
            resolve(root, "sessions") +
              (process.platform === "win32" ? "\\" : "/"),
          )
        )
          continue;
        const wire = join(sessionDirectory, "agents", "main", "wire.jsonl");
        if (existsSync(wire) && statSync(wire).size > 0)
          result.set(record.sessionId, {
            id: record.sessionId,
            workspacePath: workspace,
            updatedAt: statSync(wire).mtime.toISOString(),
          });
      }
      return [...result.values()];
    }
    const metadata = json(join(root, "kimi.json"));
    for (const work of Array.isArray(metadata?.work_dirs)
      ? metadata.work_dirs
      : []) {
      if (
        typeof work.path !== "string" ||
        !samePath(work.path, workspace) ||
        (work.kaos && work.kaos !== "local")
      )
        continue;
      const directory = join(
        root,
        "sessions",
        createHash("md5").update(work.path).digest("hex"),
      );
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const context = join(directory, entry.name, "context.jsonl");
        if (existsSync(context) && statSync(context).size > 0)
          result.set(entry.name, {
            id: entry.name,
            workspacePath: workspace,
            updatedAt: statSync(context).mtime.toISOString(),
          });
      }
    }
    return [...result.values()];
  }
  const directory = join(
    root,
    tool === "gemini"
      ? "tmp"
      : tool === "copilot"
        ? "session-state"
        : "sessions",
  );
  const hashes = [workspace, resolve(workspace), realpathSync(workspace)].map(
    (path) => createHash("sha256").update(path).digest("hex"),
  );
  for (const path of files(directory)) {
    if (!/\.jsonl?$/.test(path)) continue;
    // Session headers fit in a bounded read, including large conversation logs.
    const fd = openSync(path, "r");
    let text = "";
    try {
      const buffer = Buffer.alloc(Math.min(statSync(path).size, 256 * 1024));
      text = buffer
        .subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
        .toString("utf8");
    } finally {
      closeSync(fd);
    }
    const records: Record<string, any>[] = [];
    try {
      records.push(JSON.parse(text));
    } catch {
      // Gemini stores a single, potentially large, pretty-printed JSON document.
      // Its identity is in the header; a bounded prefix remains sufficient even
      // when the conversation body no longer fits in memory capture.
      if (tool === "gemini") {
        const header = parseJsonPrefix(text);
        if (header && typeof header === "object" && !Array.isArray(header))
          records.push(header);
      } else
        for (const line of text.split(/\r?\n/).slice(0, 100)) {
          try {
            records.push(JSON.parse(line));
          } catch {}
        }
    }
    for (const record of records) {
      if (
        (tool === "droid" && record.type !== "session_start") ||
        (tool === "copilot" && record.type !== "session.start")
      )
        continue;
      const value = record.data ?? record.payload ?? record;
      const id =
        value.sessionId ??
        value.session_id ??
        (record.type === "session.start" || record.type === "session_start"
          ? value.id
          : undefined) ??
        record.sessionId;
      const cwd =
        value.cwd ?? value.context?.cwd ?? value.directory ?? record.cwd;
      const projectHash = value.projectHash ?? record.projectHash;
      if (
        typeof id !== "string" ||
        !id ||
        !(
          (typeof cwd === "string" && samePath(cwd, workspace)) ||
          (tool === "gemini" && hashes.includes(projectHash))
        )
      )
        continue;
      result.set(id, {
        id,
        workspacePath: workspace,
        updatedAt: statSync(path).mtime.toISOString(),
      });
    }
  }
  return [...result.values()];
}

export function buildExtendedInvocation(
  snapshot: ProxyTargetSnapshot,
  prompt: string,
  createId?: string,
  setup?: ManagedAgentSetup,
): ProxyProcessPlan {
  const { installation, binding } = snapshot;
  const tool = installation.toolId;
  const executable = resolveToolExecutable(
    tool === "droid" ? { ...installation, executableArgs: [] } : installation,
  );
  const env = proxyEnvironment(installation);
  let args: string[];
  let input: string | undefined;
  if (tool === "gemini") {
    if (basename(binding.runtimeNamespace) !== ".gemini")
      throw new Error("Gemini 工具数据目录应为实际 .gemini 目录。");
    env.GEMINI_CLI_HOME = dirname(binding.runtimeNamespace);
    args = [
      "--output-format",
      "stream-json",
      "--skip-trust",
      ...(createId ? [] : ["--resume", binding.nativeSessionId]),
    ];
    input = prompt;
  } else if (tool === "kimi") {
    env.KIMI_CODE_HOME = binding.runtimeNamespace;
    args = [
      "--prompt",
      prompt,
      "--output-format",
      "stream-json",
      ...(createId ? [] : ["--session", binding.nativeSessionId]),
    ];
    if (setup) args.push("--skills-dir", dirname(dirname(setup.skillPath)));
  } else if (tool === "cursor") {
    env.CURSOR_CONFIG_DIR = binding.runtimeNamespace;
    args = [
      "--print",
      "--output-format",
      "stream-json",
      "--trust",
      "--workspace",
      binding.workspacePath,
      ...(createId ? [] : ["--resume", binding.nativeSessionId]),
      prompt,
    ];
  } else if (tool === "droid") {
    if (basename(binding.runtimeNamespace) !== ".factory")
      throw new Error("Droid 工具数据目录应为实际 .factory 目录。");
    env.FACTORY_HOME_OVERRIDE = dirname(binding.runtimeNamespace);
    args = [
      "exec",
      ...installation.executableArgs,
      "--output-format",
      "stream-json",
      ...(createId ? [] : ["--session-id", binding.nativeSessionId]),
    ];
    input = prompt;
  } else if (tool === "copilot") {
    env.COPILOT_HOME = binding.runtimeNamespace;
    env.COPILOT_AUTO_UPDATE = "false";
    args = [
      "--session-id",
      createId ?? binding.nativeSessionId,
      "--output-format",
      "json",
      "--no-ask-user",
      "--prompt",
      prompt,
    ];
    if (setup)
      args.push(
        "--additional-mcp-config",
        `@${setup.mcpConfigPath}`,
        "--allow-tool",
        setup.serverName,
      );
  } else throw new Error("Unsupported native adapter");
  if (input === undefined && Buffer.byteLength(prompt) > 16000)
    throw new Error("此工具暂不支持超长命令输入，请缩短任务；消息没有被截断。");
  return {
    command: executable.command,
    args: [...executable.args, ...args],
    env,
    cwd: binding.workspacePath,
    ...(input === undefined ? {} : { input }),
  };
}

export class ExtendedNativeSessionAdapter {
  constructor(private readonly evidenceDirectory?: string) {}
  private cursorEvidence(snapshot: ProxyTargetSnapshot): string | null {
    if (!this.evidenceDirectory) return null;
    return join(
      this.evidenceDirectory,
      createHash("sha256")
        .update(
          JSON.stringify([
            snapshot.installation.toolId,
            snapshot.binding.runtimeNamespace,
            snapshot.binding.nativeSessionId,
          ]),
        )
        .digest("hex") + ".json",
    );
  }
  public assertSession(snapshot: ProxyTargetSnapshot): void {
    if (snapshot.installation.toolId === "cursor") {
      const proof = this.cursorEvidence(snapshot);
      const saved = proof ? json(proof) : null;
      const history = files(
        join(snapshot.binding.runtimeNamespace, "chats"),
      ).some(
        (path) =>
          basename(path) === "store.db" &&
          path.split(/[\\/]/).includes(snapshot.binding.nativeSessionId) &&
          statSync(path).size > 0,
      );
      if (
        !history ||
        !saved ||
        saved.sessionId !== snapshot.binding.nativeSessionId ||
        !samePath(saved.workspace, snapshot.binding.workspacePath)
      )
        throw new Error(
          "未找到此 Cursor CLI 会话的历史或项目绑定。当前仅支持在本工具中新建的 Cursor 会话，不会自动改建会话。",
        );
      return;
    }
    if (
      !discoverExtendedSessions(
        snapshot.installation.toolId,
        snapshot.binding.runtimeNamespace,
        snapshot.binding.workspacePath,
      ).some((item) => item.id === snapshot.binding.nativeSessionId)
    )
      throw new Error(
        "未找到准确会话 ID 与项目对应的原生历史，已停止发送，不会自动新建或改用其他会话。",
      );
  }
  public async version(
    snapshot: ProxyTargetSnapshot,
    signal: AbortSignal,
  ): Promise<string> {
    const executable = resolveToolExecutable(
      snapshot.installation.toolId === "droid"
        ? { ...snapshot.installation, executableArgs: [] }
        : snapshot.installation,
    );
    let value = "";
    const result = await runProxyProcess(
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
          value += line.slice(0, 256);
        },
      },
    );
    if (result.exitCode !== 0 || !value.trim())
      throw new ProxyProcessError(
        "工具版本检查失败，请检查实际可执行文件。",
        false,
      );
    if (snapshot.installation.toolId === "kimi" && !/^2\./.test(value.trim()))
      throw new ProxyProcessError(
        "此适配器需要新版 Kimi Code CLI 2.x；旧 Python kimi-cli 已停止维护，请升级并使用官方历史迁移功能。",
        false,
      );
    return value.trim();
  }
  public async run(
    snapshot: ProxyTargetSnapshot,
    prompt: string,
    context: NativeExecutionContext,
    creating = false,
  ): Promise<{ nativeSessionId: string; result: NativeTurnResult }> {
    const tool = snapshot.installation.toolId;
    // Kimi/Copilot may create missing IDs. A failed preflight must remain
    // retryable and must not hold an uncertain execution lock.
    if (!creating) {
      try {
        this.assertSession(snapshot);
      } catch (cause) {
        throw new ProxyProcessError(
          cause instanceof Error ? cause.message : "会话历史无法验证。",
          false,
        );
      }
    }
    const requestedId = creating && tool === "copilot" ? randomUUID() : null;
    let id: string | null = requestedId;
    let mismatch = false;
    let completed = false;
    let failed = false;
    let text = "";
    let error = "";
    let cwd: string | null = null;
    let plan: ProxyProcessPlan;
    try {
      plan = buildExtendedInvocation(
        snapshot,
        prompt,
        creating ? (requestedId ?? "create") : undefined,
        context.automaticSetup,
      );
    } catch (cause) {
      throw new ProxyProcessError(
        cause instanceof Error ? cause.message : "无法准备工具命令。",
        false,
      );
    }
    let unstructured = "";
    const process = await runProxyProcess(plan, {
      signal: context.signal,
      timeoutMs: 60 * 60 * 1000,
      onStarted: context.onStarted,
      onLine: (line) => {
        let event: Record<string, any>;
        try {
          event = JSON.parse(line);
        } catch {
          unstructured = (unstructured + line).slice(-8192);
          return;
        }
        const value = event.data ?? event;
        const observed =
          event.session_id ??
          event.sessionId ??
          value.sessionId ??
          value.session_id ??
          (event.role === "meta" ? event.session_id : undefined);
        if (typeof observed === "string") {
          const expected = creating
            ? (requestedId ?? id)
            : snapshot.binding.nativeSessionId;
          if (expected && observed !== expected) mismatch = true;
          id = observed;
        }
        const eventCwd = event.cwd ?? value.cwd ?? value.context?.cwd;
        if (typeof eventCwd === "string") {
          cwd = eventCwd;
          if (!samePath(cwd, snapshot.binding.workspacePath)) mismatch = true;
        }
        if (
          tool === "gemini" &&
          event.type === "message" &&
          event.role === "assistant" &&
          typeof event.content === "string"
        )
          text += event.content;
        if (tool === "kimi" && event.role === "assistant") {
          text =
            typeof event.content === "string"
              ? event.content
              : Array.isArray(event.content)
                ? event.content
                    .filter((part: any) => part.type === "text")
                    .map((part: any) => part.text ?? "")
                    .join("")
                : text;
        }
        if (
          tool === "kimi" &&
          event.type === "session.resume_hint" &&
          typeof observed === "string"
        )
          completed = true;
        if (
          tool === "droid" &&
          event.type === "message" &&
          event.role === "assistant" &&
          typeof event.text === "string"
        )
          text += event.text;
        if (
          tool === "copilot" &&
          event.type === "assistant.message" &&
          typeof value.content === "string"
        )
          text += value.content;
        if (event.type === "assistant" && Array.isArray(event.message?.content))
          text += event.message.content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text ?? "")
            .join("");
        if (["result", "completion"].includes(event.type)) {
          completed = true;
          failed ||=
            event.is_error === true ||
            event.status === "error" ||
            (typeof event.exitCode === "number" && event.exitCode !== 0) ||
            String(event.subtype ?? "").startsWith("error");
          if (typeof event.result === "string") text = event.result;
        }
        if (
          tool === "copilot" &&
          ["session.idle", "session.shutdown"].includes(event.type)
        )
          completed = true;
        if (["error", "session.error"].includes(event.type)) {
          failed = true;
          error =
            typeof value.message === "string"
              ? value.message
              : typeof value.error === "string"
                ? value.error
                : "工具执行失败";
        }
        if (
          ["tool_use", "tool_call", "tool.execution_start"].includes(
            event.type,
          ) ||
          event.tool_calls?.length
        )
          context.onEvent("tool_activity", {
            toolType: event.type ?? "tool_call",
          });
        if (text.length > 1024 * 1024) throw new Error("工具回报过大。");
      },
    });
    if (
      !id &&
      process.exitCode !== 0 &&
      /authentication required|not authenticated|please (?:run .*login|log in|login)|no (?:api key|credentials)|api key (?:is )?(?:required|missing)/i.test(
        process.stderr + unstructured,
      )
    ) {
      // Only a recognized refusal before a session exists is retryable. Do not
      // expose raw vendor diagnostics, which can include credentials or URLs.
      throw new ProxyProcessError(
        "工具尚未登录或缺少认证配置，请先在官方工具中登录，或在工具配置中设置认证后重试。",
        false,
      );
    }
    let outcome: NativeTurnResult["outcome"] =
      mismatch || !id || !completed
        ? "unknown"
        : failed || process.exitCode !== 0
          ? "failed"
          : "reported";
    if (id && outcome !== "unknown") {
      const bound = {
        ...snapshot,
        binding: { ...snapshot.binding, nativeSessionId: id },
      };
      if (creating && tool === "cursor" && cwd && this.evidenceDirectory) {
        mkdirSync(this.evidenceDirectory, { recursive: true });
        writeFileSync(
          this.cursorEvidence(bound)!,
          JSON.stringify({ sessionId: id, workspace: cwd }),
          { mode: 0o600 },
        );
      }
      try {
        this.assertSession(bound);
      } catch (cause) {
        outcome = "unknown";
        error = cause instanceof Error ? cause.message : "原生历史无法验证";
      }
    }
    context.onEvent(outcome === "reported" ? "turn_completed" : "fatal_error", {
      nativeSessionId: id,
      exitCode: process.exitCode,
    });
    return {
      nativeSessionId: id ?? "",
      result: {
        outcome,
        nativeSessionId: id,
        exitCode: process.exitCode,
        text:
          outcome === "reported"
            ? text || "本轮执行完成。"
            : mismatch
              ? "工具返回了不同的会话或项目，结果需要核对。"
              : error ||
                (outcome === "unknown"
                  ? "未收到可验证的会话身份与完成结果，未认定成功。"
                  : "工具执行失败。"),
      },
    };
  }
}
