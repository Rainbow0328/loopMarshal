import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { z } from "zod";
import { coreErrors } from "../errors.js";
import type { ProxyDeliveryService } from "../services/proxy-delivery-service.js";
import { successResponse } from "./response.js";

export function registerProxyDeliveryRoutes<Logger extends FastifyBaseLogger>(
  server: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    Logger
  >,
  service: ProxyDeliveryService,
): void {
  server.get("/api/sessions/:sessionId/deliveries", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    return successResponse({ deliveries: service.list(sessionId) });
  });
  server.get("/api/sessions/:sessionId/activity", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    return successResponse({ members: service.activity(sessionId) });
  });
  server.get("/api/deliveries/:deliveryId/events", async (request) => {
    const { deliveryId } = request.params as { deliveryId: string };
    const parsed = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .safeParse(request.query);
    if (!parsed.success) throw coreErrors.invalidInput(parsed.error.message);
    return successResponse({
      events: service.events(deliveryId, parsed.data.after),
    });
  });
  server.post(
    "/api/sessions/:sessionId/member-routes/:agentId/verify",
    async (request) => {
      const { sessionId, agentId } = request.params as {
        sessionId: string;
        agentId: string;
      };
      const input = z
        .object({ expectedBindingVersion: z.number().int().positive() })
        .safeParse(request.body);
      if (!input.success) throw coreErrors.invalidInput(input.error.message);
      await service.verify(
        sessionId,
        agentId,
        input.data.expectedBindingVersion,
      );
      return successResponse({ verified: true });
    },
  );
  server.post("/api/deliveries/:deliveryId/cancel", async (request) => {
    const { deliveryId } = request.params as { deliveryId: string };
    return successResponse({ delivery: await service.cancel(deliveryId) });
  });
  server.post("/api/deliveries/:deliveryId/reconcile", async (request) => {
    const { deliveryId } = request.params as { deliveryId: string };
    const input = z
      .object({
        outcome: z.enum(["reported", "failed"]),
        summary: z.string().trim().min(1).max(100000),
        confirmedStopped: z.literal(true),
      })
      .strict()
      .safeParse(request.body);
    if (!input.success) throw coreErrors.invalidInput(input.error.message);
    return successResponse({
      delivery: service.resolveUnknown(deliveryId, input.data),
    });
  });
}
