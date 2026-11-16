import { afterEach, describe, expect, it, vi } from "vitest";
// Exercise the transport source, including responses not currently used by the UI.
import { createLoopMarshalClient } from "../../../../packages/sdk/src/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("SDK response validation", () => {
  it.each([[], {}, null, false, 0, ""])(
    "accepts an explicit successful result %j",
    async (data) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ success: true, data })),
      );
      expect(await createLoopMarshalClient().getStatus()).toEqual(data);
    },
  );

  it.each([null, [], {}, { success: true }])(
    "rejects invalid envelopes %j",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      await expect(createLoopMarshalClient().getStatus()).rejects.toThrow();
    },
  );

  it("preserves HTTP failures even if an intermediary returns success=true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ success: true, data: {} }, { status: 503 }),
      ),
    );
    await expect(createLoopMarshalClient().getStatus()).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("returns an actionable error without echoing invalid response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("private-upstream-secret", { status: 502 }),
      ),
    );
    await expect(createLoopMarshalClient().getStatus()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      statusCode: 502,
      message: expect.not.stringContaining("private-upstream-secret"),
    });
  });

  it("preserves structured backend permission errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            error: { code: "PERMISSION_DENIED", message: "Denied" },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(createLoopMarshalClient().getStatus()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      statusCode: 403,
      message: "Denied",
    });
  });
});
