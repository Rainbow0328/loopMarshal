import {
  toolCompatibility,
  type ToolInstallation,
  type ToolCompatibility,
} from "@loopmarshal/protocol";
import { resolveToolExecutable } from "./proxy-process.js";

/** Scanning only inspects files; it never starts a model or executes a launcher. */
export function installationCompatibility(
  installation: ToolInstallation,
): ToolCompatibility {
  const result = toolCompatibility(
    installation.toolId,
    installation.version,
    installation.executableArgs,
  );
  try {
    resolveToolExecutable(installation);
  } catch (error) {
    return {
      ...result,
      status: "unavailable",
      label: "当前不可用",
      summary: "工具入口失效或暂不支持。",
      issues: [
        {
          code: "invalid_launcher",
          severity: "error",
          message:
            error instanceof Error ? error.message : "无法读取工具入口。",
          action: "修复原工具安装后重新扫描，或手动选择实际可执行文件。",
        },
        ...result.issues,
      ],
    };
  }
  return result;
}
