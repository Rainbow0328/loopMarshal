import { describe, expect, it } from "vitest";
import type { MessageRecord, WebAgentRuntime } from "@loopmarshal/protocol";
import { WebAgentRuntimeExecutorService } from "../services/web-agent-runtime-executor-service.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WebAgentRuntimeExecutorService", () => {
  it.each(["instruction", "result"])(
    "publishes a Host's final %s response to the user without another execution",
    async (type) => {
      const runtime = {
        id: "client-runtime",
        sessionId: "session",
        agentId: "host",
        role: "host",
        toolsetId: "host",
        enabled: true,
        status: "running",
        externalMcpServerIds: [],
      } as unknown as WebAgentRuntime;
      let claimed = false;
      let runs = 0;
      const sent: unknown[] = [];
      const services = {
        webAgentRuntimeService: { get: () => runtime, update: () => runtime },
        messageService: {
          claimNext: () =>
            claimed
              ? null
              : ((claimed = true),
                {
                  id: "source-message",
                  type,
                  payload: "work",
                  fromAgentId: type === "result" ? "worker" : "host",
                }),
          completeMessage: () => {},
          sendMessage: (input: unknown) => {
            sent.push(input);
          },
        },
        mcpToolService: { getToolsetDefinitions: () => [] },
        agentWorkflowRegistry: {
          runWorkflow: async () => {
            runs++;
            return {
              result: "Reviewed and ready",
              sentDirectedResult: false,
              continueAwaiting: false,
            };
          },
        },
      };
      const executor = new WebAgentRuntimeExecutorService(
        () => services as never,
      );
      try {
        executor.start(runtime);
        await flush();
        await flush();
        expect(runs).toBe(1);
        expect(sent).toEqual([
          {
            sessionId: "session",
            fromAgentId: "host",
            toAgentId: "host",
            type: "result",
            payload: {
              kind: "host_reply",
              content: "Reviewed and ready",
              inReplyTo: "source-message",
            },
          },
        ]);
      } finally {
        executor.stopAll();
      }
    },
  );
  it.each([false, true])(
    "does not access the store when a pending workflow settles after shutdown (reject=%s)",
    async (reject) => {
      const runtime = {
        id: "shutdown-runtime",
        sessionId: "session",
        agentId: "host",
        role: "host",
        toolsetId: "host",
        enabled: true,
        status: "running",
        externalMcpServerIds: [],
      } as unknown as WebAgentRuntime;
      let settle!: () => void;
      let closed = false;
      let lateWrites = 0;
      let workflowStarted = false;
      const pending = new Promise<{
        result: string;
        sentDirectedResult: boolean;
        continueAwaiting: boolean;
      }>((resolve, fail) => {
        settle = () =>
          reject
            ? fail(new Error("Model stopped"))
            : resolve({
                result: "late result",
                sentDirectedResult: false,
                continueAwaiting: false,
              });
      });
      const write = () => {
        if (closed) {
          lateWrites++;
          throw new Error("database is not open");
        }
      };
      const services = {
        webAgentRuntimeService: { get: () => runtime, update: write },
        messageService: {
          claimNext: () => ({
            id: "message",
            type: "instruction",
            payload: "work",
            fromAgentId: "host",
          }),
          completeMessage: write,
          failMessage: write,
          sendMessage: write,
        },
        mcpToolService: { getToolsetDefinitions: () => [] },
        agentWorkflowRegistry: {
          runWorkflow: async () => {
            workflowStarted = true;
            return pending;
          },
        },
      };
      const executor = new WebAgentRuntimeExecutorService(
        () => services as never,
      );
      executor.start(runtime);
      await flush();
      expect(workflowStarted).toBe(true);
      executor.stopAll();
      closed = true;
      settle();
      await flush();
      expect(lateWrites).toBe(0);
    },
  );
  it("marks a claimed message as failed when processing throws", async () => {
    const runtime: WebAgentRuntime = {
      id: "runtime-1",
      sessionId: "session-1",
      agentId: "keeper-1",
      role: "knowledge_keeper",
      modelConfigId: "model-1",
      agentProfileId: null,
      toolsetId: "knowledge_keeper",
      status: "running",
      enabled: true,
      currentStep: null,
      lastError: null,
      lastTickAt: null,
      lastSelfMaintenanceAt: null,
      externalMcpServerIds: [],
      customDuty: null,
      customSkillIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const message: MessageRecord = {
      id: "message-1",
      sessionId: "session-1",
      fromAgentId: "host-1",
      toAgentId: "keeper-1",
      type: "task",
      payload: "update knowledge",
      deliveryStatus: "sent",
      processingStatus: "claimed",
      claimedByAgentId: "keeper-1",
      claimedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const failed: Array<{
      messageId: string;
      agentId: string;
      reason?: string;
    }> = [];
    const runtimeUpdates: Record<string, unknown>[] = [];
    const sentMessages: unknown[] = [];
    const services = {
      webAgentRuntimeService: {
        get: () => runtime,
        update: (_id: string, update: Record<string, unknown>) => {
          runtimeUpdates.push(update);
          if (typeof update.status === "string") {
            runtime.status = update.status as WebAgentRuntime["status"];
          }
          return runtime;
        },
      },
      agentProfileService: {
        get: () => null,
      },
      messageService: {
        claimNext: () => message,
        failMessage: (messageId: string, agentId: string, reason?: string) => {
          failed.push({
            messageId,
            agentId,
            ...(reason !== undefined ? { reason } : {}),
          });
          return { ...message, processingStatus: "failed" };
        },
        sendMessage: (input: unknown) => {
          sentMessages.push(input);
          return input;
        },
      },
      modelConfigService: {
        findById: () => ({ id: "model-1", provider: "openai" }),
        getFull: () => ({
          id: "model-1",
          provider: "openai",
          baseUrl: "http://127.0.0.1:1",
          modelName: "x",
        }),
      },
      mcpToolService: {
        getToolsetDefinitions: () => [],
      },
      externalMcpService: {
        listAllTools: async () => [],
      },
    };
    const executor = new WebAgentRuntimeExecutorService(
      () => services as never,
    );

    executor.start(runtime);
    await flush();

    expect(failed).toHaveLength(1);
    expect(failed[0]?.messageId).toBe("message-1");
    expect(failed[0]?.agentId).toBe("keeper-1");
    expect(sentMessages).toHaveLength(1);
    expect(runtimeUpdates.at(-1)).toMatchObject({ status: "error" });
  });
});
