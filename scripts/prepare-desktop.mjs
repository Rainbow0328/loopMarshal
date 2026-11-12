import { cp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(repo, "apps", "desktop");
const staging = join(desktop, "staging");
const cache = join(repo, ".cache", "desktop");
const nodeVersion = "24.14.0";
const nodeArchiveSha256 =
  "313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66";
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("This packaging target currently requires Windows x64.");
async function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      windowsHide: true,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? done() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
await mkdir(cache, { recursive: true });
const archivePath = join(cache, `node-v${nodeVersion}-win-x64.zip`);
let archive;
try {
  archive = await readFile(archivePath);
} catch {
  const response = await fetch(
    `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok)
    throw new Error(`Node runtime download failed (${response.status})`);
  archive = Buffer.from(await response.arrayBuffer());
}
if (createHash("sha256").update(archive).digest("hex") !== nodeArchiveSha256)
  throw new Error(
    "Node runtime integrity check failed. Remove its cached archive and retry.",
  );
await writeFile(archivePath, archive);
// The fixed staging root is generated only; never copy user databases, logs or vendor credentials.
if (resolve(staging) !== join(repo, "apps", "desktop", "staging"))
  throw new Error("Unexpected staging path");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const runtime = join(staging, "runtime");
await mkdir(runtime);
await run(
  process.env.SystemRoot
    ? join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(desktop, "build", "extract-node-runtime.ps1"),
    "-ArchivePath",
    archivePath,
    "-OutputDirectory",
    runtime,
    "-NodeVersion",
    nodeVersion,
  ],
);
await access(join(runtime, "node.exe"));
await run(process.env.ComSpec || "cmd.exe", [
  "/d",
  "/s",
  "/c",
  "pnpm --filter ./apps/cli deploy --prod --config.node-linker=hoisted apps/desktop/staging/app",
]);
await cp(join(repo, "apps", "web", "dist"), join(staging, "web"), {
  recursive: true,
});
for (const file of ["core-host.mjs", "cli-wrapper.mjs"])
  await cp(join(desktop, "src", file), join(staging, file));
await run(
  process.env.SystemRoot
    ? join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(desktop, "build", "create-icon.ps1"),
  ],
);
await cp(join(repo, "LICENSE"), join(staging, "LOOPMARSHAL-LICENSE"));
await mkdir(join(staging, "bin"));
await writeFile(
  join(staging, "bin", "loopmarshal.cmd"),
  '@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\cli-wrapper.mjs" %*\r\n',
);
await writeFile(
  join(staging, "runtime-manifest.json"),
  JSON.stringify(
    {
      target: "win32-x64",
      nodeVersion,
      nodeSource: `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-win-x64.zip`,
      nodeArchiveSha256,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ staging, nodeVersion, ready: true }));
