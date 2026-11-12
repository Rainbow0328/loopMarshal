import { createHash } from "node:crypto";

/** Stable, provider-safe names, including for long MCP tool names. */
export function externalToolName(serverId: string, toolName: string): string {
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `ext_${hash(serverId)}_${toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}_${hash(toolName)}`;
}
