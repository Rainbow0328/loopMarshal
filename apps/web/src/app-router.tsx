import { AppShell } from "@/features/app/AppShell";
import { WorkbenchPage } from "@/features/workbench/WorkbenchPage";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  RouterProvider,
} from "@tanstack/react-router";

const rootRoute = createRootRoute({ component: AppShell });

const safeId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value
    : undefined;
const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkbenchPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { sessionId?: string; memberId?: string; view?: "messages" } => ({
    sessionId: safeId(search.sessionId),
    memberId: safeId(search.memberId),
    view: search.view === "messages" ? ("messages" as const) : undefined,
  }),
});
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: lazyRouteComponent(
    () => import("@/features/workbench/ActivityPage"),
    "ActivityPage",
  ),
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId: safeId(search.sessionId),
    memberId: safeId(search.memberId),
  }),
});
const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models",
  component: lazyRouteComponent(
    () => import("@/features/models/ModelsPage"),
    "ModelsPage",
  ),
});
const mcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mcp",
  component: lazyRouteComponent(
    () => import("@/features/mcp/McpPage"),
    "McpPage",
  ),
});
const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/knowledge",
  component: lazyRouteComponent(
    () => import("@/features/knowledge/KnowledgePage"),
    "KnowledgePage",
  ),
});
const preferencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/preferences",
  component: lazyRouteComponent(
    () => import("@/features/preferences/PreferencesPage"),
    "PreferencesPage",
  ),
});
const toolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tools",
  component: lazyRouteComponent(
    () => import("@/features/tools/ToolsPage"),
    "ToolsPage",
  ),
});
const toolConfigRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tool-config",
  validateSearch: (search: Record<string, unknown>) => ({
    installationId:
      typeof search.installationId === "string"
        ? search.installationId
        : undefined,
  }),
  component: lazyRouteComponent(
    () => import("@/features/tools/ToolConfigPage"),
    "ToolConfigPage",
  ),
});

const routeTree = rootRoute.addChildren([
  workbenchRoute,
  activityRoute,
  modelsRoute,
  mcpRoute,
  knowledgeRoute,
  preferencesRoute,
  toolsRoute,
  toolConfigRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}
