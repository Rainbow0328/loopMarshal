import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerWebFrontend } from "../server/web-frontend.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
  vi.unstubAllEnvs();
});

it("caches fingerprinted assets while revalidating the application entry and preserving API errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "loopmarshal-web-assets-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main>app</main>");
  await writeFile(
    join(root, "assets", "index-a1b2c3d4.js"),
    "export const app = true;",
  );
  vi.stubEnv("LOOPMARSHAL_WEB_DIST_PATH", root);
  const server = Fastify();
  cleanup.push(() => server.close());
  registerWebFrontend(server);
  const asset = await server.inject("/assets/index-a1b2c3d4.js");
  expect(asset.statusCode).toBe(200);
  expect(asset.headers["cache-control"]).toContain("immutable");
  expect(asset.headers["content-type"]).toContain("javascript");
  const page = await server.inject("/tool-config");
  expect(page.body).toBe("<main>app</main>");
  expect(page.headers["cache-control"]).toBe("no-cache");
  expect((await server.inject("/api/missing")).statusCode).toBe(404);
  expect(
    (await server.inject({ method: "POST", url: "/missing" })).statusCode,
  ).toBe(404);
});
