/*
 * Copyright 2024 Cloud Skill Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(repoRoot, "release", "loopmarshal");
const webDistPath = join(repoRoot, "apps", "web", "dist");

const rootPackage = {
  packageJsonPath: join(repoRoot, "apps", "cli", "package.json"),
};

const bundledPackages = [
  {
    name: "@loopmarshal/core",
    packageJsonPath: join(repoRoot, "apps", "core", "package.json"),
  },
  {
    name: "@loopmarshal/protocol",
    packageJsonPath: join(repoRoot, "packages", "protocol", "package.json"),
  },
  {
    name: "@loopmarshal/shared",
    packageJsonPath: join(repoRoot, "packages", "shared", "package.json"),
  },
  {
    name: "@loopmarshal/sdk",
    packageJsonPath: join(repoRoot, "packages", "sdk", "package.json"),
  },
  {
    name: "@loopmarshal/store",
    packageJsonPath: join(repoRoot, "packages", "store", "package.json"),
  },
];

const readJson = async (path) => {
  return JSON.parse(await readFile(path, "utf8"));
};

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  // Deployed workspace files can be hard links. Replace rather than mutate them.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

const sanitizePackageJson = (pkg, internalVersions, overrides = {}) => {
  const next = {
    ...pkg,
    ...overrides,
    private: false,
  };

  delete next.scripts;
  delete next.workspaces;
  delete next.devDependencies;

  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (!next[field]) continue;
    next[field] = Object.fromEntries(
      Object.entries(next[field]).map(([name, version]) => {
        if (!version.startsWith("workspace:")) return [name, version];
        const localVersion = internalVersions.get(name);
        if (!localVersion)
          throw new Error(`Unknown workspace dependency: ${name}`);
        return [name, localVersion];
      }),
    );
  }

  return next;
};

const deployProductionCli = async () => {
  const target = relative(repoRoot, releaseRoot).replaceAll("\\", "/");
  if (!/^[\w./-]+$/.test(target) || target.startsWith("../"))
    throw new Error("Unexpected package output path");
  await rm(releaseRoot, { recursive: true, force: true });
  // Match desktop deployment: let pnpm preserve transitive and nested versions.
  const args = [
    "--filter",
    "./apps/cli",
    "deploy",
    "--prod",
    "--config.node-linker=hoisted",
    "--config.package-import-method=copy",
    target,
  ];
  const windows = process.platform === "win32";
  await new Promise((done, reject) => {
    const child = spawn(
      windows ? process.env.ComSpec || "cmd.exe" : "pnpm",
      windows ? ["/d", "/s", "/c", `pnpm ${args.join(" ")}`] : args,
      { cwd: repoRoot, windowsHide: true, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? done()
        : reject(
            new Error(`Production dependency deployment failed (${code})`),
          ),
    );
  });
};

const main = async () => {
  const internalVersions = new Map();
  const manifests = new Map();
  for (const item of bundledPackages) {
    const manifest = await readJson(item.packageJsonPath);
    internalVersions.set(item.name, manifest.version);
    manifests.set(item.name, manifest);
  }
  const rootPackageJson = sanitizePackageJson(
    await readJson(rootPackage.packageJsonPath),
    internalVersions,
    { bundledDependencies: true },
  );
  const sanitizedPackages = bundledPackages.map((item) => ({
    name: item.name,
    manifest: sanitizePackageJson(manifests.get(item.name), internalVersions, {
      ...(item.name === "@loopmarshal/core"
        ? { files: [...manifests.get(item.name).files, "web/**/*"] }
        : {}),
    }),
  }));

  await deployProductionCli();

  await writeJson(join(releaseRoot, "package.json"), rootPackageJson);

  // Copy skills directory (used by start-agent for IDE skill injection)
  const skillsSourcePath = join(repoRoot, "skills");
  if (existsSync(skillsSourcePath)) {
    await cp(skillsSourcePath, join(releaseRoot, "skills"), {
      recursive: true,
    });
  }

  for (const item of sanitizedPackages) {
    await writeJson(
      join(
        releaseRoot,
        "node_modules",
        ...item.name.split("/"),
        "package.json",
      ),
      item.manifest,
    );
  }

  if (existsSync(join(webDistPath, "index.html"))) {
    await cp(
      webDistPath,
      join(releaseRoot, "node_modules", "@loopmarshal", "core", "web"),
      { recursive: true },
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        releaseRoot,
        bundledDependencies: Object.keys(rootPackageJson.dependencies),
        nextCommand: "npm pack ./release/loopmarshal --json --cache .npm-cache",
      },
      null,
      2,
    )}\n`,
  );
};

main().catch((error) => {
  console.error("Failed to prepare and pack user package.", error);
  process.exitCode = 1;
});
