import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";

export function readCoreManagementToken(
  databasePath = loadConfig().core.databasePath,
): string | null {
  if (process.env.LOOPMARSHAL_MANAGEMENT_TOKEN)
    return process.env.LOOPMARSHAL_MANAGEMENT_TOKEN;
  try {
    return (
      readFileSync(`${databasePath}.management-token`, "utf8").trim() || null
    );
  } catch {
    return null;
  }
}

export function ensureCoreManagementToken(databasePath: string): string {
  const existing = readCoreManagementToken(databasePath);
  if (existing) return existing;
  mkdirSync(dirname(databasePath), { recursive: true });
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(`${databasePath}.management-token`, token, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    const raced = readCoreManagementToken(databasePath);
    if (raced) return raced;
    throw error;
  }
  return token;
}
