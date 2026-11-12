import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createProxyFixture } from "./proxy-fixture.js";
import { ToolConfigService } from "../services/tool-config-service.js";
import {
  parseNativeConfig,
  updateNativeConfig,
} from "../services/native-config-adapters.js";
import type { ProxyToolId } from "@loopmarshal/protocol";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(tool: ProxyToolId = "codex", text = "") {
  const f = createProxyFixture();
  cleanups.push(f.close);
  const installation = f.routeService.createInstallation({
    toolId: tool,
    displayName: tool,
    executablePath: process.execPath,
  });
  const configRoot = join(f.directory, "config 中文 A");
  mkdirSync(configRoot);
  const service = new ToolConfigService(
    f.database,
    f.routeService,
    join(f.directory, "test.sqlite"),
  );
  const profile = service.createProfile({
    installationId: installation.id,
    configRoot,
    name: "测试配置",
    workspacePath: f.directory,
  });
  const target = service.documents(profile.id)[0]!;
  mkdirSync(join(target.path, ".."), { recursive: true });
  if (text) writeFileSync(target.path, text);
  const preview = (
    values: Record<string, string | boolean | number | null>,
    fingerprint = service.documents(profile.id)[0]!.fingerprint,
  ) =>
    service.preview(profile.id, {
      documentId: "user",
      expectedFingerprint: fingerprint,
      values,
    });
  return { ...f, service, profile, target, preview };
}
describe("native configuration management", () => {
  it("switches Codex between direct API key, environment reference and login without leaking keys", () => {
    const original =
      '# keep\nmodel_provider = "work"\n[model_providers.work]\nname = "Work"\nbase_url = "https://example.test/v1"\nenv_key = "OPENAI_API_KEY"\nrequires_openai_auth = true\n[other]\nkeep = true\n';
    const f = fixture("codex", original);
    const authPath = join(f.profile.configRoot, "auth.json");
    writeFileSync(
      authPath,
      '{"tokens":{"access_token":"private-login-token"}}',
    );
    const preview = f.preview({ provider_api_key: "private-direct-key" });
    expect(JSON.stringify(preview)).not.toContain("private-direct-key");
    const saved = f.service.apply(f.profile.id, preview.previewId);
    expect(
      parseNativeConfig(readFileSync(f.target.path, "utf8"), true),
    ).toMatchObject({
      model_providers: {
        work: {
          experimental_bearer_token: "private-direct-key",
          requires_openai_auth: false,
        },
      },
      other: { keep: true },
    });
    expect(readFileSync(f.target.path, "utf8")).not.toContain("env_key");
    const document = f.service.documents(f.profile.id)[0]!;
    expect(
      document.fields.find((field) => field.id === "provider_api_key"),
    ).toMatchObject({ secret: true, value: null, configured: true });
    expect(JSON.stringify(document)).not.toContain("private-direct-key");
    f.service.apply(
      f.profile.id,
      f.preview({ model: "updated-model" }).previewId,
    );
    expect(readFileSync(f.target.path, "utf8")).toContain("private-direct-key");
    f.service.apply(
      f.profile.id,
      f.preview({ provider_env_key: "OPENAI_API_KEY" }).previewId,
    );
    expect(readFileSync(f.target.path, "utf8")).not.toContain(
      "experimental_bearer_token",
    );
    expect(
      parseNativeConfig(readFileSync(f.target.path, "utf8"), true),
    ).toMatchObject({
      model_providers: {
        work: { env_key: "OPENAI_API_KEY", requires_openai_auth: false },
      },
    });
    f.service.apply(
      f.profile.id,
      f.preview({ provider_requires_openai_auth: true }).previewId,
    );
    expect(readFileSync(f.target.path, "utf8")).not.toContain("env_key");
    expect(
      parseNativeConfig(readFileSync(f.target.path, "utf8"), true),
    ).toMatchObject({
      model_providers: { work: { requires_openai_auth: true } },
    });
    expect(readFileSync(authPath, "utf8")).toBe(
      '{"tokens":{"access_token":"private-login-token"}}',
    );
    expect(readFileSync(saved.backup.path, "utf8")).toBe(original);
    for (const table of ["tool_config_profiles", "tool_config_backups"])
      expect(
        JSON.stringify(f.database.prepare(`SELECT * FROM ${table}`).all()),
      ).not.toContain("private-");
  });
  it("rejects conflicting Codex credentials, invalid variable names and simultaneous provider changes", () => {
    const f = fixture(
      "codex",
      'model_provider = "work"\n[model_providers.work]\nname = "Work"\n',
    );
    expect(() =>
      f.preview({
        provider_env_key: "OPENAI_API_KEY",
        provider_api_key: "private-key",
      }),
    ).toThrow(/只能选择一种/);
    expect(() => f.preview({ provider_env_key: "sk-invalid-key" })).toThrow(
      /环境变量名称/,
    );
    expect(() =>
      f.preview({ model_provider: "other", provider_api_key: "private-key" }),
    ).toThrow(/先保存/);
    expect(readFileSync(f.target.path, "utf8")).not.toContain("private-key");
  });
  it("creates a named Codex provider when setting a key on a default configuration", () => {
    const f = fixture("codex", 'model = "example-model"\n');
    f.service.apply(
      f.profile.id,
      f.preview({ provider_api_key: "private-key" }).previewId,
    );
    expect(
      parseNativeConfig(readFileSync(f.target.path, "utf8"), true),
    ).toMatchObject({
      model_providers: {
        openai: {
          name: "OpenAI",
          experimental_bearer_token: "private-key",
          requires_openai_auth: false,
        },
      },
    });
  });
  it("writes Cursor's published boolean setting without inventing credential fields", () => {
    const f = fixture(
      "cursor",
      '{"network":{"useHttp1ForAgent":false},"unknown":"keep"}',
    );
    expect(f.target.path).toMatch(/cli-config\.json$/);
    expect(f.service.documents(f.profile.id)[0]!.fields).toMatchObject([
      { id: "http1", kind: "boolean", value: false },
    ]);
    f.service.apply(f.profile.id, f.preview({ http1: true }).previewId);
    expect(
      parseNativeConfig(readFileSync(f.target.path, "utf8"), false),
    ).toEqual({ network: { useHttp1ForAgent: true }, unknown: "keep" });
    expect(() => f.preview({ api_key: "secret" })).toThrow(/不支持/);
  });
  it("updates Kimi's selected provider while masking keys and protecting model changes", () => {
    const f = fixture(
      "kimi",
      '# keep\ndefault_model = "local"\n[models.local]\nmodel = "old"\nprovider = "local"\nprotocol = "openai"\n[providers.local]\ntype = "openai_legacy"\nbase_url = "https://example.test/v1"\napi_key = "private-old"\n',
    );
    expect(JSON.stringify(f.service.documents(f.profile.id))).not.toContain(
      "private-old",
    );
    expect(() => f.preview({ model: "other", api_key: "private-new" })).toThrow(
      /先保存/,
    );
    expect(() =>
      f.preview({ model_provider: "other", api_key: "private-new" }),
    ).toThrow(/先保存/);
    const preview = f.preview({
      model_id: "new",
      api_key: "private-new",
      thinking: true,
    });
    expect(JSON.stringify(preview)).not.toContain("private-new");
    f.service.apply(f.profile.id, preview.previewId);
    const text = readFileSync(f.target.path, "utf8");
    expect(text).toContain("# keep");
    expect(parseNativeConfig(text, true)).toMatchObject({
      thinking: { enabled: true },
      models: { local: { model: "new" } },
      providers: { local: { api_key: "private-new", type: "openai_legacy" } },
    });
  });
  it("updates Droid custom-model credentials without exposing or dropping other providers", () => {
    const f = fixture(
      "droid",
      JSON.stringify({
        customModels: [
          {
            model: "old",
            displayName: "local",
            apiKey: "private-old",
            baseUrl: "https://example.test/v1",
            provider: "generic-chat-completion-api",
          },
        ],
        telemetry: false,
      }),
    );
    expect(JSON.stringify(f.service.documents(f.profile.id))).not.toContain(
      "private-old",
    );
    const p = f.preview({
      custom_0_model: "new",
      custom_0_api_key: "private-new",
    });
    expect(JSON.stringify(p)).not.toContain("private-new");
    f.service.apply(f.profile.id, p.previewId);
    expect(
      parseNativeConfig(readFileSync(f.target.path, "utf8"), false),
    ).toMatchObject({
      customModels: [
        {
          model: "new",
          apiKey: "private-new",
          provider: "generic-chat-completion-api",
        },
      ],
      telemetry: false,
    });
  });
  it.each(["gemini", "copilot"] as const)(
    "uses the documented %s config path and model key",
    (tool) => {
      const f = fixture(tool);
      f.service.apply(
        f.profile.id,
        f.preview({ model: "new-model" }).previewId,
      );
      expect(f.target.path).toMatch(
        tool === "gemini" ? /settings\.json$/ : /config\.json$/,
      );
      expect(
        parseNativeConfig(readFileSync(f.target.path, "utf8"), false),
      ).toMatchObject(
        tool === "gemini"
          ? { model: { name: "new-model" } }
          : { model: "new-model" },
      );
    },
  );
  it("reads and edits Claude env models at their original paths without losing other settings", () => {
    const original = {
      env: {
        ANTHROPIC_MODEL: "env-model",
        ANTHROPIC_AUTH_TOKEN: "private-token",
        ANTHROPIC_BASE_URL: "https://example.test",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "mapped-sonnet",
        CUSTOM_FLAG: "keep",
      },
      permissions: { allow: ["Read"] },
      enabledPlugins: { local: true },
    };
    const f = fixture("claude", JSON.stringify(original));
    const document = f.service.documents(f.profile.id)[0]!;
    expect(document.fields.find((field) => field.id === "model")?.value).toBe(
      "env-model",
    );
    expect(
      document.fields.find((field) => field.id === "sonnet_model")?.value,
    ).toBe("mapped-sonnet");
    expect(JSON.stringify(document)).not.toContain("private-token");
    f.service.apply(
      f.profile.id,
      f.preview({ model: "updated-env", sonnet_model: "updated-sonnet" })
        .previewId,
    );
    const saved = JSON.parse(readFileSync(f.target.path, "utf8"));
    expect(saved.model).toBeUndefined();
    expect(saved).toEqual({
      ...original,
      env: {
        ...original.env,
        ANTHROPIC_MODEL: "updated-env",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "updated-sonnet",
      },
    });
  });
  it("keeps Claude top-level and environment model selections independent when both exist", () => {
    const f = fixture(
      "claude",
      JSON.stringify({
        model: "sonnet",
        env: { ANTHROPIC_MODEL: "custom-model" },
      }),
    );
    const fields = f.service.documents(f.profile.id)[0]!.fields;
    expect(fields.find((field) => field.id === "model")?.value).toBe(
      "custom-model",
    );
    expect(fields.find((field) => field.id === "settings_model")?.value).toBe(
      "sonnet",
    );
    f.service.apply(
      f.profile.id,
      f.preview({ settings_model: "opus", model: "new-custom" }).previewId,
    );
    expect(JSON.parse(readFileSync(f.target.path, "utf8"))).toEqual({
      model: "opus",
      env: { ANTHROPIC_MODEL: "new-custom" },
    });
  });
  it("writes the selected Codex file, preserves unknown TOML and comments, and restores a protected backup", () => {
    const original =
      '# User comment\r\nmodel = "old" # keep inline\r\n[projects."C:/示例"]\r\ntrust_level = "trusted"\r\nnote = """\r\n[multiline content]\r\n"""\r\n';
    const f = fixture("codex", original);
    const preview = f.preview({ model: "new" });
    expect(readFileSync(f.target.path, "utf8")).toBe(original);
    const applied = f.service.apply(f.profile.id, preview.previewId);
    expect(readFileSync(f.target.path, "utf8")).toBe(
      original.replace('model = "old"', 'model = "new"'),
    );
    expect(readFileSync(applied.backup.path, "utf8")).toBe(original);
    expect(f.service.backups(f.profile.id)).toHaveLength(1);
    f.service.restore(f.profile.id, applied.backup.id);
    expect(readFileSync(f.target.path, "utf8")).toBe(original);
    expect(f.service.backups(f.profile.id)[0]?.restoredAt).toBeTruthy();
  });
  it("adds root values before tables and edits an existing provider section without rewriting other content", () => {
    const f = fixture(
      "codex",
      'model_provider = "custom"\n# provider\n[model_providers.custom]\nname = "Work" # keep\n[other]\nflag = true\n',
    );
    const p = f.preview({
      model: "new-model",
      provider_base_url: "https://example.test/v1",
    });
    f.service.apply(f.profile.id, p.previewId);
    const text = readFileSync(f.target.path, "utf8");
    expect(parseNativeConfig(text, true)).toMatchObject({
      model: "new-model",
      model_providers: {
        custom: { base_url: "https://example.test/v1", name: "Work" },
      },
      other: { flag: true },
    });
    expect(text).toContain("# provider\n");
    expect(text).toContain('name = "Work" # keep\n');
  });
  it("detects edits both before preview and after preview and never overwrites them", () => {
    const f = fixture("codex", 'model = "a"\n');
    const originalFingerprint = f.service.documents(f.profile.id)[0]!
      .fingerprint;
    const p = f.preview({ model: "b" });
    writeFileSync(f.target.path, 'model = "external"\n');
    expect(() => f.preview({ model: "c" }, originalFingerprint)).toThrow(
      /外部修改/,
    );
    expect(() => f.service.apply(f.profile.id, p.previewId)).toThrow(
      /外部修改/,
    );
    expect(readFileSync(f.target.path, "utf8")).toContain("external");
    expect(f.service.backups(f.profile.id)).toHaveLength(0);
  });
  it("prevents restoring an older backup over subsequent external edits", () => {
    const f = fixture("codex", 'model = "old"\n');
    const applied = f.service.apply(
      f.profile.id,
      f.preview({ model: "new" }).previewId,
    );
    writeFileSync(f.target.path, 'model = "external"\n');
    expect(() => f.service.restore(f.profile.id, applied.backup.id)).toThrow(
      /后续修改/,
    );
    expect(readFileSync(f.target.path, "utf8")).toContain("external");
  });
  it("keeps secret values out of reads, previews and database records, while preserving JSONC unknowns", () => {
    const f = fixture(
      "claude",
      '{\n// keep\n"model":"old", "env":{"ANTHROPIC_API_KEY":"private-old"}, "unknown":{"keep":true},\n}\n',
    );
    expect(JSON.stringify(f.service.documents(f.profile.id))).not.toContain(
      "private-old",
    );
    const preview = f.preview({ api_key: "private-new" });
    expect(JSON.stringify(preview)).not.toContain("private-");
    const applied = f.service.apply(f.profile.id, preview.previewId);
    const saved = readFileSync(f.target.path, "utf8");
    expect(saved).toContain("private-new");
    expect(saved).toContain("// keep");
    expect(saved).toContain('"unknown":{"keep":true}');
    expect(JSON.stringify(f.service.documents(f.profile.id))).not.toContain(
      "private-new",
    );
    for (const table of ["tool_config_profiles", "tool_config_backups"])
      expect(
        JSON.stringify(f.database.prepare(`SELECT * FROM ${table}`).all()),
      ).not.toContain("private-");
    expect(() => f.service.apply(f.profile.id, preview.previewId)).toThrow(
      /失效/,
    );
    expect(readFileSync(applied.backup.path, "utf8")).toContain("private-old");
  });
  it("creates and removes a previously absent native file when applying and restoring", () => {
    const f = fixture("codex");
    expect(existsSync(f.target.path)).toBe(false);
    const applied = f.service.apply(
      f.profile.id,
      f.preview({ model: "test" }).previewId,
    );
    expect(
      parseNativeConfig(readFileSync(f.target.path, "utf8"), true).model,
    ).toBe("test");
    expect(
      f.database
        .prepare("SELECT existed FROM tool_config_backups WHERE id = ?")
        .get(applied.backup.id),
    ).toMatchObject({ existed: 0 });
    f.service.restore(f.profile.id, applied.backup.id);
    expect(existsSync(f.target.path)).toBe(false);
  });
  it("uses fixed project targets and validates known fields instead of accepting arbitrary paths", () => {
    const f = fixture("codex");
    const documents = f.service.documents(f.profile.id);
    expect(documents.find((doc) => doc.id === "project")?.path).toBe(
      join(f.directory, ".codex", "config.toml"),
    );
    expect(() => f.preview({ "__proto__.polluted": "true" })).toThrow(/不支持/);
    expect(() => f.preview({ approval_policy: "made-up" })).toThrow(/不合法/);
    expect(() =>
      f.preview({
        provider_base_url: "https://secret:password@example.test/v1",
      }),
    ).toThrow(/API 地址/);
    expect(() =>
      f.service.preview(f.profile.id, {
        documentId: "../../secret",
        expectedFingerprint: "missing",
        values: { model: "test" },
      }),
    ).toThrow(/不支持/);
  });
  it("never exposes credentials embedded in an existing service URL", () => {
    const f = fixture(
      "claude",
      '{"env":{"ANTHROPIC_BASE_URL":"https://user:secret@example.test/?key=hidden"}}',
    );
    expect(JSON.stringify(f.service.documents(f.profile.id))).not.toMatch(
      /user:secret|key=hidden/,
    );
    expect(
      JSON.stringify(f.preview({ base_url: "https://example.test/" })),
    ).not.toMatch(/user:secret|key=hidden/);
  });
  it("blocks malformed source files without returning parser snippets containing secrets", () => {
    const f = fixture(
      "claude",
      '{"env":{"ANTHROPIC_API_KEY":"private-secret"}, INVALID',
    );
    const documents = f.service.documents(f.profile.id);
    expect(documents[0]?.fields).toEqual([]);
    expect(JSON.stringify(documents)).not.toContain("private-secret");
    expect(() => f.preview({ model: "test" })).toThrow(/格式无效/);
    expect(readFileSync(f.target.path, "utf8")).toContain("private-secret");
  });
  it("does not follow a newly replaced configuration directory junction", () => {
    const f = fixture("codex");
    const redirect = join(f.directory, "redirect");
    mkdirSync(redirect);
    const subdir = join(f.profile.configRoot, ".codex");
    symlinkSync(
      redirect,
      subdir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const project = f.service.createProfile({
      installationId: f.profile.installationId,
      name: "redirect",
      configRoot: f.profile.configRoot,
      workspacePath: f.profile.configRoot,
    });
    expect(() => f.service.documents(project.id)).toThrow(/符号链接|目录联接/);
  });
  it.each(["qwen", "mimo", "opencode", "zcode"] as const)(
    "updates the documented %s native model field",
    (tool) => {
      const f = fixture(tool);
      const applied = f.service.apply(
        f.profile.id,
        f.preview({ model: "native-model" }).previewId,
      );
      const value = parseNativeConfig(
        readFileSync(f.target.path, "utf8"),
        false,
      );
      if (tool === "qwen")
        expect(value).toMatchObject({ model: { name: "native-model" } });
      else if (tool === "zcode")
        expect(value).toMatchObject({
          schemaVersion: 1,
          config: { defaultModelSelection: { modelId: "native-model" } },
        });
      else expect(value.model).toBe("native-model");
      expect(applied.backup.canRestore).toBe(true);
    },
  );
  it("treats numeric JSON provider IDs as object keys, while preserving arrays", () => {
    const result = updateNativeConfig(
      '{"provider":{"123":{"options":{"apiKey":"old"}}}}',
      false,
      [
        {
          field: {
            id: "key",
            label: "key",
            path: ["provider", "123", "options", "apiKey"],
          },
          value: "new",
        },
      ],
    );
    expect(JSON.parse(result).provider["123"].options.apiKey).toBe("new");
  });
  it("does not change configuration while native work is running or unresolved", () => {
    const f = fixture("codex", 'model = "old"\n');
    const preview = f.preview({ model: "new" });
    f.send();
    f.database.prepare("UPDATE message_deliveries SET state = 'unknown'").run();
    expect(() => f.service.apply(f.profile.id, preview.previewId)).toThrow(
      /执行中或待核对/,
    );
    expect(readFileSync(f.target.path, "utf8")).toContain('"old"');
  });
  it("rechecks a changed JSON/JSONC source after preview", () => {
    const f = fixture("opencode");
    const preview = f.preview({ model: "new" });
    writeFileSync(f.target.path + "c", '{"model":"external"}');
    expect(() => f.service.apply(f.profile.id, preview.previewId)).toThrow(
      /来源/,
    );
    expect(existsSync(f.target.path)).toBe(false);
  });
  it("preserves a UTF-8 BOM in the native file and in its exact backup", () => {
    const original = '\uFEFF# BOM\nmodel = "old"\n';
    const f = fixture("codex", original);
    const applied = f.service.apply(
      f.profile.id,
      f.preview({ model: "new" }).previewId,
    );
    expect(readFileSync(f.target.path, "utf8")).toBe(
      original.replace('"old"', '"new"'),
    );
    expect(readFileSync(applied.backup.path, "utf8")).toBe(original);
  });
  it("can configure a new ZCode OpenAI-compatible provider without copying native credentials", () => {
    const f = fixture("zcode");
    f.service.apply(
      f.profile.id,
      f.preview({ provider: "work", model: "work-model" }).previewId,
    );
    const preview = f.preview({
      base_url: "https://example.test/v1",
      api_key: "new-private-key",
    });
    expect(JSON.stringify(preview)).not.toContain("new-private-key");
    f.service.apply(f.profile.id, preview.previewId);
    expect(
      parseNativeConfig(readFileSync(f.target.path, "utf8"), false),
    ).toMatchObject({
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "work",
              config: {
                api: {
                  type: "openai-chat-completions",
                  baseUrl: "https://example.test/v1",
                },
                access: { type: "api-key", apiKey: "new-private-key" },
                personalModelIds: ["work-model"],
              },
            },
          ],
        },
      },
    });
  });
  it.each(["mimo", "opencode"] as const)(
    "configures a new %s compatible provider through native fields",
    (tool) => {
      const f = fixture(tool);
      f.service.apply(
        f.profile.id,
        f.preview({ model: "work/native-model" }).previewId,
      );
      f.service.apply(
        f.profile.id,
        f.preview({
          provider_name: "Work",
          provider_npm: "@ai-sdk/openai-compatible",
          provider_model_name: "Native Model",
          base_url: "https://example.test/v1",
          api_key: "private",
        }).previewId,
      );
      expect(
        parseNativeConfig(readFileSync(f.target.path, "utf8"), false),
      ).toMatchObject({
        provider: {
          work: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "private" },
            models: { "native-model": { name: "Native Model" } },
          },
        },
      });
    },
  );
});
