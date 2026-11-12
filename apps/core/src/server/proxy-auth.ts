import type { FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { CoreError } from "../errors.js";

export function assertSameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin && origin !== `${request.protocol}://${request.headers.host}`) {
    throw new CoreError(
      "PERMISSION_DENIED",
      "Proxy management requires the same application origin.",
      403,
    );
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new CoreError(
      "PERMISSION_DENIED",
      "Cross-site proxy management is not allowed.",
      403,
    );
  }
}

export function managementTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function authorizeProxyRequest(
  request: FastifyRequest,
  expectedDigest: string,
): void {
  assertSameOrigin(request);
  const value = request.headers["x-loopmarshal-management-token"];
  if (
    typeof value !== "string" ||
    value.length > 1000 ||
    !timingSafeEqual(
      Buffer.from(managementTokenDigest(value), "hex"),
      Buffer.from(expectedDigest, "hex"),
    )
  ) {
    throw new CoreError(
      "PERMISSION_DENIED",
      "A local management credential is required for proxy operations.",
      403,
    );
  }
}

export function memberBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  if (!header.startsWith("Bearer "))
    throw new CoreError(
      "PERMISSION_DENIED",
      "Use a Bearer member credential.",
      403,
    );
  return header.slice(7);
}

export function isLoopbackRequest(request: FastifyRequest): boolean {
  let localHost = false;
  try {
    localHost = ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(`http://${request.headers.host}`).hostname,
    );
  } catch {
    /* Invalid authority. */
  }
  return (
    localHost && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)
  );
}
