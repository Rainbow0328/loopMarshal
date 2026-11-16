import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { homedir, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import {
  createToolConfigProfileSchema,
  previewToolConfigSchema,
  proxyToolIds,
  type CreateToolConfigProfileInput,
  type PreviewToolConfigInput,
  type ToolConfigProfile,
  type ToolConfigDocument,
  type ToolConfigPreview,
  type ToolDiscoveryCandidate,
  type ToolConfigBackup,
  type ProxyToolId,
} from "@loopmarshal/protocol";
import type { MemberRouteService } from "./member-route-service.js";
import { CoreError, coreErrors } from "../errors.js";
import {
  configValueAt,
  nativeConfigFields,
  parseNativeConfig,
  prepareNativeConfig,
  updateNativeConfig,
  type ConfigValue,
} from "./native-config-adapters.js";
import { installationCompatibility } from "./tool-compatibility-service.js";
import { resolveToolExecutable } from "./proxy-process.js";
import { checkToolReadiness } from "./tool-readiness-service.js";
import { prepareModelToolConfig } from "./model-tool-config.js";
import type { ModelConfigWithSecret } from "@loopmarshal/store";

type Target = {
  id: string;
  path: string;
  scope: "user" | "project";
  toml: boolean;
};
type Preview = {
  profileId: string;
  target: Target;
  before: string;
  text: string;
  expires: number;
};
type BackupRow = {
  id: string;
  profile_id: string;
  document_id: string;
  target_path: string;
  backup_path: string;
  before_fingerprint: string;
  after_fingerprint: string;
  existed: number;
  created_at: string;
  restored_at: string | null;
};
const fingerprint = (text: string | null) =>
  text === null ? "missing" : createHash("sha256").update(text).digest("hex");
const conflict = (message: string) =>
  new CoreError("MEMBER_ROUTE_CONFLICT", message, 409);
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const effectiveAfter =
  "文件保存后立即写回；新的 CLI 执行读取新配置。已运行的会话或服务可能需要重启，启动参数、环境变量、项目或组织策略仍可能覆盖此文件。";

/** Native files remain authoritative; the database stores paths, metadata and hashes only. */
export class ToolConfigService {
  private readonly previews = new Map<string, Preview>();
  private readonly backupDirectory: string;
  public constructor(
    private readonly db: DatabaseSync,
    private readonly members: MemberRouteService,
    databasePath: string,
  ) {
    this.backupDirectory = join(
      dirname(resolve(databasePath)),
      "native-config-backups",
    );
  }
  public listProfiles(): ToolConfigProfile[] {
    return (
      this.db
        .prepare("SELECT profile_json FROM tool_config_profiles ORDER BY rowid")
        .all() as { profile_json: string }[]
    ).map((row) => {
      const profile = JSON.parse(row.profile_json) as ToolConfigProfile;
      // Repair only the old, empty auto-detected MiMo default; preserve explicit or populated roots.
      if (profile.toolId === "mimo" && process.env.MIMOCODE_HOME) {
        const oldRoot = join(
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
          "mimocode",
        );
        if (
          samePath(profile.configRoot, oldRoot) &&
          !["mimocode.json", "mimocode.jsonc"].some((file) =>
            existsSync(join(oldRoot, file)),
          )
        ) {
          return { ...profile, configRoot: this.defaultRoot("mimo") };
        }
      }
      return profile;
    });
  }
  public async checkInstallation(id: string, endpoint?: string) {
    const installation = this.members
      .listInstallations()
      .find((item) => item.id === id);
    if (!installation)
      throw coreErrors.invalidInput("工具安装不存在，请重新发现 Worker。");
    return checkToolReadiness(
      installation,
      () => {
        const profiles = this.listProfiles().filter(
          (item) => item.installationId === id,
        );
        if (!profiles.length)
          profiles.push({
            id: "check",
            installationId: id,
            toolId: installation.toolId,
            name: "check",
            configRoot: this.defaultRoot(installation.toolId),
            workspacePath: null,
            createdAt: "",
          });
        for (const profile of profiles)
          for (const target of this.targets(profile)) {
            const snapshot = this.read(target);
            if (snapshot.exists) parseNativeConfig(snapshot.text, target.toml);
          }
      },
      endpoint,
    );
  }
  public createProfile(raw: CreateToolConfigProfileInput): ToolConfigProfile {
    const input = createToolConfigProfileSchema.parse(raw);
    const installation = this.members
      .listInstallations()
      .find((item) => item.id === input.installationId);
    if (!installation) throw coreErrors.invalidInput("请先登记工具安装位置。");
    const configRoot = this.canonicalDirectory(input.configRoot);
    const workspacePath = input.workspacePath
      ? this.canonicalDirectory(input.workspacePath)
      : null;
    const existing = this.listProfiles().find(
      (profile) =>
        profile.installationId === input.installationId &&
        samePath(profile.configRoot, configRoot) &&
        profile.workspacePath === workspacePath,
    );
    if (existing) return existing;
    const profile: ToolConfigProfile = {
      ...input,
      configRoot,
      workspacePath,
      id: randomUUID(),
      toolId: installation.toolId,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO tool_config_profiles VALUES (?, ?, ?)")
      .run(profile.id, profile.installationId, JSON.stringify(profile));
    return profile;
  }
  public discover(): ToolDiscoveryCandidate[] {
    const home = homedir();
    const dirs = (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .slice(0, 96)
      .map((part) => ({
        path: part.replace(/^"|"$/g, ""),
        source: "path" as const,
      }));
    const known = [
      join(home, ".local", "bin"),
      ...(process.platform === "win32"
        ? [
            join(
              process.env.APPDATA ?? join(home, "AppData", "Roaming"),
              "npm",
            ),
            join(home, "scoop", "shims"),
            join(
              process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
              "cursor-agent",
            ),
          ]
        : ["/usr/local/bin", "/opt/homebrew/bin"]),
    ];
    const installations = this.members.listInstallations();
    const candidates = new Map<string, ToolDiscoveryCandidate>();
    for (const dir of [
      ...dirs,
      ...known.map((path) => ({ path, source: "known_location" as const })),
    ]) {
      if (!isAbsolute(dir.path)) continue;
      for (const toolId of proxyToolIds) {
        for (const command of toolId === "cursor"
          ? ["agent", "cursor-agent"]
          : [toolId]) {
          for (const extension of process.platform === "win32"
            ? [".exe", ".cmd", ".ps1", ""]
            : [""]) {
            const candidate = join(dir.path, command + extension);
            try {
              if (!statSync(candidate).isFile()) continue;
              const executablePath = realpathSync(candidate);
              const draft = {
                id: "discovery",
                toolId,
                displayName: toolId,
                executablePath,
                executableArgs: [],
                environmentKeys: [],
                version: null,
                createdAt: "",
                updatedAt: "",
              };
              const identity = (
                item: import("@loopmarshal/protocol").ToolInstallation,
              ) => {
                try {
                  const plan = resolveToolExecutable(item);
                  return JSON.stringify([
                    plan.command.toLowerCase(),
                    ...plan.args,
                  ]);
                } catch {
                  return item.executablePath.toLowerCase();
                }
              };
              const key = `${toolId}:${identity(draft)}`;
              if (!candidates.has(key))
                candidates.set(key, {
                  toolId,
                  executablePath,
                  source: dir.source,
                  registeredInstallationId:
                    installations.find(
                      (item) =>
                        item.toolId === toolId &&
                        identity(item) === identity(draft),
                    )?.id ?? null,
                  suggestedConfigRoot: this.defaultRoot(toolId),
                  compatibility: installationCompatibility(draft),
                });
              break;
            } catch {
              /* A missing PATH candidate is normal. */
            }
          }
        }
      }
    }
    return [...candidates.values()];
  }
  public defaults(): Record<ProxyToolId, string> {
    return Object.fromEntries(
      proxyToolIds.map((tool) => [tool, this.defaultRoot(tool)]),
    ) as Record<ProxyToolId, string>;
  }
  public documents(profileId: string): ToolConfigDocument[] {
    const profile = this.profile(profileId);
    return this.targets(profile).map((target) => {
      const snapshot = this.read(target);
      let value: Record<string, unknown>;
      try {
        value = parseNativeConfig(snapshot.text, target.toml);
      } catch {
        return {
          ...target,
          exists: snapshot.exists,
          fingerprint: snapshot.fingerprint,
          fields: [],
          effectiveAfter,
          warning:
            "配置格式无效或不受支持。原文件未改动；请先在原工具中修复后重新读取。",
        };
      }
      return {
        id: target.id,
        path: target.path,
        scope: target.scope,
        exists: snapshot.exists,
        fingerprint: snapshot.fingerprint,
        effectiveAfter,
        warning:
          profile.toolId === "gemini"
            ? "本页管理模型与认证方式；API 密钥由 Gemini 登录、.env 或明确选择的环境变量提供，当前不编辑 .env。"
            : profile.toolId === "cursor"
              ? "本页只管理已公开的网络设置。模型请在 Cursor CLI 使用 /model 选择；认证通过官方登录或 CURSOR_API_KEY 环境变量提供。"
              : profile.toolId === "copilot"
                ? "本页管理默认模型。官方登录令牌不在本页读取；自定义服务商文件暂不编辑。"
                : profile.toolId === "droid"
                  ? "支持修改已有 customModels 中的模型、地址与密钥；新增服务商请先在官方工具中建立配置。"
                  : profile.toolId === "kimi"
                    ? "先选择默认模型配置并保存，再编辑其模型 ID、服务商、地址和密钥。使用已有服务商配置。"
                    : profile.toolId === "codex"
                      ? "认证可选择 Codex 登录、环境变量或直接填写 API Key。密钥不会在读取或预览中显示。"
                      : profile.toolId === "claude"
                        ? "模型与认证读取自此文件的 model 和 env；已有模型映射单独显示，其他设置原样保留。"
                        : profile.toolId === "zcode"
                          ? "新服务商先保存服务商 ID 和模型，再填写 API 地址与密钥；新增时使用 OpenAI Chat Completions 协议。"
                          : "更换服务商后先保存，再设置其地址与密钥。其他设置原样保留。",
        fields: nativeConfigFields(profile.toolId, value).map((field) => {
          const raw = configValueAt(value, field.path);
          const configured = raw !== undefined && raw !== null;
          let sensitiveUrl = false;
          if (field.id.includes("url") && typeof raw === "string") {
            try {
              const url = new URL(raw);
              sensitiveUrl = Boolean(
                url.username || url.password || url.search || url.hash,
              );
            } catch {
              sensitiveUrl = true;
            }
          }
          return {
            id: field.id,
            label: field.label,
            secret: Boolean(field.secret || sensitiveUrl),
            configured,
            ...(field.kind ? { kind: field.kind } : {}),
            ...(field.options ? { options: field.options } : {}),
            ...(field.description ? { description: field.description } : {}),
            value:
              field.secret ||
              sensitiveUrl ||
              !["string", "boolean", "number"].includes(typeof raw)
                ? null
                : (raw as ConfigValue),
          };
        }),
      };
    });
  }
  public preview(
    profileId: string,
    raw: PreviewToolConfigInput,
  ): ToolConfigPreview {
    const input = previewToolConfigSchema.parse(raw);
    const profile = this.profile(profileId);
    const target = this.target(profile, input.documentId);
    const snapshot = this.read(target);
    if (snapshot.fingerprint !== input.expectedFingerprint)
      throw conflict("配置已被外部修改，请重新读取后编辑。");
    let value: Record<string, unknown>;
    try {
      value = parseNativeConfig(snapshot.text, target.toml);
    } catch {
      throw coreErrors.invalidInput("配置文件格式无效，不能写入。");
    }
    const fields = nativeConfigFields(profile.toolId, value);
    const changes = Object.entries(input.values).map(([id, replacement]) => {
      const field = fields.find((item) => item.id === id);
      if (!field) throw coreErrors.invalidInput(`不支持的配置字段：${id}`);
      if (
        replacement !== null &&
        (field.options
          ? !field.options.includes(String(replacement))
          : typeof replacement !== (field.kind ?? "string"))
      )
        throw coreErrors.invalidInput(`配置字段值不合法：${field.label}`);
      if (
        typeof replacement === "string" &&
        (!replacement.trim() ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(replacement))
      )
        throw coreErrors.invalidInput(`请填写有效值或恢复默认：${field.label}`);
      if (id.includes("url") && replacement !== null) {
        try {
          const url = new URL(String(replacement));
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error();
        } catch {
          throw coreErrors.invalidInput(
            "API 地址必须是无凭据、查询参数或片段的 HTTP(S) 地址。",
          );
        }
      }
      return { field, value: replacement };
    });
    if (profile.toolId === "codex") {
      const envKey = input.values.provider_env_key;
      const apiKey = input.values.provider_api_key;
      if (envKey && apiKey)
        throw coreErrors.invalidInput(
          "环境变量与直接填写 API Key 只能选择一种。",
        );
      if (
        typeof envKey === "string" &&
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)
      )
        throw coreErrors.invalidInput(
          "请填写环境变量名称，例如 OPENAI_API_KEY，不能填写密钥本身。",
        );
      const addChange = (id: string, replacement: ConfigValue) => {
        const existing = changes.find((change) => change.field.id === id);
        if (existing) existing.value = replacement;
        else
          changes.push({
            field: fields.find((field) => field.id === id)!,
            value: replacement,
          });
      };
      if (envKey || apiKey) {
        addChange(envKey ? "provider_api_key" : "provider_env_key", null);
        addChange("provider_requires_openai_auth", false);
        if (
          !configValueAt(
            value,
            fields.find((field) => field.id === "provider_name")!.path,
          )
        )
          addChange(
            "provider_name",
            typeof value.model_provider === "string"
              ? value.model_provider
              : "OpenAI",
          );
      } else if (input.values.provider_requires_openai_auth === true) {
        addChange("provider_api_key", null);
        addChange("provider_env_key", null);
      }
    }
    if (
      ("model_provider" in input.values ||
        "provider" in input.values ||
        ((profile.toolId === "mimo" || profile.toolId === "opencode") &&
          "model" in input.values)) &&
      changes.some(
        (item) =>
          item.field.path[0] === "model_providers" ||
          item.field.path[0] === "provider" ||
          item.field.path.includes("providerRules"),
      )
    )
      throw coreErrors.invalidInput(
        "请先保存服务商选择并重新读取，再编辑该服务商的地址或密钥。",
      );
    if (
      profile.toolId === "kimi" &&
      (("model" in input.values &&
        changes.some((item) =>
          ["models", "providers"].includes(item.field.path[0]!),
        )) ||
        ("model_provider" in input.values &&
          changes.some((item) => item.field.path[0] === "providers")))
    )
      throw coreErrors.invalidInput(
        "请先保存默认模型或服务商选择并重新读取，再编辑对应的模型、地址或密钥。",
      );
    let text: string;
    try {
      const initial =
        !snapshot.exists && profile.toolId === "zcode"
          ? '{"schemaVersion":1,"config":{}}\n'
          : snapshot.text;
      text = updateNativeConfig(
        prepareNativeConfig(
          profile.toolId,
          initial,
          changes.map((item) => item.field),
        ),
        target.toml,
        changes,
      );
    } catch {
      throw coreErrors.invalidInput(
        "此配置结构暂不能安全修改，原文件未改动。新增服务商前请先保存服务商 ID 和模型。",
      );
    }
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw coreErrors.invalidInput("修改后配置超过 1MB，未写入。");
    // Verify that syntax editing actually changed the requested paths, without exposing parser errors or secrets.
    const after = parseNativeConfig(text, target.toml);
    for (const change of changes)
      if ((configValueAt(after, change.field.path) ?? null) !== change.value)
        throw coreErrors.invalidInput(
          "无法保持当前配置结构，请先在工具中调整。",
        );
    for (const [id, preview] of this.previews)
      if (preview.expires < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 100)
      throw conflict("待确认的预览过多，请稍后重试。");
    const previewId = randomUUID();
    const expires = Date.now() + 5 * 60_000;
    this.previews.set(previewId, {
      profileId,
      target,
      before: snapshot.fingerprint,
      text,
      expires,
    });
    return {
      previewId,
      path: target.path,
      effectiveAfter,
      expiresAt: new Date(expires).toISOString(),
      changes: changes.map(({ field, value: replacement }) => ({
        fieldId: field.id,
        before:
          field.secret || field.id.includes("url")
            ? configValueAt(value, field.path) === undefined
              ? null
              : "已配置"
            : typeof configValueAt(value, field.path) === "string"
              ? (configValueAt(value, field.path) as string)
              : null,
        after: field.secret
          ? replacement === null
            ? null
            : "已更新（隐藏）"
          : replacement,
      })),
    };
  }
  public apply(
    profileId: string,
    previewId: string,
  ): { document: ToolConfigDocument; backup: ToolConfigBackup } {
    const preview = this.previews.get(previewId);
    if (
      !preview ||
      preview.profileId !== profileId ||
      preview.expires < Date.now()
    )
      throw conflict("预览已失效，请重新预览。");
    if (
      !samePath(
        this.target(this.profile(profileId), preview.target.id).path,
        preview.target.path,
      )
    )
      throw conflict("配置来源在预览后发生变化，请重新读取。");
    this.assertIdle();
    const current = this.read(preview.target);
    if (current.fingerprint !== preview.before)
      throw conflict("配置在预览后已被外部修改，请重新读取。");
    this.prepareBackups();
    const id = randomUUID();
    const backupPath = join(this.backupDirectory, `${id}.bak`);
    writeFileSync(backupPath, current.exists ? current.text : "", {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    // Persist the recovery record BEFORE replacing the native file, including crash between file write and response.
    this.db
      .prepare(
        "INSERT INTO tool_config_backups (id,profile_id,document_id,target_path,backup_path,before_fingerprint,after_fingerprint,existed,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        profileId,
        preview.target.id,
        preview.target.path,
        backupPath,
        preview.before,
        fingerprint(preview.text),
        current.exists ? 1 : 0,
        new Date().toISOString(),
      );
    this.replace(preview.target, preview.text, preview.before);
    this.previews.delete(previewId);
    this.trimBackups(profileId, preview.target.id);
    return {
      document: this.documents(profileId).find(
        (doc) => doc.id === preview.target.id,
      )!,
      backup: this.backups(profileId).find((item) => item.id === id)!,
    };
  }
  public previewModel(
    profileId: string,
    expectedFingerprint: string,
    model: ModelConfigWithSecret,
    responsesConfirmed = false,
  ): ToolConfigPreview {
    const profile = this.profile(profileId);
    const target = this.target(profile, "user");
    const snapshot = this.read(target);
    if (snapshot.fingerprint !== expectedFingerprint)
      throw conflict("配置已被外部修改，请重新读取。");
    const result = prepareModelToolConfig(
      profile.toolId,
      snapshot.text,
      model,
      responsesConfirmed,
    );
    if (Buffer.byteLength(result.text) > 1024 * 1024)
      throw coreErrors.invalidInput("配置文件超过 1MB，未写入。");
    for (const [id, item] of this.previews)
      if (item.expires < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 100)
      throw conflict("待确认的预览过多，请稍后重试。");
    const previewId = randomUUID();
    const expires = Date.now() + 5 * 60_000;
    this.previews.set(previewId, {
      profileId,
      target,
      before: snapshot.fingerprint,
      text: result.text,
      expires,
    });
    return {
      previewId,
      path: target.path,
      changes: result.changes,
      expiresAt: new Date(expires).toISOString(),
      effectiveAfter,
    };
  }
  public backups(profileId: string): ToolConfigBackup[] {
    this.profile(profileId);
    return this.backupRows(profileId).map((row) => ({
      id: row.id,
      profileId,
      documentId: row.document_id,
      createdAt: row.created_at,
      path: row.backup_path,
      restoredAt: row.restored_at,
      canRestore: !row.restored_at && existsSync(row.backup_path),
    }));
  }
  public restore(profileId: string, id: string): ToolConfigDocument[] {
    this.assertIdle();
    const profile = this.profile(profileId);
    const row = this.backupRows(profileId).find((item) => item.id === id);
    if (!row || row.restored_at)
      throw coreErrors.invalidInput("备份不存在或已经恢复。");
    const target = this.target(profile, row.document_id);
    if (
      !samePath(target.path, row.target_path) ||
      !samePath(dirname(row.backup_path), this.backupDirectory)
    )
      throw conflict("备份目标不匹配。");
    const snapshot = this.read(target);
    if (snapshot.fingerprint !== row.after_fingerprint)
      throw conflict("配置已有后续修改，不能用旧备份覆盖。请先核对原生文件。");
    const original = readFileSync(row.backup_path, "utf8");
    if (fingerprint(row.existed ? original : null) !== row.before_fingerprint)
      throw conflict("备份文件校验失败，未恢复。");
    if (row.existed) this.replace(target, original, row.after_fingerprint);
    else {
      this.safePath(target.path);
      if (this.read(target).fingerprint !== row.after_fingerprint)
        throw conflict("配置已变化。");
      unlinkSync(target.path);
    }
    this.db
      .prepare("UPDATE tool_config_backups SET restored_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.documents(profileId);
  }
  private profile(id: string): ToolConfigProfile {
    const profile = this.listProfiles().find((item) => item.id === id);
    if (!profile) throw coreErrors.invalidInput("配置档案不存在。");
    return profile;
  }
  private targets(profile: ToolConfigProfile): Target[] {
    const file = {
      codex: "config.toml",
      claude: "settings.json",
      qwen: "settings.json",
      mimo: "mimocode.json",
      opencode: "opencode.json",
      zcode: join("v2", "provider_config.json"),
      gemini: "settings.json",
      kimi: "config.toml",
      cursor: "cli-config.json",
      droid: "settings.json",
      copilot: "config.json",
    }[profile.toolId];
    const targets: Target[] = [
      {
        id: "user",
        path: join(profile.configRoot, file),
        scope: "user",
        toml: ["codex", "kimi"].includes(profile.toolId),
      },
    ];
    if (
      profile.workspacePath &&
      !["zcode", "kimi", "cursor", "droid", "copilot"].includes(profile.toolId)
    ) {
      const projectFile =
        profile.toolId === "codex"
          ? join(".codex", file)
          : ["claude", "qwen", "gemini"].includes(profile.toolId)
            ? join(`.${profile.toolId}`, file)
            : file;
      targets.push({
        id: "project",
        path: join(profile.workspacePath, projectFile),
        scope: "project",
        toml: profile.toolId === "codex",
      });
      if (profile.toolId === "claude")
        targets.push({
          id: "project-local",
          path: join(profile.workspacePath, ".claude", "settings.local.json"),
          scope: "project",
          toml: false,
        });
    }
    for (const target of targets) {
      // Prefer the actual JSONC source. Multiple active siblings would make a save misleading.
      if (profile.toolId === "mimo" || profile.toolId === "opencode") {
        const jsonc = target.path + "c";
        if (existsSync(jsonc) && existsSync(target.path))
          throw conflict(
            "同时存在 JSON 和 JSONC 配置，请先在原工具中确认唯一配置来源。",
          );
        if (existsSync(jsonc)) target.path = jsonc;
      }
    }
    return targets;
  }
  private target(profile: ToolConfigProfile, id: string): Target {
    const target = this.targets(profile).find((item) => item.id === id);
    if (!target) throw coreErrors.invalidInput("不支持的配置来源。");
    return target;
  }
  private read(target: Target): {
    text: string;
    exists: boolean;
    fingerprint: string;
  } {
    this.safePath(target.path);
    if (!existsSync(target.path))
      return { text: "", exists: false, fingerprint: "missing" };
    const stat = statSync(target.path);
    if (!stat.isFile() || stat.size > 1024 * 1024 || stat.nlink > 1)
      throw coreErrors.invalidInput(
        "只支持 1MB 以内、无硬链接的普通配置文件。",
      );
    const bytes = readFileSync(target.path);
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return { text, exists: true, fingerprint: fingerprint(text) };
  }
  private replace(target: Target, text: string, expected: string): void {
    this.safePath(target.path);
    mkdirSync(dirname(target.path), { recursive: true });
    this.safePath(target.path);
    const temp = `${target.path}.loopmarshal-${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, "", {
        flag: "wx",
        mode: existsSync(target.path)
          ? statSync(target.path).mode & 0o777
          : 0o600,
      });
      if (process.platform === "win32" && existsSync(target.path)) {
        // Preserve a stricter native file ACL when replacing it. Paths are data, never interpolated shell code.
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop'; Set-Acl -LiteralPath $env:LM_CONFIG_TEMP -AclObject (Get-Acl -LiteralPath $env:LM_CONFIG_TARGET)",
          ],
          {
            windowsHide: true,
            stdio: "pipe",
            timeout: 10000,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key]) => key.toLowerCase() !== "psmodulepath",
                ),
              ),
              PSModulePath: join(
                process.env.SystemRoot ?? "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "Modules",
              ),
              LM_CONFIG_TEMP: temp,
              LM_CONFIG_TARGET: target.path,
            },
          },
        );
      } else if (process.platform === "win32") {
        execFileSync(
          "icacls.exe",
          [
            temp,
            "/inheritance:r",
            "/grant:r",
            `${process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" : ""}${userInfo().username}:F`,
            "*S-1-5-18:F",
          ],
          { windowsHide: true, stdio: "pipe", timeout: 10000 },
        );
      }
      writeFileSync(temp, text, { flag: "w", flush: true });
      if (this.read(target).fingerprint !== expected)
        throw conflict("配置在保存期间被外部修改，请重新读取。");
      renameSync(temp, target.path);
      if (this.read(target).fingerprint !== fingerprint(text))
        throw conflict("文件写后校验失败，请检查备份与外部写入。");
    } finally {
      rmSync(temp, { force: true });
    }
  }
  private canonicalDirectory(path: string): string {
    if (!isAbsolute(path))
      throw coreErrors.invalidInput("配置目录和项目目录必须使用完整路径。");
    let parent = resolve(path);
    const remaining: string[] = [];
    while (!existsSync(parent)) {
      remaining.unshift(basename(parent));
      const next = dirname(parent);
      if (next === parent) throw coreErrors.invalidInput("目录不可用。");
      parent = next;
    }
    if (!statSync(parent).isDirectory())
      throw coreErrors.invalidInput("指定位置不是目录。");
    return join(realpathSync(parent), ...remaining);
  }
  private safePath(path: string): void {
    let part = resolve(path);
    while (true) {
      try {
        if (lstatSync(part).isSymbolicLink())
          throw conflict("配置路径存在符号链接或目录联接，请选择真实目录。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = dirname(part);
      if (next === part) break;
      part = next;
    }
  }
  private assertIdle(): void {
    if (
      this.db
        .prepare("SELECT 1 FROM discussion_rooms WHERE busy=1 LIMIT 1")
        .get()
    )
      throw conflict("有讨论成员正在运行，请等待讨论结束后修改配置。");
    const running = this.db
      .prepare(
        "SELECT 1 FROM message_deliveries WHERE state IN ('delivering','awaiting_result','unknown') LIMIT 1",
      )
      .get();
    if (running)
      throw conflict(
        "当前存在执行中或待核对的工具任务，请处理后再保存或恢复配置。",
      );
  }
  private prepareBackups(): void {
    this.safePath(this.backupDirectory);
    mkdirSync(this.backupDirectory, { recursive: true, mode: 0o700 });
    if (process.platform === "win32")
      execFileSync(
        "icacls.exe",
        [
          this.backupDirectory,
          "/inheritance:r",
          "/grant:r",
          `${process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" : ""}${userInfo().username}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
        ],
        { windowsHide: true, stdio: "pipe", timeout: 10000 },
      );
    else chmodSync(this.backupDirectory, 0o700);
  }
  private backupRows(profileId: string): BackupRow[] {
    return this.db
      .prepare(
        "SELECT * FROM tool_config_backups WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(profileId) as BackupRow[];
  }
  private trimBackups(profileId: string, documentId: string): void {
    for (const row of this.backupRows(profileId)
      .filter((item) => item.document_id === documentId)
      .slice(20)) {
      if (samePath(dirname(row.backup_path), this.backupDirectory))
        rmSync(row.backup_path, { force: true });
      this.db
        .prepare("DELETE FROM tool_config_backups WHERE id = ?")
        .run(row.id);
    }
  }
  private defaultRoot(tool: ProxyToolId): string {
    const home = homedir();
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    return {
      codex: process.env.CODEX_HOME || join(home, ".codex"),
      claude: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
      qwen: process.env.QWEN_HOME || join(home, ".qwen"),
      zcode: join(process.env.ZCODE_DATA_BASE_DIR || home, ".zcode"),
      mimo: process.env.MIMOCODE_HOME
        ? join(process.env.MIMOCODE_HOME, "config")
        : join(config, "mimocode"),
      opencode: join(config, "opencode"),
      gemini: join(process.env.GEMINI_CLI_HOME || home, ".gemini"),
      kimi: process.env.KIMI_CODE_HOME || join(home, ".kimi-code"),
      cursor: process.env.CURSOR_CONFIG_DIR || join(home, ".cursor"),
      droid: join(process.env.FACTORY_HOME_OVERRIDE || home, ".factory"),
      copilot: process.env.COPILOT_HOME || join(home, ".copilot"),
    }[tool];
  }
}
