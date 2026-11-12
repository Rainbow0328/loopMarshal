import {
  applyEdits,
  modify,
  parse as parseJson,
  type ParseError,
} from "jsonc-parser";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import type { ProxyToolId } from "@loopmarshal/protocol";

export type ConfigValue = string | boolean | number | null;
export type ConfigFieldSpec = {
  id: string;
  label: string;
  path: string[];
  secret?: boolean;
  options?: string[];
  kind?: "boolean" | "number";
  description?: string;
};
export function parseNativeConfig(
  text: string,
  toml: boolean,
): Record<string, unknown> {
  text = text.replace(/^\uFEFF/, "");
  if (toml)
    return getStaticTOMLValue(parseTOML(text)) as Record<string, unknown>;
  const errors: ParseError[] = [];
  const value = parseJson(text || "{}", errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (
    errors.length ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    throw new Error("Invalid configuration");
  return value;
}
export function configValueAt(object: unknown, path: string[]): unknown {
  for (const part of path) {
    if (
      !object ||
      typeof object !== "object" ||
      !Object.prototype.hasOwnProperty.call(object, part)
    )
      return undefined;
    object = (object as Record<string, unknown>)[part];
  }
  return object;
}
const field = (
  id: string,
  label: string,
  path = id.split("."),
  rest: Partial<ConfigFieldSpec> = {},
): ConfigFieldSpec => ({ id, label, path, ...rest });
export function nativeConfigFields(
  tool: ProxyToolId,
  value: Record<string, unknown>,
): ConfigFieldSpec[] {
  if (tool === "gemini")
    return [
      field("model", "默认模型", ["model", "name"]),
      field("auth_type", "认证方式", ["security", "auth", "selectedType"], {
        options: ["oauth-personal", "gemini-api-key", "vertex-ai"],
      }),
    ];
  if (tool === "cursor")
    return [
      field("http1", "使用 HTTP/1.1", ["network", "useHttp1ForAgent"], {
        kind: "boolean",
      }),
    ];
  if (tool === "copilot") return [field("model", "默认模型")];
  if (tool === "kimi") {
    const model =
      typeof value.default_model === "string" ? value.default_model : null;
    const provider = model
      ? configValueAt(value, ["models", model, "provider"])
      : null;
    return [
      field("model", "默认模型配置名", ["default_model"]),
      field("thinking", "启用思考", ["thinking", "enabled"], {
        kind: "boolean",
      }),
      ...(model
        ? [
            field("model_id", "模型 ID", ["models", model, "model"]),
            field("model_provider", "模型服务商", [
              "models",
              model,
              "provider",
            ]),
            field("model_protocol", "模型协议", ["models", model, "protocol"], {
              options: ["openai", "openai-responses", "anthropic", "google"],
            }),
          ]
        : []),
      ...(typeof provider === "string"
        ? [
            field("base_url", "API 地址", ["providers", provider, "base_url"]),
            field("api_key", "API 密钥", ["providers", provider, "api_key"], {
              secret: true,
            }),
          ]
        : []),
    ];
  }
  if (tool === "droid") {
    const fields = [field("model", "默认模型")];
    for (const [index, model] of (Array.isArray(value.customModels)
      ? value.customModels
      : []
    ).entries()) {
      if (!model || typeof model !== "object") continue;
      const label = String(model.displayName ?? model.model ?? index + 1);
      fields.push(
        field(`custom_${index}_model`, `${label} · 模型 ID`, [
          "customModels",
          String(index),
          "model",
        ]),
        field(`custom_${index}_base_url`, `${label} · API 地址`, [
          "customModels",
          String(index),
          "baseUrl",
        ]),
        field(
          `custom_${index}_api_key`,
          `${label} · API 密钥`,
          ["customModels", String(index), "apiKey"],
          { secret: true },
        ),
      );
    }
    return fields;
  }
  if (tool === "codex") {
    const provider =
      typeof value.model_provider === "string"
        ? value.model_provider
        : "openai";
    return [
      field("model", "默认模型"),
      field("model_provider", "模型服务商 ID"),
      field("model_reasoning_effort", "推理强度", undefined, {
        options: ["minimal", "low", "medium", "high", "xhigh"],
      }),
      field("approval_policy", "操作批准策略", undefined, {
        options: ["untrusted", "on-request", "never"],
      }),
      field("sandbox_mode", "文件与命令权限", undefined, {
        options: ["read-only", "workspace-write", "danger-full-access"],
      }),
      field("provider_name", "当前服务商名称", [
        "model_providers",
        provider,
        "name",
      ]),
      field("provider_base_url", "当前服务商 API 地址", [
        "model_providers",
        provider,
        "base_url",
      ]),
      field("provider_env_key", "当前服务商密钥环境变量名", [
        "model_providers",
        provider,
        "env_key",
      ]),
      field(
        "provider_api_key",
        "API Key",
        ["model_providers", provider, "experimental_bearer_token"],
        { secret: true },
      ),
      field(
        "provider_requires_openai_auth",
        "使用 Codex 登录",
        ["model_providers", provider, "requires_openai_auth"],
        { kind: "boolean" },
      ),
      field(
        "provider_wire_api",
        "当前服务商 API 协议",
        ["model_providers", provider, "wire_api"],
        { options: ["responses"] },
      ),
    ];
  }
  if (tool === "claude")
    return [
      field(
        "model",
        "默认模型",
        configValueAt(value, ["env", "ANTHROPIC_MODEL"]) !== undefined
          ? ["env", "ANTHROPIC_MODEL"]
          : ["model"],
        {
          description:
            configValueAt(value, ["env", "ANTHROPIC_MODEL"]) !== undefined
              ? "写入 env.ANTHROPIC_MODEL；保留原有的环境变量配置方式。"
              : "写入 settings.json 的 model 字段。",
        },
      ),
      ...(configValueAt(value, ["env", "ANTHROPIC_MODEL"]) !== undefined &&
      value.model !== undefined
        ? [
            field("settings_model", "设置文件中的模型", ["model"], {
              description:
                "这是独立的 model 设置；与上方环境变量模型分别保存，启动参数仍可能覆盖它们。",
            }),
          ]
        : []),
      field("base_url", "API 地址", ["env", "ANTHROPIC_BASE_URL"]),
      field("api_key", "API 密钥", ["env", "ANTHROPIC_API_KEY"], {
        secret: true,
      }),
      field("auth_token", "认证令牌", ["env", "ANTHROPIC_AUTH_TOKEN"], {
        secret: true,
        description: "使用兼容服务时可能配置此项；与 API 密钥分别保存。",
      }),
      field("haiku_model", "Haiku 对应模型", [
        "env",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      ]),
      field("sonnet_model", "Sonnet 对应模型", [
        "env",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
      ]),
      field("opus_model", "Opus 对应模型", [
        "env",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
      ]),
      field("small_fast_model", "快速模型（旧版设置）", [
        "env",
        "ANTHROPIC_SMALL_FAST_MODEL",
      ]),
    ];
  if (tool === "qwen")
    return [
      field("model", "默认模型", ["model", "name"]),
      field("auth_type", "认证类型", ["security", "auth", "selectedType"], {
        options: ["openai", "anthropic", "gemini-api-key", "qwen-oauth"],
      }),
      field("base_url", "API 地址", ["security", "auth", "baseUrl"]),
      field("api_key", "API 密钥", ["security", "auth", "apiKey"], {
        secret: true,
      }),
    ];
  if (tool === "zcode") {
    const fields = [
      field("provider", "默认服务商 ID", [
        "config",
        "defaultModelSelection",
        "providerId",
      ]),
      field("model", "默认模型", [
        "config",
        "defaultModelSelection",
        "modelId",
      ]),
    ];
    const rules = configValueAt(value, [
      "config",
      "providerConfigRules",
      "providerRules",
    ]);
    const selected = configValueAt(value, fields[0]!.path);
    if (typeof selected === "string" && selected) {
      const existingIndex = Array.isArray(rules)
        ? rules.findIndex((item) => item?.providerId === selected)
        : -1;
      const index =
        existingIndex >= 0
          ? existingIndex
          : Array.isArray(rules)
            ? rules.length
            : 0;
      fields.push(
        field("base_url", "当前服务商 API 地址", [
          "config",
          "providerConfigRules",
          "providerRules",
          String(index),
          "config",
          "api",
          "baseUrl",
        ]),
        field(
          "api_key",
          "当前服务商 API 密钥",
          [
            "config",
            "providerConfigRules",
            "providerRules",
            String(index),
            "config",
            "access",
            "apiKey",
          ],
          { secret: true },
        ),
      );
    }
    return fields;
  }
  const fields = [
    field("model", "默认模型（服务商/模型）"),
    field("small_model", "轻量模型（服务商/模型）"),
  ];
  const provider =
    typeof value.model === "string" ? value.model.split("/")[0] : null;
  const modelId =
    typeof value.model === "string"
      ? value.model.slice(value.model.indexOf("/") + 1)
      : null;
  if (provider)
    fields.push(
      field("provider_name", "当前服务商名称", ["provider", provider, "name"]),
      field(
        "provider_npm",
        "当前服务商 SDK 包（自定义 OpenAI 兼容服务：@ai-sdk/openai-compatible）",
        ["provider", provider, "npm"],
      ),
      field("base_url", "当前服务商 API 地址", [
        "provider",
        provider,
        "options",
        "baseURL",
      ]),
      field(
        "api_key",
        "当前服务商 API 密钥",
        ["provider", provider, "options", "apiKey"],
        { secret: true },
      ),
    );
  if (provider && modelId)
    fields.push(
      field("provider_model_name", "当前服务商中的模型名称", [
        "provider",
        provider,
        "models",
        modelId,
        "name",
      ]),
    );
  return fields;
}

export function prepareNativeConfig(
  tool: ProxyToolId,
  text: string,
  fields: ConfigFieldSpec[],
): string {
  if (tool !== "zcode") return text;
  const value = parseNativeConfig(text, false);
  const providerId = configValueAt(value, [
    "config",
    "defaultModelSelection",
    "providerId",
  ]);
  if (
    typeof providerId !== "string" ||
    !fields.some((field) => ["api_key", "base_url"].includes(field.id))
  )
    return text;
  const path = ["config", "providerConfigRules", "providerRules"];
  const existing = configValueAt(value, path);
  if (existing !== undefined && !Array.isArray(existing))
    throw new Error("Unsupported provider rules");
  const rules = Array.isArray(existing) ? existing : [];
  if (rules.some((rule) => rule?.providerId === providerId)) return text;
  const modelId = configValueAt(value, [
    "config",
    "defaultModelSelection",
    "modelId",
  ]);
  if (typeof modelId !== "string" || !modelId)
    throw new Error("Choose a default model before configuring the provider");
  const rule = {
    providerId,
    providerName: providerId,
    config: {
      group: "standard-personal",
      access: { type: "api-key" },
      api: { type: "openai-chat-completions" },
      personalModelIds: [modelId],
    },
  };
  return applyEdits(
    text,
    modify(text, path, [...rules, rule], {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
}

/** Edit syntax ranges only. Unknown keys, comments, multiline strings and tables retain their bytes. */
function editToml(text: string, path: string[], value: ConfigValue): string {
  const ast = parseTOML(text);
  const root = ast.body[0];
  const keyParts = (keys: { type: string; name?: string; value?: string }[]) =>
    keys.map((key) => (key.type === "TOMLBare" ? key.name! : key.value!));
  for (const node of root.body) {
    const entries = node.type === "TOMLTable" ? node.body : [node];
    for (const entry of entries) {
      const resolved = [
        ...(node.type === "TOMLTable" ? node.resolvedKey : []),
        ...keyParts(entry.key.keys),
      ];
      if (JSON.stringify(resolved) !== JSON.stringify(path)) continue;
      const [start, end] = value === null ? entry.range : entry.value.range;
      return (
        text.slice(0, start) +
        (value === null ? "" : JSON.stringify(value)) +
        text.slice(end)
      );
    }
  }
  if (value === null) return text;
  // Root dotted keys safely create missing tables; conflicting inline tables are rejected by reparsing.
  const firstTable = root.body.find((node) => node.type === "TOMLTable");
  const position = firstTable?.range[0] ?? text.length;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const insertion = `${position && !text.slice(0, position).endsWith("\n") ? eol : ""}${path.map((part) => JSON.stringify(part)).join(".")} = ${JSON.stringify(value)}${eol}`;
  // For nested existing tables append inside that table instead of redefining it with dotted root keys.
  const parent = root.body.find(
    (node) =>
      node.type === "TOMLTable" &&
      JSON.stringify(node.resolvedKey) === JSON.stringify(path.slice(0, -1)),
  );
  if (parent?.type === "TOMLTable") {
    const end = parent.body.at(-1)?.range[1] ?? parent.range[1];
    const lineEnd = text.indexOf("\n", end);
    const offset = lineEnd < 0 ? text.length : lineEnd + 1;
    return (
      text.slice(0, offset) +
      `${offset && !text.slice(0, offset).endsWith("\n") ? eol : ""}${JSON.stringify(path.at(-1))} = ${JSON.stringify(value)}${eol}` +
      text.slice(offset)
    );
  }
  return text.slice(0, position) + insertion + text.slice(position);
}
export function updateNativeConfig(
  text: string,
  toml: boolean,
  changes: { field: ConfigFieldSpec; value: ConfigValue }[],
): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  text = text.replace(/^\uFEFF/, "");
  for (const { field, value } of changes) {
    const object = parseNativeConfig(text, toml);
    const path = field.path.map((part, index) =>
      Array.isArray(configValueAt(object, field.path.slice(0, index))) &&
      /^\d+$/.test(part)
        ? Number(part)
        : part,
    );
    text = toml
      ? editToml(text, field.path, value)
      : applyEdits(
          text || "{}\n",
          modify(text || "{}\n", path, value === null ? undefined : value, {
            formattingOptions: {
              insertSpaces: true,
              tabSize: 2,
              eol: text.includes("\r\n") ? "\r\n" : "\n",
            },
          }),
        );
  }
  parseNativeConfig(text, toml);
  return bom + text;
}
