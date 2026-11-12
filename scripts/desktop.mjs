import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
const requireDesktop = createRequire(join(desktop, "package.json"));
const action = process.argv[2] ?? "dev";
if (!["dev", "dist", "unpacked"].includes(action))
  throw new Error("Use dev, dist or unpacked");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"].includes(
        key.toUpperCase(),
      ),
  ),
);
// pnpm may skip dependency lifecycle scripts; install the pinned Electron binary on demand.
try {
  requireDesktop("electron");
} catch {
  console.log(
    "Downloading the pinned Electron runtime (using its packaged checksums)...",
  );
  await new Promise((done, reject) => {
    const installer = spawn(
      process.execPath,
      [requireDesktop.resolve("electron/install.js")],
      { cwd: root, env, windowsHide: true, stdio: "inherit" },
    );
    installer.once("error", reject);
    installer.once("exit", (code) =>
      code === 0
        ? done()
        : reject(
            new Error(
              "Electron download failed. Check network access or configure ELECTRON_MIRROR and retry.",
            ),
          ),
    );
  });
  requireDesktop("electron");
}
let command;
let args;
if (action === "dev") {
  command = requireDesktop("electron");
  args = [desktop];
} else {
  command = process.execPath;
  args = [
    requireDesktop.resolve("electron-builder/cli.js"),
    "--projectDir",
    desktop,
    "--config",
    join(desktop, "electron-builder.cjs"),
    "--win",
    "--x64",
    ...(action === "unpacked" ? ["--dir"] : []),
  ];
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
}
const child = spawn(command, args, {
  cwd: root,
  env,
  windowsHide: action !== "dev",
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  process.exitCode = code ?? 1;
  if (code !== 0 || action !== "dist") return;
  try {
    // Keep only the current release after a successful build; never accumulate backup folders.
    const output = join(root, "release", "desktop");
    const { version } = JSON.parse(
      await readFile(join(desktop, "package.json"), "utf8"),
    );
    for (const file of await readdir(output, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const installer =
        /^LoopMarshal-Setup-(.+)-x64\.exe(?:\.blockmap|\.sha256)?$/.exec(
          file.name,
        );
      const acceptance = /^acceptance-(.+)\.json$/.exec(file.name);
      const artifactVersion = installer?.[1] ?? acceptance?.[1];
      if (artifactVersion && artifactVersion !== version)
        await unlink(join(output, file.name));
    }
    console.log(`Desktop package updated in ${output}`);
  } catch (error) {
    console.error(
      `Failed to remove outdated desktop artifacts: ${error.message}`,
    );
    process.exitCode = 1;
  }
});
