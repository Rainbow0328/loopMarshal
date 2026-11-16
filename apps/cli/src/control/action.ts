import type { LoopMarshalClient } from "@loopmarshal/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { parseControlInput } from "./errors.js";

export type ControlAction = {
  name: string;
  group: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  execute: (client: LoopMarshalClient, input: unknown) => Promise<unknown>;
};

/** Keep validation, discovery and both public transports on the same schema. */
export function action<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: S,
  execute: (client: LoopMarshalClient, input: z.output<S>) => Promise<unknown>,
  readOnly = true,
): ControlAction {
  let inputSchema: Record<string, unknown> | undefined;
  return {
    name,
    group: name.split(".")[0]!,
    description,
    readOnly,
    get inputSchema() {
      // Ordinary CLI sends/waits should not generate 70 unused JSON Schemas.
      return (inputSchema ??= zodToJsonSchema(schema, {
        $refStrategy: "none",
      }));
    },
    async execute(client, input) {
      return execute(client, parseControlInput(schema, input));
    },
  };
}

export const text = z.string().trim().min(1);
export const empty = z.object({}).strict();
export const sessionInput = z.object({ session: text }).strict();
export const strings = z.array(text).max(100);
