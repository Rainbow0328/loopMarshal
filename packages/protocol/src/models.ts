import { z } from "zod";

export const saveModelConfigSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(120),
    provider: z.string().trim().min(1).max(120),
    modelId: z.string().trim().min(1).max(256),
    baseUrl: z
      .union([z.string().trim().url().max(2048), z.literal(""), z.null()])
      .optional(),
    apiKey: z.string().max(8192).nullable().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    contextReserveTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SaveModelConfigInput = z.input<typeof saveModelConfigSchema>;
export type ModelConfigSummary = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  baseUrl: string | null;
  apiKey: null;
  hasApiKey: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  contextReserveTokens: number;
};
