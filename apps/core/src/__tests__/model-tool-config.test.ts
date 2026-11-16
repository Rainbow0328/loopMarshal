import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProxyFixture } from "./proxy-fixture.js";
import { ToolConfigService } from "../services/tool-config-service.js";
import { parseNativeConfig } from "../services/native-config-adapters.js";
import { prepareModelToolConfig } from "../services/model-tool-config.js";
import type { ModelConfigWithSecret } from "@loopmarshal/store";

const model: ModelConfigWithSecret = {
  id: "test",
  name: "Test",
  provider: "openai",
  modelId: "test-model",
  modelName: "test-model",
  apiKey: "private-model-key",
  apiKeyEncrypted: "private-model-key",
  baseUrl: "https://example.test/v1",
  contextWindowTokens: 10000,
  maxOutputTokens: 1000,
  contextReserveTokens: 1000,
  timeoutSeconds: 60,
  createdAt: "now",
  updatedAt: "now",
};
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
describe("importing saved models into native configurations", () => {
  it("previews without credentials, protects external changes, backs up and restores exact files", () => {
    const f = createProxyFixture();
    cleanups.push(f.close);
    const service = new ToolConfigService(
      f.database,
      f.routeService,
      join(f.directory, "test.sqlite"),
    );
    const root = join(f.directory, "profile");
    mkdirSync(root);
    const profile = service.createProfile({
      installationId: f.proxy.installation!.id,
      configRoot: root,
      name: "profile",
    });
    const file = join(root, "config.toml");
    const original =
      '# preserve this comment\nmodel="old"\n[unrelated]\nkeep=true\n';
    writeFileSync(file, original);
    const getPreview = () =>
      service.previewModel(
        profile.id,
        service.documents(profile.id)[0]!.fingerprint,
        model,
        true,
      );
    const preview = getPreview();
    expect(JSON.stringify(preview)).not.toContain("private-model-key");
    expect(readFileSync(file, "utf8")).toBe(original);
    writeFileSync(file, original + "external=true\n");
    expect(() => service.apply(profile.id, preview.previewId)).toThrow(
      /外部修改/,
    );
    writeFileSync(file, original);
    const saved = service.apply(profile.id, getPreview().previewId);
    expect(parseNativeConfig(readFileSync(file, "utf8"), true)).toMatchObject({
      model: "test-model",
      unrelated: { keep: true },
    });
    expect(readFileSync(file, "utf8")).toContain("private-model-key");
    expect(JSON.stringify(service.documents(profile.id))).not.toContain(
      "private-model-key",
    );
    service.restore(profile.id, saved.backup.id);
    expect(readFileSync(file, "utf8")).toBe(original);
  });
  it("rejects incompatible protocols and requires explicit Responses confirmation", () => {
    expect(() => prepareModelToolConfig("codex", "", model)).toThrow(
      /Responses/,
    );
    expect(() => prepareModelToolConfig("claude", "{}", model)).toThrow(
      /Anthropic/,
    );
    expect(() => prepareModelToolConfig("gemini", "{}", model)).toThrow(
      /Gemini/,
    );
    expect(() =>
      prepareModelToolConfig(
        "codex",
        "",
        { ...model, provider: "anthropic" },
        true,
      ),
    ).toThrow(/Responses/);
    expect(() =>
      prepareModelToolConfig("qwen", "{}", { ...model, apiKeyEncrypted: null }),
    ).toThrow(/API Key/);
  });
  it("keeps unrelated Claude settings and selects the correct Qwen protocol", () => {
    const anthropic = { ...model, provider: "anthropic" };
    const claude = prepareModelToolConfig(
      "claude",
      '{"env":{"ANTHROPIC_AUTH_TOKEN":"old","CUSTOM":"keep"},"permissions":{"deny":["Bash"]}}',
      anthropic,
    );
    expect(parseNativeConfig(claude.text, false)).toMatchObject({
      env: { ANTHROPIC_API_KEY: "private-model-key", CUSTOM: "keep" },
      model: "test-model",
      permissions: { deny: ["Bash"] },
    });
    expect(claude.text).not.toContain('"old"');
    const qwen = prepareModelToolConfig("qwen", "{}", anthropic);
    expect(parseNativeConfig(qwen.text, false)).toMatchObject({
      security: {
        auth: { selectedType: "anthropic", apiKey: "private-model-key" },
      },
      model: { name: "test-model" },
    });
    expect(JSON.stringify(qwen.changes)).not.toContain("private-model-key");
  });
});
