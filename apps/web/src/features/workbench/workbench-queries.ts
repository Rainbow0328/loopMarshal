import { api } from "@/lib/api-client";
import {
  SESSION_FALLBACK_REFETCH_MS,
  sessionQueryKeys,
} from "@/lib/session-query-keys";
import type { SessionSummary, WebAgentRuntime } from "@loopmarshal/protocol";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

/* ==================== Query Keys ==================== */

export const qk = {
  sessions: ["sessions"] as const,
  ...sessionQueryKeys,
  models: ["models"] as const,
  knowledgeManifest: ["knowledge", "manifest"] as const,
  knowledgeList: ["knowledge", "list"] as const,
  knowledgeDoc: (level: string, slug: string) =>
    ["knowledge", "doc", level, slug] as const,
  knowledgeChanges: ["knowledge", "changes"] as const,
  mcpServers: ["mcp", "servers"] as const,
  preferences: ["preferences"] as const,
};

/* ==================== Session Queries ==================== */

export function useSessionsQuery() {
  return useQuery({
    queryKey: qk.sessions,
    queryFn: () => api.sessions.list(),
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnReconnect: false,
  });
}

export function useConsoleQuery(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: qk.console(sessionId),
    queryFn: () => api.sessions.getConsole(sessionId as string),
    enabled: Boolean(sessionId),
    refetchInterval: SESSION_FALLBACK_REFETCH_MS,
  });
}

export function useMessagesQuery(
  sessionId: string | null | undefined,
  options: { refetchOnMount?: boolean | "always" } = {},
) {
  return useQuery({
    queryKey: qk.messages(sessionId),
    queryFn: () => api.messages.list(sessionId as string),
    enabled: Boolean(sessionId),
    refetchInterval: SESSION_FALLBACK_REFETCH_MS,
    refetchOnMount: options.refetchOnMount,
  });
}

export function useRuntimesQuery(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: qk.runtimes(sessionId),
    queryFn: () => api.webRuntimes.list(sessionId as string),
    enabled: Boolean(sessionId),
    refetchInterval: SESSION_FALLBACK_REFETCH_MS,
  });
}

export function useModelsQuery() {
  return useQuery({
    queryKey: qk.models,
    queryFn: () => api.models.list(),
  });
}

export function useInsightQuery(
  sessionId: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: qk.insight(sessionId),
    queryFn: () => api.sessions.getInsight(sessionId!),
    enabled: Boolean(sessionId) && enabled,
    refetchInterval: SESSION_FALLBACK_REFETCH_MS,
  });
}

/* ==================== Mutations ==================== */

export function useAddKnowledgeKeeperMutation(
  sessionId: string | null | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { modelConfigId: string }) => {
      if (!sessionId) throw new Error("No active session.");
      const joined = await api.sessionWithAgent.join({
        sessionId,
        role: "knowledge_keeper",
        agentName: "knowledge-keeper",
        displayName: "Knowledge Keeper",
        modelConfigId: input.modelConfigId,
        roleDescription:
          "Maintain project knowledge and user preferences for this session.",
      });
      const runtime = await api.webRuntimes.create({
        sessionId,
        agentId: joined.agent.id,
        role: "knowledge_keeper",
        modelConfigId: input.modelConfigId,
        toolsetId: "knowledge_keeper",
      });
      let runtimeStarted = true;
      try {
        await api.webRuntimes.start(runtime.id);
      } catch (startErr) {
        // Runtime start failure is non-fatal; users can retry from the panel.
        runtimeStarted = false;
        console.warn("Runtime start failed:", startErr);
      }
      return { agent: joined.agent, runtime, runtimeStarted };
    },
    onSuccess: () => invalidateSession(qc, sessionId),
  });
}

export function useRuntimeCommandMutation(
  sessionId: string | null | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      runtimeId: string;
      command: "start" | "pause" | "stop";
    }) => {
      if (input.command === "start")
        return api.webRuntimes.start(input.runtimeId);
      if (input.command === "pause")
        return api.webRuntimes.pause(input.runtimeId);
      return api.webRuntimes.stop(input.runtimeId);
    },
    onSuccess: () => invalidateSession(qc, sessionId),
  });
}

export function useSendHostMessageMutation(
  sessionId: string | null | undefined,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { hostAgentId: string; content: string }) => {
      if (!sessionId) throw new Error("No active session.");
      return api.messages.send({
        sessionId,
        fromAgentId: input.hostAgentId,
        toAgentId: input.hostAgentId,
        type: "instruction",
        payload: {
          kind: "web_user_message",
          content: input.content,
          source: "web_workbench",
        },
      });
    },
    onSuccess: () => invalidateSession(qc, sessionId),
  });
}

export function useDeleteRuntimeMutation(sessionId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runtimeId: string) => api.webRuntimes.delete(runtimeId),
    onSuccess: () => invalidateSession(qc, sessionId),
  });
}

export function useUpdateRuntimeMutation(sessionId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      runtimeId: string;
      customDuty?: string | null;
      customSkillIds?: string[];
      modelConfigId?: string;
      externalMcpServerIds?: string[];
    }) => api.webRuntimes.update(input.runtimeId, input),
    onSuccess: () => invalidateSession(qc, sessionId),
  });
}

export function useWorkflowsQuery(enabled = true) {
  return useQuery({
    queryKey: ["workflows"] as const,
    queryFn: () => api.workflows.list(),
    enabled,
  });
}

/* ==================== Helpers ==================== */

export function getSelectedSessionId(
  sessions: SessionSummary[],
  explicit: string | null,
): string | null {
  if (explicit && sessions.some((s) => s.id === explicit)) return explicit;
  return sessions[0]?.id ?? null;
}

export function getRuntimeForAgent(
  runtimes: WebAgentRuntime[],
  agentId: string | null | undefined,
): WebAgentRuntime | null {
  if (!agentId) return null;
  return runtimes.find((r) => r.agentId === agentId) ?? null;
}

export function invalidateSession(
  qc: QueryClient,
  sessionId: string | null | undefined,
) {
  if (!sessionId) return;
  void qc.invalidateQueries({ queryKey: qk.console(sessionId) });
  void qc.invalidateQueries({ queryKey: qk.messages(sessionId) });
  void qc.invalidateQueries({ queryKey: qk.runtimes(sessionId) });
  void qc.invalidateQueries({ queryKey: qk.insight(sessionId) });
}
