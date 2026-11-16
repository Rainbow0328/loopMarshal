import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function createControlHarness(cli, project) {
  function runCli(args, input, extraEnv = {}) {
    return new Promise((done, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: project,
        env: { ...process.env, ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`CLI timed out: ${args[0]}`));
      }, 20000);
      child.stdout.on("data", (b) => {
        stdout += b;
      });
      child.stderr.on("data", (b) => {
        stderr += b;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          done({ code, output: JSON.parse(stdout), raw: stdout });
        } catch {
          reject(
            new Error(`CLI output invalid (${code}): ${stdout} ${stderr}`),
          );
        }
      });
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }

  function connectMcp(extraEnv = {}) {
    const child = spawn(process.execPath, [cli, "mcp", "serve"], {
      cwd: project,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let next = 0,
      stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error)
        request.reject(new Error(JSON.stringify(message.error)));
      else request.done(message.result);
    });
    child.on("error", (e) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      pending.clear();
    });
    child.on("close", (code) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP closed (${code}): ${stderr}`));
      }
      pending.clear();
    });
    const request = (method, params = {}) =>
      new Promise((done, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP timed out: ${method} ${stderr}`));
        }, 20000);
        pending.set(id, { done, reject, timer });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    return {
      request,
      async call(name, args = {}) {
        const result = await request("tools/call", { name, arguments: args });
        if (result.isError) throw new Error(result.content[0].text);
        return JSON.parse(result.content[0].text);
      },
      async close() {
        lines.close();
        child.stdin.end();
        if (child.exitCode === null)
          await new Promise((done) => {
            const timer = setTimeout(() => child.kill(), 3000);
            child.once("close", () => {
              clearTimeout(timer);
              done();
            });
          });
      },
    };
  }

  return { runCli, connectMcp };
}

export async function until(read, predicate) {
  const deadline = Date.now() + 20000;
  let last;
  while (Date.now() < deadline) {
    const value = await read();
    last = value;
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(
    `Timed out waiting for application execution: ${JSON.stringify(last).slice(0, 4000)}`,
  );
}
