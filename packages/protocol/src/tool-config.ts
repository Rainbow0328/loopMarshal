import { z } from "zod";
import type { ProxyToolId } from "./member-routes.js";

export const createToolConfigProfileSchema = z
  .object({
    installationId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    configRoot: z.string().trim().min(1),
    workspacePath: z.string().trim().min(1).nullable().default(null),
  })
  .strict();
export type CreateToolConfigProfileInput = z.input<
  typeof createToolConfigProfileSchema
>;
export type ToolConfigProfile = z.output<
  typeof createToolConfigProfileSchema
> & { id: string; toolId: ProxyToolId; createdAt: string };
export type ToolDiscoveryCandidate = {
  toolId: ProxyToolId;
  executablePath: string;
  source: "path" | "known_location";
  registeredInstallationId: string | null;
  suggestedConfigRoot: string;
  compatibility?: import("./tool-compatibility.js").ToolCompatibility;
};
export type ToolConfigField = {
  id: string;
  label: string;
  secret: boolean;
  value: string | boolean | number | null;
  configured: boolean;
  options?: string[];
  description?: string;
  kind?: "boolean" | "number";
};
export type ToolConfigDocument = {
  id: string;
  path: string;
  scope: "user" | "project";
  exists: boolean;
  fingerprint: string;
  fields: ToolConfigField[];
  effectiveAfter: string;
  warning: string | null;
};
export type ToolConfigChange = {
  fieldId: string;
  before: string | boolean | number | null;
  after: string | boolean | number | null;
};
export type ToolConfigBackup = {
  id: string;
  profileId: string;
  documentId: string;
  createdAt: string;
  canRestore: boolean;
  path: string;
  restoredAt: string | null;
};
export const previewToolConfigSchema = z
  .object({
    documentId: z.string().min(1),
    expectedFingerprint: z.string().min(1),
    values: z
      .record(
        z.union([
          z.string().max(8192),
          z.boolean(),
          z.number().finite(),
          z.null(),
        ]),
      )
      .refine(
        (value) =>
          Object.keys(value).length > 0 && Object.keys(value).length <= 30,
        "Provide 1–30 fields",
      ),
  })
  .strict();
export type PreviewToolConfigInput = z.infer<typeof previewToolConfigSchema>;
export type ToolConfigPreview = {
  previewId: string;
  path: string;
  changes: ToolConfigChange[];
  expiresAt: string;
  effectiveAfter: string;
};
