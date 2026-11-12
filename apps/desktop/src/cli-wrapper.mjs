import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const resources = dirname(fileURLToPath(import.meta.url));
if (["start", "stop"].includes(process.argv[2])) {
  console.error(
    "桌面版后台服务由客户端管理。请打开或退出 LoopMarshal 客户端。",
  );
  process.exit(1);
}
const data =
  process.env.LOOPMARSHAL_DESKTOP_DATA_DIR ||
  (process.platform === "win32"
    ? join(
        process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
        "loopmarshal",
      )
    : join(homedir(), ".local", "share", "loopmarshal"));
let endpoint;
try {
  endpoint = JSON.parse(
    readFileSync(join(data, "desktop", "endpoint.json"), "utf8"),
  );
} catch {
  /* Show a direct startup instruction below. */
}
if (
  !endpoint ||
  !Number.isInteger(endpoint.pid) ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.baseUrl)
) {
  console.error("请先打开 LoopMarshal 桌面客户端，再使用其命令入口。");
  process.exit(1);
}
try {
  process.kill(endpoint.pid, 0);
  const response = await fetch(endpoint.baseUrl + "/health", {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error();
} catch {
  console.error("桌面后台服务已停止，请重新打开 LoopMarshal。");
  process.exit(1);
}
process.env.LOOPMARSHAL_BASE_URL = endpoint.baseUrl;
process.env.LOOPMARSHAL_HOST = "127.0.0.1";
process.env.LOOPMARSHAL_PORT = new URL(endpoint.baseUrl).port;
process.env.LOOPMARSHAL_DATABASE_PATH = join(
  resolve(data),
  "loopmarshal.sqlite",
);
process.env.LOOPMARSHAL_HOME = join(resolve(data), "home");
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(resolve(data), "knowledge");
process.env.LOOPMARSHAL_LOG_DIR = join(resolve(data), "logs");
process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
  resolve(data),
  "user-preferences.json",
);
if (process.argv[2] === "status") {
  console.log(
    JSON.stringify(
      {
        state: "running",
        reachable: true,
        pid: endpoint.pid,
        dashboardUrl: endpoint.baseUrl,
        mode: "desktop",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
process.argv = [
  process.execPath,
  join(resources, "app", "dist", "apps", "cli", "src", "index.js"),
  ...process.argv.slice(2),
];
await import(pathToFileURL(process.argv[1]).href);
