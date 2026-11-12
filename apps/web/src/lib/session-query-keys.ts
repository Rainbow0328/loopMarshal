export const sessionQueryKeys = {
  console: (sessionId: string | null | undefined) =>
    ["console", sessionId] as const,
  messages: (sessionId: string | null | undefined) =>
    ["messages", sessionId] as const,
  runtimes: (sessionId: string | null | undefined) =>
    ["runtimes", sessionId] as const,
  insight: (sessionId: string | null | undefined) =>
    ["insight", sessionId] as const,
  deliveries: (sessionId: string) => ["deliveries", sessionId] as const,
  routes: (sessionId: string) => ["member-routes", sessionId] as const,
  knowledge: (sessionId: string) => ["knowledge", sessionId] as const,
};

// WebSocket notifications provide live updates; polling covers missed notifications.
export const SESSION_FALLBACK_REFETCH_MS = 15_000;
