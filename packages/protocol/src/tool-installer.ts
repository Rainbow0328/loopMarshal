import { z } from "zod";
import { proxyToolIds, type ProxyToolId } from "./member-routes.js";

export const toolInstallRequestSchema = z
  .object({
    toolId: z.enum(proxyToolIds),
    root: z.string().trim().min(1).max(2048),
  })
  .strict();
export type ToolInstallRequest = z.infer<typeof toolInstallRequestSchema>;
export type ToolInstallCatalogEntry = {
  toolId: ProxyToolId;
  packageName: string | null;
  source: string;
  reason: string | null;
  modelProtocols: string[];
};
export type ToolInstallJob = {
  id: string;
  toolId: ProxyToolId;
  root: string;
  status: "installing" | "installed" | "failed";
  installationId: string | null;
  profileId: string | null;
  error: string | null;
  createdAt: string;
};
