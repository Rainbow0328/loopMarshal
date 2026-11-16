import { createHash } from "node:crypto";
import type { ProxyToolId } from "@loopmarshal/protocol";
import type { ModelConfigWithSecret } from "@loopmarshal/store";
import { coreErrors } from "../errors.js";
import {
  configValueAt,
  nativeConfigFields,
  parseNativeConfig,
  updateNativeConfig,
  type ConfigFieldSpec,
  type ConfigValue,
} from "./native-config-adapters.js";

export function prepareModelToolConfig(
  tool: ProxyToolId,
  before: string,
  model: ModelConfigWithSecret,
  responsesConfirmed = false,
) {
  const anthropic = model.provider === "anthropic";
  if (tool === "gemini")
    throw coreErrors.invalidInput(
      "Gemini CLI 使用原生 Gemini 认证，不能直接使用 OpenAI/Anthropic 模型配置。可先安装，再通过工具配置选择官方登录或 Gemini API Key。",
    );
  if (!["codex", "claude", "qwen", "opencode", "mimo"].includes(tool))
    throw coreErrors.invalidInput(
      "此工具暂不支持从模型配置导入，请在工具配置中设置。",
    );
  if (tool === "claude" && !anthropic)
    throw coreErrors.invalidInput(
      "Claude Code 需要 Anthropic Messages 协议，不能直接使用 OpenAI Chat Completions 配置。",
    );
  if (tool === "codex" && (anthropic || !responsesConfirmed))
    throw coreErrors.invalidInput(
      "Codex 需要 Responses 协议。请确认所选服务支持 Responses；仅兼容 Chat Completions 不足以使用 Codex。",
    );
  if (!model.apiKeyEncrypted)
    throw coreErrors.invalidInput(
      "所选模型没有可用的 API Key，请先配置模型或启动环境变量。",
    );
  try {
    const url = new URL(model.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw coreErrors.invalidInput("模型 API 地址不是有效的 HTTP(S) 服务地址。");
  }
  const toml = tool === "codex";
  const original = parseNativeConfig(before, toml);
  let text = before;
  const changes: Array<{ field: ConfigFieldSpec; value: ConfigValue }> = [];
  const put = (
    id: string,
    path: string[],
    value: ConfigValue,
    secret = false,
  ) => changes.push({ field: { id, label: id, path, secret }, value });
  const provider = `loopmarshal_${createHash("sha256").update(model.id).digest("hex").slice(0, 12)}`;
  if (tool === "codex") {
    put("model", ["model"], model.modelId);
    put("model_provider", ["model_provider"], provider);
    for (const [key, value] of Object.entries({
      name: model.name,
      base_url: model.baseUrl,
      wire_api: "responses",
      experimental_bearer_token: model.apiKeyEncrypted,
      requires_openai_auth: false,
    }))
      put(
        key,
        ["model_providers", provider, key],
        value,
        key === "experimental_bearer_token",
      );
    put("env_key", ["model_providers", provider, "env_key"], null);
  } else if (tool === "opencode" || tool === "mimo") {
    put("model", ["model"], `${provider}/${model.modelId}`);
    put("provider_name", ["provider", provider, "name"], model.name);
    put(
      "provider_npm",
      ["provider", provider, "npm"],
      anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
    );
    put(
      "base_url",
      ["provider", provider, "options", "baseURL"],
      model.baseUrl,
    );
    put(
      "api_key",
      ["provider", provider, "options", "apiKey"],
      model.apiKeyEncrypted,
      true,
    );
    put(
      "provider_model_name",
      ["provider", provider, "models", model.modelId, "name"],
      model.modelId,
    );
  } else {
    const fields = nativeConfigFields(tool, original);
    const values: Record<string, ConfigValue> = {
      model: model.modelId,
      base_url: model.baseUrl,
      api_key: model.apiKeyEncrypted,
    };
    if (tool === "qwen") values.auth_type = anthropic ? "anthropic" : "openai";
    if (tool === "claude") values.auth_token = null;
    for (const [id, value] of Object.entries(values)) {
      const field = fields.find((entry) => entry.id === id)!;
      changes.push({ field, value });
    }
  }
  text = updateNativeConfig(text, toml, changes);
  const result = parseNativeConfig(text, toml);
  for (const change of changes)
    if ((configValueAt(result, change.field.path) ?? null) !== change.value)
      throw coreErrors.invalidInput("无法安全写入模型配置，原文件未改动。");
  return {
    text,
    changes: changes.map(({ field, value }) => ({
      fieldId: field.id,
      before:
        configValueAt(original, field.path) === undefined ? null : "已配置",
      after: field.secret ? "已更新（隐藏）" : value,
    })),
  };
}
