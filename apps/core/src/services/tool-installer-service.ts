import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import {
  proxyToolIds,
  toolInstallRequestSchema,
  type ToolInstallCatalogEntry,
  type ToolInstallJob,
  type ToolInstallRequest,
} from "@loopmarshal/protocol";
import { coreErrors } from "../errors.js";
import type { MemberRouteService } from "./member-route-service.js";
import type { ToolConfigService } from "./tool-config-service.js";
import { proxyEnvironment, runProxyProcess } from "./proxy-process.js";

const officialPackages: Record<string, [string, string, string[]]> = {
  codex: ["@openai/codex", "https://github.com/openai/codex", ["responses"]],
  claude: [
    "@anthropic-ai/claude-code",
    "https://code.claude.com/docs/en/setup",
    ["anthropic"],
  ],
  qwen: [
    "@qwen-code/qwen-code",
    "https://github.com/QwenLM/qwen-code",
    ["openai", "anthropic"],
  ],
  gemini: [
    "@google/gemini-cli",
    "https://github.com/google-gemini/gemini-cli",
    [],
  ],
  opencode: [
    "opencode-ai",
    "https://opencode.ai/docs",
    ["openai", "anthropic"],
  ],
  mimo: [
    "@mimo-ai/cli",
    "https://mimo.xiaomi.com/coder",
    ["openai", "anthropic"],
  ],
};
export const toolInstallCatalog: ToolInstallCatalogEntry[] = proxyToolIds.map(
  (toolId) => {
    const spec = officialPackages[toolId];
    return {
      toolId,
      packageName: spec?.[0] ?? null,
      source: spec?.[1] ?? "",
      modelProtocols: spec?.[2] ?? [],
      reason: spec
        ? null
        : "暂未提供受管安装，请从官方安装后使用“发现 Worker”添加。",
    };
  },
);

/** Never resolve npm.cmd through cmd.exe: all user paths remain literal argv. */
export function findNpmEntry(): string | null {
  const directories = [
    dirname(process.execPath),
    ...(process.env.PATH ?? "").split(delimiter),
  ];
  for (const directory of directories) {
    if (!directory) continue;
    for (const file of [
      join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
      join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]) {
      if (existsSync(file)) return realpathSync(file);
    }
  }
  return null;
}

function canonicalRoot(value: string): string {
  if (!isAbsolute(value) || /[\u0000-\u001f]/.test(value))
    throw coreErrors.invalidInput("请选择完整的本地存储目录。");
  let current = resolve(value);
  while (true) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw coreErrors.invalidInput(
        "安装目录不能经过目录联接或符号链接，请选择真实目录。",
      );
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  return resolve(value);
}
const jobColumns =
  "id, tool_id AS toolId, root, status, installation_id AS installationId, profile_id AS profileId, error, created_at AS createdAt";

export class ToolInstallerService {
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  constructor(
    private readonly db: DatabaseSync,
    private readonly members: MemberRouteService,
    private readonly configs: ToolConfigService,
    private readonly runner = runProxyProcess,
    private readonly npmEntry = findNpmEntry,
  ) {
    db.prepare(
      "UPDATE tool_install_jobs SET status='failed', error='上次安装被中断。目录可能保留部分文件，请检查后再重试。' WHERE status='installing'",
    ).run();
  }
  settings() {
    const saved = this.db
      .prepare("SELECT root FROM tool_install_settings WHERE id=1")
      .get() as { root: string } | undefined;
    return {
      root: saved?.root ?? join(homedir(), "LoopMarshalTools"),
      npmAvailable: Boolean(this.npmEntry()),
      catalog: toolInstallCatalog,
      jobs: this.jobs(),
    };
  }
  saveRoot(root: string) {
    const value = canonicalRoot(root);
    this.db
      .prepare(
        "INSERT INTO tool_install_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root",
      )
      .run(value);
    return this.settings();
  }
  jobs(): ToolInstallJob[] {
    return this.db
      .prepare(
        `SELECT ${jobColumns} FROM tool_install_jobs ORDER BY rowid DESC LIMIT 30`,
      )
      .all() as unknown as ToolInstallJob[];
  }
  start(raw: ToolInstallRequest): ToolInstallJob {
    const input = toolInstallRequestSchema.parse(raw);
    const spec = officialPackages[input.toolId];
    if (!spec)
      throw coreErrors.invalidInput(
        "此工具暂不支持快捷安装，请使用官方安装方式。",
      );
    const npm = this.npmEntry();
    if (!npm)
      throw coreErrors.invalidInput(
        "没有找到 npm。请先安装 Node.js 22 或以上版本并重新启动客户端。",
      );
    if (Number(process.versions.node.split(".")[0]) < 22)
      throw coreErrors.invalidInput("快捷安装需要 Node.js 22 或以上版本。");
    if (this.active.size)
      throw coreErrors.invalidInput("已有工具正在安装，请等待完成。");
    const root = canonicalRoot(input.root);
    const prefix = canonicalRoot(join(root, "tools", input.toolId));
    if (existsSync(prefix) && readdirSync(prefix).length)
      throw coreErrors.invalidInput(
        "目标工具目录已有内容，不会覆盖已有安装。请沿用该工具，或更换存储目录。",
      );
    mkdirSync(prefix, { recursive: true });
    const job: ToolInstallJob = {
      id: randomUUID(),
      toolId: input.toolId,
      root,
      status: "installing",
      installationId: null,
      profileId: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO tool_install_jobs (id,tool_id,root,status,created_at) VALUES(?,?,?,?,?)",
      )
      .run(job.id, job.toolId, root, job.status, job.createdAt);
    this.saveRoot(root);
    const controller = new AbortController();
    // Start after the request returns, keeping the durable job visible to a reopened client.
    const done = Promise.resolve()
      .then(() => this.install(job, spec[0], npm, controller.signal))
      .finally(() => this.active.delete(job.id));
    this.active.set(job.id, { controller, done });
    return job;
  }
  async stop(): Promise<void> {
    const active = [...this.active.values()];
    active.forEach((item) => item.controller.abort());
    await Promise.allSettled(active.map((item) => item.done));
  }
  private async install(
    job: ToolInstallJob,
    packageName: string,
    npm: string,
    signal: AbortSignal,
  ) {
    try {
      const prefix = join(job.root, "tools", job.toolId);
      const cacheRoot = canonicalRoot(join(job.root, "cache", job.toolId));
      const configRoot = canonicalRoot(
        job.toolId === "gemini"
          ? join(job.root, "config", "gemini", ".gemini")
          : job.toolId === "mimo"
            ? join(job.root, "config", "mimo", "config")
            : join(job.root, "config", job.toolId),
      );
      mkdirSync(cacheRoot, { recursive: true });
      mkdirSync(configRoot, { recursive: true, mode: 0o700 });
      const env = proxyEnvironment();
      const pathKey =
        Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      env[pathKey] =
        dirname(process.execPath) + delimiter + (env[pathKey] ?? "");
      const result = await this.runner(
        {
          command: process.execPath,
          args: [
            npm,
            "install",
            "--global",
            "--prefix",
            prefix,
            "--cache",
            join(cacheRoot, "npm"),
            "--registry=https://registry.npmjs.org",
            "--no-audit",
            "--no-fund",
            `${packageName}@latest`,
          ],
          env,
          cwd: prefix,
        },
        { signal, timeoutMs: 15 * 60_000, onLine: () => {} },
      );
      if (result.exitCode !== 0)
        throw new Error(
          "软件下载或安装失败。请检查网络、npm 和系统依赖；部分安装文件已保留，不会自动覆盖。",
        );
      const packageRoot = join(
        prefix,
        ...(process.platform === "win32"
          ? ["node_modules"]
          : ["lib", "node_modules"]),
        packageName,
      );
      const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      ) as {
        name: string;
        version: string;
        bin: string | Record<string, string>;
      };
      const bin =
        typeof manifest.bin === "string"
          ? manifest.bin
          : manifest.bin?.[job.toolId];
      if (manifest.name !== packageName || !bin)
        throw new Error("下载的程序清单不符合预期，请检查安装目录。");
      const executablePath = realpathSync(resolve(packageRoot, bin));
      const inside = relative(realpathSync(packageRoot), executablePath);
      if (
        inside.startsWith(`..${sep}`) ||
        inside === ".." ||
        isAbsolute(inside)
      )
        throw new Error("工具入口超出安装目录。");
      const installation = this.members.createInstallation({
        toolId: job.toolId,
        displayName: job.toolId,
        executablePath,
        version: manifest.version,
      });
      this.db
        .prepare(
          "UPDATE tool_installations SET managed_paths_json=? WHERE id=?",
        )
        .run(JSON.stringify({ configRoot, cacheRoot }), installation.id);
      const profile = this.configs.createProfile({
        installationId: installation.id,
        configRoot,
        name: "快捷安装配置",
      });
      this.db
        .prepare(
          "UPDATE tool_install_jobs SET status='installed', installation_id=?, profile_id=? WHERE id=?",
        )
        .run(installation.id, profile.id, job.id);
    } catch {
      this.db
        .prepare(
          "UPDATE tool_install_jobs SET status='failed', error=? WHERE id=?",
        )
        .run(
          signal.aborted
            ? "安装被中断。请检查目标目录中的部分文件后重试。"
            : "安装未完成。请检查网络、Node.js/npm 和目录权限；如目标目录已有部分文件，请先检查或更换目录。",
          job.id,
        );
    }
  }
}
