import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dataDirectory = resolve(process.env.LOOPMARSHAL_DESKTOP_DATA_DIR);
const resourceDirectory = resolve(process.env.LOOPMARSHAL_DESKTOP_RESOURCES);
mkdirSync(dataDirectory, { recursive: true });
process.chdir(dataDirectory);
process.env.LOOPMARSHAL_HOME = join(dataDirectory, "home");
process.env.LOOPMARSHAL_LOG_DIR = join(dataDirectory, "logs");
process.env.LOOPMARSHAL_LOG_DESTINATION = join(
  dataDirectory,
  "logs",
  "core.log",
);
process.env.LOOPMARSHAL_USER_PREFERENCES_PATH = join(
  dataDirectory,
  "user-preferences.json",
);
process.env.LOOPMARSHAL_KNOWLEDGE_ROOT = join(dataDirectory, "knowledge");
process.env.LOOPMARSHAL_WEB_DIST_PATH = join(resourceDirectory, "web");
process.env.LOOPMARSHAL_HOST = "127.0.0.1";
process.env.LOOPMARSHAL_PORT = process.env.LOOPMARSHAL_DESKTOP_PORT || "42688";
process.env.LOOPMARSHAL_DATABASE_PATH = join(
  dataDirectory,
  "loopmarshal.sqlite",
);
// Set environment before loading Core: its defaults and repositories use it at import time.
let instance;
let stopping = false;
let shutdownRequested = false;
async function shutdown() {
  shutdownRequested = true;
  if (!instance || stopping) return;
  stopping = true;
  try {
    await instance.close();
    process.send?.({ type: "stopped" });
    process.exit(0);
  } catch {
    process.send?.({ type: "shutdown_error" });
    process.exit(1);
  }
}
process.on("message", (message) => {
  if (message?.type === "shutdown") void shutdown();
});
process.on("disconnect", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
try {
  const { DatabaseSync } = await import("node:sqlite");
  const probe = new DatabaseSync(":memory:");
  probe.exec("SELECT 1");
  probe.close();
  const { startCoreServer } = await import(
    pathToFileURL(
      join(
        resourceDirectory,
        "app",
        "node_modules",
        "@loopmarshal",
        "core",
        "dist",
        "apps",
        "core",
        "src",
        "index.js",
      ),
    ).href
  );
  instance = await startCoreServer({
    host: "127.0.0.1",
    port: Number(process.env.LOOPMARSHAL_PORT),
    databasePath: process.env.LOOPMARSHAL_DATABASE_PATH,
  });
  if (shutdownRequested || !process.connected) await shutdown();
  else
    process.send?.({
      type: "ready",
      pid: process.pid,
      baseUrl: `http://127.0.0.1:${instance.server.server.address().port}`,
      databasePath: process.env.LOOPMARSHAL_DATABASE_PATH,
      nodeVersion: process.version,
      sqlite: true,
    });
} catch (error) {
  process.send?.({
    type: "startup_error",
    code: error?.code ?? null,
    message:
      error?.code === "EADDRINUSE"
        ? "后台服务端口已被占用。请先关闭正在运行的 LoopMarshal Core，再重新打开客户端。"
        : error?.code === "NATIVE_SESSION_IN_USE"
          ? "已有其他 Core 正在使用这份数据。请先停止它，再重新打开客户端。"
          : "后台服务启动失败。请查看日志；用户数据已保留。",
  });
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
