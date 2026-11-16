import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DiscussionMember, ToolInstallation } from "@loopmarshal/protocol";
import {
  proxyEnvironment,
  resolveToolExecutable,
  runProxyProcess,
} from "./proxy-process.js";
import {
  parseNativeConfig,
  updateNativeConfig,
} from "./native-config-adapters.js";

function readConfig(path: string): string | null {
  if (!existsSync(path)) return null;
  if (
    lstatSync(path).isSymbolicLink() ||
    !statSync(path).isFile() ||
    statSync(path).size > 1024 * 1024
  )
    throw new Error("工具配置不可安全读取，请检查源配置文件。");
  return readFileSync(path, "utf8");
}
/** Discussion CLI sessions have their own profile, empty workspace and no execution tools. */
export class DiscussionCliService {
  constructor(
    private readonly root: string,
    private readonly runner = runProxyProcess,
  ) {}
  async reply(
    roomId: string,
    member: DiscussionMember,
    installation: ToolInstallation,
    prompt: string,
    signal: AbortSignal,
    saveIdentity: (id: string) => void,
  ): Promise<string> {
    if (!["codex", "claude"].includes(installation.toolId))
      throw new Error("此工具尚未适配讨论模式。");
    if (installation.executableArgs.length)
      throw new Error(
        "讨论模式不接受自定义启动参数，请添加不含额外参数的工具入口。",
      );
    if (member.blocked)
      throw new Error(
        "此成员上轮会话状态不明确，请新建讨论室后使用。不会自动切换到其他原生会话。",
      );
    const directory = join(
      installation.managedPaths?.configRoot
        ? join(installation.managedPaths.configRoot, "loopmarshal-discussions")
        : this.root,
      roomId,
      member.id,
    );
    const home = join(directory, "profile");
    const workspace = join(directory, "workspace");
    for (const path of [home, workspace]) {
      let current = resolve(path);
      while (true) {
        if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
          throw new Error("讨论目录存在链接，不能安全使用。");
        if (dirname(current) === current) break;
        current = dirname(current);
      }
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const env = proxyEnvironment(installation);
    const executable = resolveToolExecutable(installation);
    const source = member.runtimeNamespace!;
    let expected = member.nativeSessionId;
    let args: string[];
    if (installation.toolId === "codex") {
      const config = parseNativeConfig(
        readConfig(join(source, "config.toml")) ?? "",
        true,
      );
      const keys = [
        "model",
        "model_provider",
        "model_providers",
        "model_reasoning_effort",
      ];
      let text = "";
      for (const key of keys) {
        if (config[key] === undefined) continue;
        const copy = (value: unknown, path: string[]) => {
          if (
            typeof value === "string" ||
            typeof value === "boolean" ||
            typeof value === "number"
          )
            text = updateNativeConfig(text, true, [
              { field: { id: path.join("."), label: key, path }, value },
            ]);
          else if (value && typeof value === "object" && !Array.isArray(value))
            for (const [name, child] of Object.entries(value))
              copy(child, [...path, name]);
        };
        copy(config[key], [key]);
      }
      writeFileSync(join(home, "config.toml"), text, { mode: 0o600 });
      const auth = readConfig(join(source, "auth.json"));
      if (auth) {
        JSON.parse(auth);
        writeFileSync(join(home, "auth.json"), auth, { mode: 0o600 });
      }
      env.CODEX_HOME = home;
      args = expected ? ["exec", "resume", expected] : ["exec"];
      args.push(
        "--skip-git-repo-check",
        "--json",
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        'approval_policy="never"',
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        "features.browser_use=false",
        "-c",
        "features.computer_use=false",
        "-c",
        "features.hooks=false",
        "-c",
        'web_search="disabled"',
        "-",
      );
    } else {
      const config = parseNativeConfig(
        readConfig(join(source, "settings.json")) ?? "{}",
        false,
      );
      const allowed = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
      ];
      const values =
        config.env && typeof config.env === "object"
          ? (config.env as Record<string, unknown>)
          : {};
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({
          ...(typeof config.model === "string" ? { model: config.model } : {}),
          env: Object.fromEntries(
            Object.entries(values).filter(
              ([key, value]) =>
                allowed.includes(key) && typeof value === "string",
            ),
          ),
        }),
        { mode: 0o600 },
      );
      const credentials = readConfig(join(source, ".credentials.json"));
      if (credentials) {
        JSON.parse(credentials);
        writeFileSync(join(home, ".credentials.json"), credentials, {
          mode: 0o600,
        });
      }
      env.CLAUDE_CONFIG_DIR = home;
      args = [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--disable-slash-commands",
      ];
      if (expected) args.push("--resume", expected);
      else {
        expected = randomUUID();
        args.push("--session-id", expected);
      }
    }
    let confirmed: string | undefined;
    let text = "";
    let completed = false;
    let failed = false;
    let mismatch = false;
    let started = false;
    try {
      const result = await this.runner(
        {
          command: executable.command,
          args: [...executable.args, ...args],
          cwd: workspace,
          env,
          input: prompt,
        },
        {
          signal,
          timeoutMs: 180_000,
          onStarted: () => {
            started = true;
          },
          onLine: (line) => {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line);
            } catch {
              return;
            }
            const id = event.thread_id ?? event.session_id;
            if (typeof id === "string") {
              if (
                !/^[a-zA-Z0-9_-]{1,200}$/.test(id) ||
                (expected && expected !== id) ||
                (confirmed && confirmed !== id)
              ) {
                mismatch = true;
                throw new Error("会话 ID 不一致。");
              }
              confirmed = id;
              saveIdentity(id); // Persist before a later failure or process interruption.
            }
            if (installation.toolId === "codex") {
              const item = event.item as
                | { type?: string; text?: string }
                | undefined;
              if (
                event.type === "item.completed" &&
                item?.type === "agent_message" &&
                item.text
              )
                text += item.text;
              if (event.type === "turn.completed") completed = true;
              if (event.type === "turn.failed" || event.type === "error")
                failed = true;
            } else if (event.type === "result") {
              completed = true;
              failed =
                event.is_error === true ||
                String(event.subtype).startsWith("error");
              if (typeof event.result === "string") text = event.result;
            }
            if (text.length > 100_000) throw new Error("回复过长。");
          },
        },
      );
      if (
        result.exitCode !== 0 ||
        !completed ||
        failed ||
        !confirmed ||
        !text.trim()
      )
        throw new Error(
          "讨论工具没有返回完整回复。请检查模型配置、登录状态和工具版本。",
        );
      return text.trim();
    } catch {
      // Unknown identity must never silently start a replacement session on retry.
      if (mismatch || (started && !confirmed && !member.nativeSessionId))
        saveIdentity("");
      throw new Error(
        signal.aborted
          ? "讨论已停止。"
          : "工具回复未完成。请检查模型配置、登录状态及工具版本；已有会话 ID 会保留。",
      );
    }
  }
}
