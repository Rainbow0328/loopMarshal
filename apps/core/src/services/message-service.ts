/*
 * Copyright 2024 Cloud Skill Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { randomUUID } from "node:crypto";

import type {
  AckPayload,
  AgentQueueStats,
  MessageRecord,
  MessageType,
  SendMessageInput,
  WsInboxMessageNotification,
} from "@loopmarshal/protocol";
import {
  AgentRepository,
  IdentityLeaseRepository,
  MessageRepository,
  SessionRepository,
} from "@loopmarshal/store";

import { projectKnowledgePolicy } from "./project-knowledge-policy.js";
import { coreErrors } from "../errors.js";

const now = (): string => {
  return new Date().toISOString();
};

export class MessageService {
  private websocketService: {
    sendToAgent: (agentId: string, message: WsInboxMessageNotification) => void;
  } | null = null;

  public constructor(
    private readonly sessions: SessionRepository,
    private readonly agents: AgentRepository,
    private readonly messages: MessageRepository,
    private readonly identityLeases: IdentityLeaseRepository,
  ) {}

  public setWebSocketService(service: {
    sendToAgent: (agentId: string, message: WsInboxMessageNotification) => void;
  }): void {
    this.websocketService = service;
  }

  public sendMessage(input: SendMessageInput): MessageRecord {
    return this.messages.transaction(() =>
      this.sendMessageInTransaction(input),
    );
  }

  private sendMessageInTransaction(input: SendMessageInput): MessageRecord {
    const session = this.sessions.findById(input.sessionId);
    if (!session) {
      throw coreErrors.sessionNotFound(input.sessionId);
    }

    const fromAgent = this.agents.findById(input.fromAgentId);
    if (!fromAgent) {
      throw coreErrors.agentNotFound(input.fromAgentId);
    }
    if (fromAgent.sessionId !== input.sessionId) {
      throw coreErrors.crossSessionAgent(input.fromAgentId, input.sessionId);
    }

    if (input.toAgentId) {
      const toAgent = this.agents.findById(input.toAgentId);
      if (!toAgent) {
        throw coreErrors.agentNotFound(input.toAgentId);
      }
      if (toAgent.sessionId !== input.sessionId) {
        throw coreErrors.crossSessionAgent(input.toAgentId, input.sessionId);
      }
      if (
        input.type === "task" &&
        this.messages.isManagedProxy(input.toAgentId) &&
        (fromAgent.role !== "host" ||
          !["worker", "knowledge_keeper"].includes(toAgent.role))
      ) {
        throw coreErrors.invalidInput(
          "Implementation tasks for proxy workers must be sent by the host.",
        );
      }
      if (
        ["task", "instruction"].includes(input.type) &&
        this.messages.isMemberDisabled(input.toAgentId)
      ) {
        throw coreErrors.invalidInput(
          "This member is disabled. Enable it or choose another recipient.",
        );
      }
    }

    const message: MessageRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      fromAgentId: input.fromAgentId,
      type: input.type,
      payload: input.payload,
      deliveryStatus: "sent",
      processingStatus: "pending",
      createdAt: now(),
      ...(input.toAgentId ? { toAgentId: input.toAgentId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    };
    const proxyHostReport =
      input.type === "result" &&
      input.toAgentId !== input.fromAgentId &&
      input.toAgentId &&
      this.agents.findById(input.toAgentId)?.role === "host";
    const hostClientReply =
      fromAgent.role === "host" &&
      input.toAgentId === input.fromAgentId &&
      ["result", "progress", "error"].includes(input.type);
    if (
      hostClientReply ||
      (input.toAgentId &&
        this.messages.isManagedProxy(input.toAgentId) &&
        !["task", "instruction"].includes(input.type) &&
        !proxyHostReport)
    ) {
      message.processingStatus = "processed";
      message.deliveryStatus = "delivered";
      message.processedAt = now();
    }

    const inserted = this.messages.insertAtomically({
      message,
      supersedeMessageIds: input.supersedeMessageIds ?? [],
      processedAt: now(),
    });
    if (!inserted) {
      throw coreErrors.messageDispatchConflict(input.supersedeMessageIds ?? []);
    }

    if (this.websocketService && inserted.message.toAgentId) {
      const notification: WsInboxMessageNotification = {
        type: "inbox:new-message",
        messageId: inserted.message.id,
        fromAgentId: inserted.message.fromAgentId,
        toAgentId: inserted.message.toAgentId,
        messageType: inserted.message.type,
        createdAt: inserted.message.createdAt,
      };
      this.websocketService.sendToAgent(
        inserted.message.toAgentId,
        notification,
      );
    }

    if (
      input.type === "result" &&
      fromAgent.role === "worker" &&
      input.toAgentId &&
      this.agents.findById(input.toAgentId)?.role === "host"
    ) {
      const content =
        typeof input.payload === "string"
          ? input.payload
          : JSON.stringify(input.payload);
      this.queueKnowledgeMaintenance(
        input.sessionId,
        fromAgent.id,
        input.toAgentId,
        input.correlationId ?? inserted.message.id,
        content,
        `knowledge-after-worker:${inserted.message.id}`,
      );
    }

    return inserted.message;
  }

  /** Queue one unreviewed worker-report inspection for the session's Knowledge Keeper. */
  public queueKnowledgeMaintenance(
    sessionId: string,
    workerAgentId: string,
    hostAgentId: string,
    correlationId: string,
    result: string,
    idempotencyKey: string,
  ): void {
    const keeper = this.agents
      .listBySessionId(sessionId)
      .find((agent) => agent.role === "knowledge_keeper");
    if (!keeper) return;
    this.sendMessage({
      sessionId,
      fromAgentId: hostAgentId,
      toAgentId: keeper.id,
      type: "task",
      correlationId,
      idempotencyKey,
      payload: {
        kind: "knowledge_maintenance_task.v1",
        content: `Inspect this worker report, which has NOT been verified or accepted by the Host. Confirm any proposed project facts against relevant files and current knowledge before writing. A completed delivery proves only that a response arrived. Report no change if there are no durable facts.\n\n${projectKnowledgePolicy}\n\nUnreviewed worker result (${workerAgentId}):\n${result.slice(0, 10000)}`,
      },
    });
  }

  public sendByName(
    input: import("@loopmarshal/protocol").NamedSendInput,
  ): MessageRecord[] {
    return this.messages.transaction(() => {
      const session = this.sessions.findOpenByName(input.sessionName);
      if (!session) throw coreErrors.sessionNotFound(input.sessionName);
      const members = this.agents.listBySessionId(session.id);
      const sender = members.find((member) => member.agentName === input.from);
      if (!sender) throw coreErrors.agentNotFound(input.from);
      const request = JSON.stringify({
        to: [...new Set(input.to)].sort(),
        type: input.type,
        content: input.content,
        correlationId: input.correlationId ?? null,
      });
      const previous = this.messages.getNamedOperation(
        session.id,
        sender.id,
        input.idempotencyKey,
      );
      if (previous) {
        if (previous.request !== request)
          throw coreErrors.invalidInput(
            "This operation key was already used for different content or recipients.",
          );
        return previous.result;
      }
      let targets: typeof members;
      if (input.to.includes("all")) {
        if (input.to.length !== 1)
          throw coreErrors.invalidInput(
            "Use either all or an explicit recipient list.",
          );
        targets = members.filter(
          (member) =>
            member.id !== sender.id &&
            member.role !== "observer" &&
            (input.type !== "task" || member.role === "worker"),
        );
      } else {
        targets = [...new Set(input.to)].map((name) => {
          const member = members.find(
            (candidate) => candidate.agentName === name,
          );
          if (!member) throw coreErrors.agentNotFound(name);
          return member;
        });
      }
      if (
        input.type === "task" &&
        (sender.role !== "host" ||
          targets.some(
            (member) => !["worker", "knowledge_keeper"].includes(member.role),
          ))
      ) {
        throw coreErrors.invalidInput(
          "Implementation tasks must be sent by the host to workers.",
        );
      }
      const storedType: Record<
        import("@loopmarshal/protocol").NamedSendInput["type"],
        MessageType
      > = {
        task: "task",
        task_report: "result",
        question: "instruction",
        answer: "instruction",
        announcement: "system",
      };
      if (targets.length === 0)
        throw coreErrors.invalidInput(
          "No eligible recipients in this session.",
        );
      const result = targets.map((target) =>
        this.sendMessage({
          sessionId: session.id,
          fromAgentId: sender.id,
          toAgentId: target.id,
          type: storedType[input.type],
          payload: {
            kind: "collaboration-message.v1",
            semanticType: input.type,
            content: input.content,
            broadcastGroupId: `${session.id}:${sender.id}:${input.idempotencyKey}`,
          },
          idempotencyKey: `${input.idempotencyKey}:${target.id}`,
          ...(input.correlationId
            ? { correlationId: input.correlationId }
            : {}),
        }),
      );
      this.messages.saveNamedOperation(
        session.id,
        sender.id,
        input.idempotencyKey,
        request,
        result,
      );
      return result;
    });
  }

  public getInbox(
    agentId: string,
    options: {
      pendingOnly?: boolean;
      claimedOnly?: boolean;
    } = {},
  ): MessageRecord[] {
    const agent = this.agents.findById(agentId);
    if (!agent) {
      throw coreErrors.agentNotFound(agentId);
    }

    return this.messages.listInboxForAgent(agentId, options);
  }

  public getMessage(messageId: string): MessageRecord {
    const message = this.messages.findById(messageId);
    if (!message) {
      throw coreErrors.messageNotFound(messageId);
    }

    return message;
  }

  public listMessagesBySession(sessionId: string): MessageRecord[] {
    const session = this.sessions.findById(sessionId);
    if (!session) {
      throw coreErrors.sessionNotFound(sessionId);
    }

    return this.messages.listBySessionId(sessionId);
  }

  /** Read collaboration messages without claiming or changing any inbox state. */
  public queryMessages(
    sessionId: string,
    input: {
      memberName?: string;
      memberId?: string;
      correlationId?: string;
      beforeMessageId?: string;
      limit?: number;
    },
  ) {
    if (!this.sessions.findById(sessionId))
      throw coreErrors.sessionNotFound(sessionId);
    const members = this.agents.listBySessionId(sessionId);
    const member =
      input.memberId || input.memberName
        ? members.find(
            (item) =>
              (!input.memberId || item.id === input.memberId) &&
              (!input.memberName || item.agentName === input.memberName),
          )
        : undefined;
    if ((input.memberId || input.memberName) && !member)
      throw coreErrors.invalidInput(
        "Member not found in the current session. Use its exact name from session_context.",
      );
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
    )
      throw coreErrors.invalidInput(
        "limit must be an integer between 1 and 50.",
      );
    const before = input.beforeMessageId
      ? this.getMessage(input.beforeMessageId)
      : undefined;
    if (before && before.sessionId !== sessionId)
      throw coreErrors.invalidInput(
        "Message cursor does not belong to this session.",
      );
    const limit = input.limit ?? 20;
    const rows = this.messages.listBySessionId(sessionId, {
      ...(member ? { memberId: member.id } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(before ? { before } : {}),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const names = new Map(members.map((item) => [item.id, item.agentName]));
    return {
      sessionId,
      order: "newest_first",
      hasMore: rows.length > limit,
      nextBeforeMessageId: rows.length > limit ? page.at(-1)!.id : null,
      messages: page.map((message) => {
        const serialized =
          typeof message.payload === "string"
            ? message.payload
            : JSON.stringify(message.payload);
        const payloadTruncated = serialized.length > 12000;
        return {
          ...message,
          fromName: names.get(message.fromAgentId),
          toName: message.toAgentId ? names.get(message.toAgentId) : null,
          payload: payloadTruncated
            ? serialized.slice(0, 12000)
            : message.payload,
          payloadTruncated,
        };
      }),
    };
  }

  public resolveHostMessage(
    messageId: string,
    agentId: string,
    summary: string,
  ): MessageRecord {
    return this.messages.transaction(() => {
      const source = this.getMessage(messageId);
      const host = this.agents.findById(agentId);
      if (
        host?.role !== "host" ||
        host.sessionId !== source.sessionId ||
        source.toAgentId !== agentId
      )
        throw coreErrors.invalidInput(
          "Only the receiving Host can resolve this message.",
        );
      if (!summary.trim())
        throw coreErrors.invalidInput("Resolution summary must not be empty.");
      const completed = this.completeMessage(messageId, agentId);
      const isClientInput =
        source.payload &&
        typeof source.payload === "object" &&
        "kind" in source.payload &&
        source.payload.kind === "web_user_message";
      if (isClientInput)
        this.sendMessage({
          sessionId: source.sessionId,
          fromAgentId: agentId,
          toAgentId: source.fromAgentId,
          type: "result",
          payload: {
            kind: "host_reply",
            content: summary,
            inReplyTo: source.id,
          },
          correlationId: source.correlationId ?? source.id,
          idempotencyKey: `host-resolve:${source.id}`,
        });
      return completed;
    });
  }

  public getSessionQueueStats(sessionId: string): AgentQueueStats[] {
    const session = this.sessions.findById(sessionId);
    if (!session) {
      throw coreErrors.sessionNotFound(sessionId);
    }

    return this.messages.listQueueStatsForSession(sessionId);
  }

  public claimNext(
    agentId: string,
    options: {
      types?: MessageType[];
      fromAgentId?: string;
      correlationId?: string;
      identity?: string;
      flow?: "host" | "worker";
      ownerToken?: string;
    } = {},
  ): MessageRecord | null {
    const agent = this.agents.findById(agentId);
    if (!agent) {
      throw coreErrors.agentNotFound(agentId);
    }

    this.assertCurrentWaitChain(options);

    return this.messages.claimNextForAgent(agentId, now(), options);
  }

  public completeMessage(
    messageId: string,
    agentId: string,
    options: {
      identity?: string;
      flow?: "host" | "worker";
      ownerToken?: string;
    } = {},
  ): MessageRecord {
    if (this.messages.isManagedProxy(agentId)) {
      throw coreErrors.invalidInput(
        "Managed proxy results must be finalized by the delivery executor.",
      );
    }
    const agent = this.agents.findById(agentId);
    if (!agent) {
      throw coreErrors.agentNotFound(agentId);
    }

    this.assertCurrentWaitChain(options);

    const completed = this.messages.markProcessed(messageId, agentId, now());
    if (completed) {
      return completed;
    }

    this.throwMessageTransitionError(messageId, agentId);
  }

  public failMessage(
    messageId: string,
    agentId: string,
    reason?: string,
    options: {
      identity?: string;
      flow?: "host" | "worker";
      ownerToken?: string;
    } = {},
  ): MessageRecord {
    if (this.messages.isManagedProxy(agentId)) {
      throw coreErrors.invalidInput(
        "Managed proxy results must be finalized by the delivery executor.",
      );
    }
    const agent = this.agents.findById(agentId);
    if (!agent) {
      throw coreErrors.agentNotFound(agentId);
    }

    this.assertCurrentWaitChain(options);

    const failed = this.messages.markFailed(messageId, agentId, now(), reason);
    if (failed) {
      return failed;
    }

    this.throwMessageTransitionError(messageId, agentId);
  }

  public acknowledge(messageId: string, processed: boolean): AckPayload {
    const message = this.messages.findById(messageId);
    if (!message) {
      throw coreErrors.messageNotFound(messageId);
    }
    if (message.toAgentId && this.messages.isManagedProxy(message.toAgentId)) {
      throw coreErrors.invalidInput(
        "Managed proxy messages cannot be acknowledged by waiting clients.",
      );
    }

    this.messages.acknowledge(messageId, processed, now());
    return {
      messageId,
      processed,
    };
  }

  private throwMessageTransitionError(
    messageId: string,
    agentId: string,
  ): never {
    const message = this.messages.findById(messageId);
    if (!message) {
      throw coreErrors.messageNotFound(messageId);
    }

    if (
      message.processingStatus === "processed" ||
      message.processingStatus === "failed"
    ) {
      throw coreErrors.messageAlreadyFinished(messageId);
    }

    if (
      message.processingStatus === "claimed" &&
      message.claimedByAgentId !== agentId
    ) {
      throw coreErrors.messageAlreadyClaimed(messageId);
    }

    throw coreErrors.messageNotClaimedByAgent(messageId, agentId);
  }

  private assertCurrentWaitChain(input: {
    identity?: string;
    flow?: "host" | "worker";
    ownerToken?: string;
  }): void {
    if (!input.identity || !input.flow || !input.ownerToken) {
      return;
    }

    const identityKey = `${input.flow}:${input.identity}`;
    const existing = this.identityLeases.findByIdentityKey(identityKey);
    if (!existing || existing.ownerToken !== input.ownerToken) {
      throw coreErrors.waitChainSuperseded(input.identity, input.flow);
    }
  }
}
