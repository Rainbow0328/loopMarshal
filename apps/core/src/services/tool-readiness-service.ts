import { dirname } from "node:path";
import type {
  ToolAvailability,
  ToolCheckResult,
  ToolInstallation,
} from "@loopmarshal/protocol";
import { toolAvailability } from "@loopmarshal/protocol";
import { installationCompatibility } from "./tool-compatibility-service.js";
import {
  proxyEnvironment,
  resolveToolExecutable,
  runProxyProcess,
} from "./proxy-process.js";

/** Checks startup and configuration, never sends a model prompt or creates a session. */
export async function checkToolReadiness(
  installation: ToolInstallation,
  configCheck: () => void,
  endpoint?: string,
): Promise<ToolCheckResult> {
  const result = (
    availability: ToolAvailability,
    version: string | null = null,
  ): ToolCheckResult => ({
    availability,
    checkedAt: new Date().toISOString(),
    version,
  });
  const compatibility = installationCompatibility(installation);
  const entry = toolAvailability(compatibility);
  if (entry.status === "unavailable") return result(entry);
  try {
    configCheck();
  } catch {
    return result({
      status: "unavailable",
      reason: "工具配置无法读取或格式有误。",
      action: "在工具配置中检查文件内容，保存后重新校验。",
    });
  }
  let version: string | null = null;
  try {
    // Fixed execution flags belong to a task, not the startup/configuration check.
    const executable = resolveToolExecutable({
      ...installation,
      executableArgs: [],
    });
    const env = proxyEnvironment(installation);
    // MiMo's official home redirects config, auth, model selection and native history together.
    for (const name of [
      "MIMOCODE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]) {
      if (installation.managedPaths) continue;
      if (process.env[name]) env[name] = process.env[name];
    }
    const capture = async (args: string[]) => {
      const controller = new AbortController();
      let output = "";
      const run = await runProxyProcess(
        {
          ...executable,
          args: [...executable.args, ...args],
          cwd: dirname(installation.executablePath),
          env,
        },
        {
          signal: controller.signal,
          timeoutMs: 15000,
          onLine: (line) => {
            output += line + "\n";
            if (Buffer.byteLength(output) > 1024 * 1024) controller.abort();
          },
        },
      );
      if (run.exitCode !== 0) throw new Error("Tool check failed");
      return output;
    };
    const output = await capture(["--version"]);
    version =
      output.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0] ??
      null;
    if (installation.toolId === "mimo" || installation.toolId === "opencode") {
      // Let the vendor resolve merged config and auth locations; discard its sensitive output.
      const config: unknown = JSON.parse(await capture(["debug", "config"]));
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("Invalid runtime config");
    }
  } catch {
    return result(
      {
        status: "unavailable",
        reason: "工具未能正常启动或读取运行配置。",
        action: "检查工具配置和安装位置，修复后点击重新校验。",
      },
      version,
    );
  }
  const runtime = toolAvailability(
    version
      ? installationCompatibility({ ...installation, version })
      : compatibility,
  );
  if (runtime.status !== "available") return result(runtime, version);
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid endpoint");
      url.pathname = url.pathname.replace(/\/$/, "") + "/global/health";
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      try {
        if (!response.ok)
          return result(
            {
              status: "unavailable",
              reason:
                response.status === 401 || response.status === 403
                  ? "会话服务要求认证，当前连接无法访问。"
                  : `会话服务返回错误（${response.status}）。`,
              action: "检查服务地址和访问设置后重新校验。",
            },
            version,
          );
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No health response");
        let text = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += new TextDecoder().decode(chunk.value);
            if (text.length > 65536) throw new Error("Invalid health response");
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const health: unknown = JSON.parse(text);
        if (
          !health ||
          typeof health !== "object" ||
          !("healthy" in health) ||
          health.healthy !== true
        )
          throw new Error("Not a native session service");
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    } catch {
      return result(
        {
          status: "unavailable",
          reason: "无法连接到该工具的会话服务。",
          action: "确认服务已启动，检查服务地址后重新校验。",
        },
        version,
      );
    }
  }
  return result({ status: "available" }, version);
}
