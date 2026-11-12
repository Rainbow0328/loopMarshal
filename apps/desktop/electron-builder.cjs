const path = require("node:path");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const iconHash = createHash("sha256")
  .update(readFileSync(path.join(__dirname, "build/icon.ico")))
  .digest("hex")
  .slice(0, 12);

module.exports = {
  appId: "com.loopmarshal.desktop",
  productName: "LoopMarshal",
  copyright: "Copyright © 2026 LoopMarshal Team",
  directories: {
    output: path.join(__dirname, "../../release/desktop"),
    buildResources: "build",
  },
  files: [
    "src/main.cjs",
    "src/preload.cjs",
    "src/core-supervisor.cjs",
    "build/icon.png",
    "package.json",
  ],
  extraResources: [
    { from: "staging", to: "loopmarshal", filter: ["**/*"] },
    { from: "build/icon.ico", to: `loopmarshal-icon-${iconHash}.ico` },
  ],
  asar: true,
  electronDist: path.dirname(require("electron")),
  npmRebuild: false,
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.ico",
    executableName: "LoopMarshal",
    signExecutable: false,
  },
  nsis: {
    artifactName: "LoopMarshal-Setup-${version}-${arch}.${ext}",
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "LoopMarshal",
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
    include: "build/installer.nsh",
  },
};
