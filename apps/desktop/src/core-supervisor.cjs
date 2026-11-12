const { spawn } = require("node:child_process");
const { mkdirSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { EventEmitter } = require("node:events");

class CoreSupervisor extends EventEmitter {
  constructor({
    resourceDirectory,
    dataDirectory,
    runtimePath,
    coreHostPath,
    port = 42688,
    startupTimeout = 45000,
    shutdownTimeout = 20000,
  }) {
    super();
    Object.assign(this, {
      resourceDirectory,
      dataDirectory,
      port,
      startupTimeout,
      shutdownTimeout,
    });
    this.runtimePath =
      runtimePath ||
      join(
        resourceDirectory,
        "runtime",
        process.platform === "win32" ? "node.exe" : "node",
      );
    this.coreHostPath =
      coreHostPath || join(resourceDirectory, "core-host.mjs");
    this.child = null;
    this.info = null;
    this.exiting = false;
  }
  async start() {
    if (this.child) throw new Error("Core is already starting or running");
    this.exiting = false;
    mkdirSync(join(this.dataDirectory, "logs"), { recursive: true });
    const runtimeEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"].includes(
            key.toUpperCase(),
          ),
      ),
    );
    const child = spawn(this.runtimePath, [this.coreHostPath], {
      cwd: this.dataDirectory,
      windowsHide: true,
      shell: false,
      env: {
        ...runtimeEnv,
        LOOPMARSHAL_DESKTOP_DATA_DIR: this.dataDirectory,
        LOOPMARSHAL_DESKTOP_RESOURCES: this.resourceDirectory,
        LOOPMARSHAL_DESKTOP_PORT: String(this.port),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    const log = (chunk) => {
      try {
        appendFileSync(
          join(this.dataDirectory, "logs", "desktop-core.log"),
          chunk,
        );
      } catch {
        /* Logging must not prevent cleanup. */
      }
    };
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    child.on("error", () => {
      this.child = null;
      this.info = null;
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      this.info = null;
      if (!this.exiting) this.emit("unexpected-exit", { code, signal });
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("message", message);
        child.off("error", failed);
        child.off("exit", exited);
        error ? reject(error) : resolve(value);
      };
      const message = (value) => {
        if (value?.type === "ready") {
          this.info = value;
          finish(null, value);
        }
        if (value?.type === "startup_error")
          finish(Object.assign(new Error(value.message), { code: value.code }));
      };
      const failed = () =>
        finish(new Error("无法启动内置运行时，请重新安装客户端或查看日志。"));
      const exited = () =>
        finish(new Error("后台服务在启动完成前退出，请查看日志。"));
      const timer = setTimeout(() => {
        finish(new Error("后台服务启动超时，请查看日志。"));
        void this.stop();
      }, this.startupTimeout);
      child.on("message", message);
      child.once("error", failed);
      child.once("exit", exited);
    });
  }
  async stop() {
    this.exiting = true;
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        child.off("exit", done);
        resolve();
      };
      child.once("exit", done);
      if (child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
      }
      if (child.connected) child.send({ type: "shutdown" }, () => {});
      timer = setTimeout(() => {
        // Only our own child and descendants; never search by process name or kill an occupied port.
        if (process.platform === "win32" && child.pid) {
          const killer = spawn(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.once("error", () => child.kill());
        } else child.kill("SIGKILL");
      }, this.shutdownTimeout);
    });
  }
}
module.exports = { CoreSupervisor };
