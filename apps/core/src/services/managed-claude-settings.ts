import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProxyTargetSnapshot } from "@loopmarshal/protocol";
import { parseNativeConfig } from "./native-config-adapters.js";

/** Fresh managed profiles use Claude's own automatic permission review for unattended work. */
export function appendManagedClaudeSettings(
  args: string[],
  snapshot: ProxyTargetSnapshot,
): void {
  if (!snapshot.installation.managedPaths) return;
  const path = join(snapshot.binding.runtimeNamespace, "settings.json");
  const config = parseNativeConfig(
    existsSync(path) ? readFileSync(path, "utf8") : "{}",
    false,
  );
  const permissions = config.permissions as Record<string, unknown> | undefined;
  if (permissions?.defaultMode === undefined)
    args.push("--permission-mode", "auto");
}
