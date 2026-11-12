import type Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { errorResponse } from "./response.js";

const webMimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const findWebDistPath = (): string | null => {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.LOOPMARSHAL_WEB_DIST_PATH,
    resolve(process.cwd(), "..", "web", "dist"),
    resolve(process.cwd(), "..", "..", "apps", "web", "dist"),
    resolve(process.cwd(), "apps", "web", "dist"),
    resolve(moduleDir, "..", "..", "..", "..", "..", "web"),
    resolve(
      moduleDir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "..",
      "apps",
      "web",
      "dist",
    ),
    resolve(moduleDir, "..", "..", "..", "..", "web"),
    resolve(moduleDir, "web"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const indexPath = resolve(candidate, "index.html");
    if (existsSync(indexPath)) {
      return resolve(candidate);
    }
  }

  return null;
};

const isPathInside = (parent: string, child: string): boolean => {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}${sep}`)
  );
};

export const registerWebFrontend = (
  server: Awaited<ReturnType<typeof Fastify>>,
) => {
  const webDistPath = findWebDistPath();

  server.setNotFoundHandler(
    async (request: FastifyRequest, reply: FastifyReply) => {
      const method = request.method.toUpperCase();
      const rawUrl = request.raw.url ?? "/";
      const pathname = rawUrl.split("?", 1)[0] ?? "/";

      if (
        method !== "GET" ||
        pathname.startsWith("/api") ||
        pathname.startsWith("/ws") ||
        pathname === "/health"
      ) {
        void reply
          .status(404)
          .send(errorResponse("INVALID_INPUT", "Route not found."));
        return;
      }

      if (!webDistPath) {
        void reply
          .status(404)
          .type("text/plain; charset=utf-8")
          .send(
            "loopmarshal web assets were not found. Run npm run build or set LOOPMARSHAL_WEB_DIST_PATH.",
          );
        return;
      }

      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(pathname);
      } catch {
        return reply
          .status(400)
          .send(errorResponse("INVALID_INPUT", "Invalid URL encoding."));
      }
      const relativePath =
        decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
      const requestedPath = resolve(webDistPath, relativePath);
      const safeRequestedPath = isPathInside(webDistPath, requestedPath)
        ? requestedPath
        : resolve(webDistPath, "index.html");
      const requestedFile = await stat(safeRequestedPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        },
      );
      const filePath = requestedFile?.isFile()
        ? safeRequestedPath
        : resolve(webDistPath, "index.html");
      const contentType =
        webMimeTypes[extname(filePath).toLowerCase()] ??
        "application/octet-stream";

      const hashedAsset = /\/assets\/[^/]+-[\w-]{8,}\.[\w]+$/.test(
        filePath.replace(/\\/g, "/"),
      );
      reply.header(
        "Cache-Control",
        hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      );
      return reply.type(contentType).send(createReadStream(filePath));
    },
  );
};
