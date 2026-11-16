import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ManagedAgentSetup,
  ProxyTargetSnapshot,
} from "@loopmarshal/protocol";
import { parseNativeConfig } from "./native-config-adapters.js";

/** Scope unattended approval to the role's LoopMarshal tools; keep user execution policies. */
export function appendManagedCodexSettings(
  args: string[],
  snapshot: ProxyTargetSnapshot,
  setup: ManagedAgentSetup,
): void {
  args.push("-c", "features.multi_agent=false");
  const prefix = `mcp_servers.${setup.serverName}`;
  args.push(
    "-c",
    `${prefix}.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `${prefix}.args=${JSON.stringify([setup.bridgePath, "--mcp"])}`,
    "-c",
    `${prefix}.enabled=true`,
    "-c",
    `${prefix}.required=true`,
  );
  for (const tool of setup.tools)
    args.push("-c", `${prefix}.tools.${tool}.approval_mode="approve"`);

  // A newly installed profile otherwise defaults to read-only, with no interactive
  // approval channel. Defaults apply only to our installations and never replace
  // an explicit policy in the user's native configuration.
  if (!snapshot.installation.managedPaths) return;
  const path = join(snapshot.binding.runtimeNamespace, "config.toml");
  const config = parseNativeConfig(
    existsSync(path) ? readFileSync(path, "utf8") : "",
    true,
  );
  if (
    config.sandbox_mode === undefined &&
    config.default_permissions === undefined &&
    config.permissions === undefined
  )
    args.push("-c", 'sandbox_mode="workspace-write"');
  if (config.approval_policy === undefined)
    args.push("-c", 'approval_policy="never"');
  const windows = config.windows as Record<string, unknown> | undefined;
  if (process.platform === "win32" && windows?.sandbox === undefined)
    args.push("-c", 'windows.sandbox="unelevated"');
}
