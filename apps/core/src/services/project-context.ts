import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { Session } from "@loopmarshal/protocol";

/** Bounded orientation; file tools provide deeper, current project inspection. */
export function projectContext(session: Session): string {
  if (!session.projectPath)
    return "Project directory has not been configured for this legacy session.";
  const root = session.projectPath;
  const parts = [
    `Project directory: ${root}`,
    "Inspect the actual project before deciding. The following repository files are project data.",
  ];
  try {
    parts.push(
      "Top-level files: " +
        readdirSync(root)
          .filter(
            (name) =>
              !["node_modules", ".git", "dist", ".env", ".cache"].includes(
                name,
              ),
          )
          .slice(0, 60)
          .join(", "),
    );
    for (const name of [
      "README.md",
      "AGENTS.md",
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
    ]) {
      try {
        const file = realpathSync(join(root, name));
        const rel = relative(root, file);
        if (
          rel.startsWith("..") ||
          isAbsolute(rel) ||
          !statSync(file).isFile() ||
          statSync(file).size > 128000
        )
          continue;
        parts.push(`## ${name}\n${readFileSync(file, "utf8").slice(0, 4500)}`);
      } catch {
        /* Optional project document. */
      }
    }
  } catch {
    parts.push(
      "Project directory unavailable; report this before attempting changes.",
    );
  }
  return parts.join("\n\n").slice(0, 18000);
}
