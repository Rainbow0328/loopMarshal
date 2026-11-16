import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
} from "node:fs";
import { delimiter, dirname, extname, join, resolve, sep } from "node:path";
import type { ProxyToolId, ToolInstallation } from "@loopmarshal/protocol";
import { toolEnvironmentKeys } from "@loopmarshal/protocol";

const packages: Partial<Record<ProxyToolId, string>> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  mimo: "@mimo-ai/cli",
  opencode: "opencode-ai",
  qwen: "@qwen-code/qwen-code",
  gemini: "@google/gemini-cli",
  copilot: "@github/copilot",
  droid: "@factory/cli",
};

export type ProxyProcessPlan = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
};
export class ProxyProcessError extends Error {
  public constructor(
    message: string,
    public readonly started: boolean,
  ) {
    super(message);
  }
}

/** Resolve npm shims without executing a shell or interpolating a task into shell text. */
export function resolveToolExecutable(installation: ToolInstallation): {
  command: string;
  args: string[];
} {
  let executable = installation.executablePath;
  if (
    installation.toolId === "cursor" &&
    [".cmd", ".ps1"].includes(extname(executable).toLowerCase())
  ) {
    const root = dirname(executable);
    const versions = existsSync(join(root, "versions"))
      ? readdirSync(join(root, "versions"))
          .filter((name) =>
            /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(
              name,
            ),
          )
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .map((name) => join(root, "versions", name))
      : [];
    const target = [root, ...versions].find(
      (path) =>
        existsSync(join(path, "index.js")) &&
        existsSync(join(path, "node.exe")) &&
        existsSync(join(path, "package.json")) &&
        JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name ===
          "@anysphere/agent-cli-runtime",
    );
    if (!target)
      throw new Error(
        "未找到完整的 Cursor CLI 安装，请修复或重新安装 Cursor CLI。",
      );
    return {
      command: join(target, "node.exe"),
      args: [join(target, "index.js"), ...installation.executableArgs],
    };
  }
  if ([".cmd", ".ps1", ".bat"].includes(extname(executable).toLowerCase())) {
    const packageName = packages[installation.toolId];
    if (!packageName)
      throw new Error("该启动脚本尚未适配，请选择工具实际的可执行文件。");
    const roots = [join(dirname(executable), "node_modules", packageName)];
    if (dirname(executable).endsWith(`${sep}.bin`))
      roots.push(join(dirname(executable), "..", packageName));
    const packageRoot = roots.find((root) =>
      existsSync(join(root, "package.json")),
    );
    if (!packageRoot)
      throw new Error(
        "启动脚本对应的工具安装不存在，或该脚本格式暂不支持，请选择实际可执行文件。",
      );
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath))
      throw new Error("工具安装缺少程序清单，请修复安装或选择实际可执行文件。");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      bin?: string | Record<string, string>;
    };
    if (manifest.name !== packages[installation.toolId])
      throw new Error("启动脚本对应的程序与所选 Worker不一致。");
    const bin =
      typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin?.[installation.toolId];
    if (!bin)
      throw new Error("工具安装未声明预期的命令行入口，请选择实际可执行文件。");
    executable = resolve(packageRoot, bin);
    if (!executable.startsWith(resolve(packageRoot) + sep))
      throw new Error("工具入口超出其安装目录，无法使用此启动脚本。");
  }
  if (!existsSync(executable))
    throw new Error(
      "实际程序文件不存在，启动脚本可能指向已删除或已改名的文件。",
    );
  let nodeEntry = /\.[cm]?js$/i.test(executable);
  if (extname(executable) === "") {
    const descriptor = openSync(executable, "r");
    try {
      const header = Buffer.alloc(100);
      const length = readSync(descriptor, header, 0, header.length, 0);
      nodeEntry = header
        .subarray(0, length)
        .toString()
        .startsWith("#!/usr/bin/env node");
    } finally {
      closeSync(descriptor);
    }
  }
  return nodeEntry
    ? {
        command: process.execPath,
        args: [executable, ...installation.executableArgs],
      }
    : { command: executable, args: [...installation.executableArgs] };
}

export function proxyEnvironment(
  installation?: Pick<
    ToolInstallation,
    "toolId" | "environmentKeys" | "managedPaths"
  >,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|LANG|LC_ALL|TERM|NO_COLOR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i.test(
        key,
      )
    ) {
      environment[key] = value;
    }
  }
  environment.NO_COLOR = "1";
  // Electron's executable also serves as Node in packaged clients.
  environment.ELECTRON_RUN_AS_NODE = "1";
  // Managed workers must also find the bundled Node runtime when no system Node
  // is installed. Keep the rest of the user's executable search path intact.
  const pathKey =
    Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ??
    "PATH";
  environment[pathKey] =
    dirname(process.execPath) + delimiter + (environment[pathKey] ?? "");
  if (installation?.managedPaths) {
    environment.XDG_CACHE_HOME = installation.managedPaths.cacheRoot;
    environment.npm_config_cache = join(
      installation.managedPaths.cacheRoot,
      "npm",
    );
    if (installation.toolId === "opencode") {
      environment.XDG_CONFIG_HOME = dirname(
        installation.managedPaths.configRoot,
      );
      environment.XDG_DATA_HOME = join(
        installation.managedPaths.cacheRoot,
        "data",
      );
      environment.XDG_STATE_HOME = join(
        installation.managedPaths.cacheRoot,
        "state",
      );
    }
    if (installation.toolId === "mimo")
      environment.MIMOCODE_HOME = dirname(installation.managedPaths.configRoot);
  }
  for (const key of installation?.environmentKeys ?? []) {
    if (!toolEnvironmentKeys[installation!.toolId].includes(key))
      throw new Error("Unsupported inherited tool environment key.");
    const value = process.env[key];
    if (value === undefined || value === "")
      throw new Error(`Configured tool environment key is missing: ${key}`);
    environment[key] = value;
  }
  return environment;
}

export async function runProxyProcess(
  plan: ProxyProcessPlan,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    onLine: (line: string) => void;
    onStarted?: (pid: number) => void;
  },
): Promise<{ exitCode: number | null; stderr: string }> {
  if (options.signal.aborted)
    throw new ProxyProcessError(
      "Execution was cancelled before launch.",
      false,
    );
  return new Promise((resolvePromise, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let started = false;
    let interrupted: string | null = null;
    let buffer = "";
    let stderr = "";
    let outputSize = 0;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (interrupted) return;
      interrupted = reason;
      if (
        process.platform === "win32" &&
        child.pid &&
        child.exitCode === null
      ) {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill());
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      escalation = setTimeout(() => {
        if (child.exitCode !== null) return;
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill();
      }, 3000);
      deadline = setTimeout(() => {
        cleanup();
        child.unref();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        reject(
          new ProxyProcessError(
            `${reason} Process termination could not be confirmed.`,
            started,
          ),
        );
      }, 10000);
    };
    const onAbort = () =>
      stop(
        "Execution cancelled; verify native side effects before continuing.",
      );
    const timer = setTimeout(
      () =>
        stop(
          "Execution timed out; verify native side effects before continuing.",
        ),
      options.timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(deadline);
      options.signal.removeEventListener("abort", onAbort);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    child.on("spawn", () => {
      started = true;
      try {
        if (child.pid) options.onStarted?.(child.pid);
      } catch {
        stop("Could not persist process identity; execution requires review.");
      }
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputSize += Buffer.byteLength(chunk);
      if (outputSize > 16 * 1024 * 1024) {
        stop("Tool output exceeded the bounded capture limit.");
        return;
      }
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024 && !buffer.includes("\n")) {
        stop("Tool event frame is too large.");
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        try {
          if (line.trim()) options.onLine(line);
        } catch {
          stop("Tool event processing failed.");
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on("error", (error) => {
      cleanup();
      reject(new ProxyProcessError(error.message, started));
    });
    child.on("close", (exitCode) => {
      cleanup();
      if (interrupted) {
        reject(new ProxyProcessError(interrupted, started));
        return;
      }
      try {
        if (buffer.trim()) options.onLine(buffer);
      } catch {
        reject(new ProxyProcessError("Invalid final tool event.", started));
        return;
      }
      resolvePromise({ exitCode, stderr });
    });
    child.stdin.on("error", () => {
      /* EPIPE is reflected by exit status and missing terminal evidence. */
    });
    child.stdin.end(plan.input ?? "");
  });
}
