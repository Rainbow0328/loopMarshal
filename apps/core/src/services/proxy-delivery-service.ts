import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ProxyDelivery, ManagedAgentSetup } from "@loopmarshal/protocol";
import {
  DeliveryRepository,
  MemberRouteRepository,
  MessageRepository,
  inStoreTransaction,
} from "@loopmarshal/store";
import { CoreError, coreErrors } from "../errors.js";
import {
  NativeCliSessionAdapter,
  type NativeSessionAdapter,
  type NativeTurnResult,
} from "./native-session-adapters.js";
import { ProxyProcessError } from "./proxy-process.js";
import {
  acquireProxyCoreOwnership,
  releaseProxyCoreOwnership,
} from "./proxy-core-ownership.js";

export class ProxyDeliveryService {
  private readonly ownerId = randomUUID();
  private readonly running = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private ticking = false;
  private ownsDatabase = false;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly deliveries: DeliveryRepository,
    private readonly routes: MemberRouteRepository,
    private readonly messages: MessageRepository,
    private readonly notify: (sessionId: string) => void,
    private readonly adapter: NativeSessionAdapter = new NativeCliSessionAdapter(),
    private readonly prepareContext?: (delivery: ProxyDelivery) => Promise<{
      prompt: string;
      automaticSetup?: ManagedAgentSetup;
      cleanup: () => void;
    }>,
    private readonly bindCreatedNativeSession?: (
      sessionId: string,
      agentId: string,
      expectedVersion: number,
      nativeSessionId: string,
      version: string,
    ) => unknown,
    private readonly failNativeSessionCreation?: (
      sessionId: string,
      agentId: string,
      expectedVersion: number,
      message: string,
    ) => unknown,
    private readonly queueKnowledgeMaintenance?: (
      sessionId: string,
      workerAgentId: string,
      hostAgentId: string,
      correlationId: string,
      result: string,
      idempotencyKey: string,
    ) => void,
  ) {}

  public acquireOwnership(): void {
    if (this.ownsDatabase) return;
    acquireProxyCoreOwnership(this.database, this.ownerId);
    this.ownsDatabase = true;
  }

  public start(): void {
    if (this.timer) return;
    this.acquireOwnership();
    this.stopping = false;
    try {
      const recovered = inStoreTransaction(this.database, () => {
        const recovered = this.deliveries.recoverInterrupted();
        for (const delivery of recovered) {
          const source = this.messages.findById(delivery.messageId);
          if (!source) continue;
          this.messages.insertAtomically({
            message: {
              id: randomUUID(),
              sessionId: delivery.sessionId,
              fromAgentId: delivery.targetAgentId,
              toAgentId: delivery.replyToAgentId,
              type: "result",
              payload: {
                kind: "proxy_report.v1",
                status: "unknown",
                content: delivery.error,
                result: delivery.error,
                deliveryId: delivery.id,
                inReplyToMessageId: delivery.messageId,
                nativeSessionId: delivery.snapshot.binding.nativeSessionId,
              },
              correlationId: source.correlationId ?? source.id,
              idempotencyKey: `proxy-recovery:${delivery.id}:${delivery.attemptId}`,
              processingStatus: "pending",
              deliveryStatus: "sent",
              createdAt: new Date().toISOString(),
            },
            processedAt: new Date().toISOString(),
          });
        }
        return recovered;
      });
      for (const delivery of recovered) this.notify(delivery.sessionId);
    } catch (error) {
      releaseProxyCoreOwnership(this.database, this.ownerId);
      this.ownsDatabase = false;
      throw error;
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const execution of this.running.values()) execution.controller.abort();
    await Promise.allSettled(
      [...this.running.values()].map((execution) => execution.promise),
    );
    if (this.ownsDatabase)
      releaseProxyCoreOwnership(this.database, this.ownerId);
    this.ownsDatabase = false;
  }

  public list(sessionId: string) {
    return this.deliveries.list(sessionId);
  }
  public events(id: string, afterSequence = 0) {
    this.requireDelivery(id);
    return this.deliveries.events(id, afterSequence);
  }
  public activity(sessionId: string) {
    return this.deliveries.activity(sessionId);
  }

  public async verify(
    sessionId: string,
    agentId: string,
    expectedVersion: number,
  ): Promise<void> {
    const route = this.routes.get(agentId);
    if (!route || route.sessionId !== sessionId)
      throw coreErrors.agentNotFound(agentId);
    if (route.bindingVersion !== expectedVersion)
      throw new CoreError(
        "MEMBER_ROUTE_CONFLICT",
        "Binding changed; refresh and retry.",
        409,
      );
    if (
      route.accessMode !== "managed_proxy" ||
      !route.binding ||
      !route.nativeSessionKey
    )
      throw coreErrors.invalidInput(
        "This member has no native session binding.",
      );
    if (route.bindingStatus === "disabled")
      throw coreErrors.invalidInput(
        "Enable the member before verifying its session.",
      );
    const installation = this.routes.getInstallation(
      route.binding.installationId,
    );
    if (!installation)
      throw coreErrors.invalidInput("Tool installation is missing.");
    let evidence: Awaited<ReturnType<NativeSessionAdapter["verify"]>>;
    try {
      evidence = await this.adapter.verify(
        {
          binding: route.binding,
          installation,
          nativeSessionKey: route.nativeSessionKey,
        },
        AbortSignal.timeout(30000),
      );
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "Native session verification failed.";
      inStoreTransaction(this.database, () => {
        const timestamp = new Date().toISOString();
        const changed = this.database
          .prepare(
            `UPDATE session_member_routes SET binding_status = 'blocked',
          last_error = ?, updated_at = ? WHERE agent_id = ? AND binding_version = ? AND binding_status != 'disabled'`,
          )
          .run(reason, timestamp, agentId, expectedVersion);
        if (Number(changed.changes) === 1)
          this.database
            .prepare(
              `INSERT INTO member_route_events
          (id, session_id, agent_id, binding_version, reason, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              sessionId,
              agentId,
              expectedVersion,
              `Verification failed: ${reason}`,
              JSON.stringify(route),
              JSON.stringify(this.routes.get(agentId)),
              timestamp,
            );
      });
      this.notify(sessionId);
      throw error;
    }
    inStoreTransaction(this.database, () => {
      const timestamp = new Date().toISOString();
      const changed = this.database
        .prepare(
          `UPDATE session_member_routes SET binding_status = 'ready',
        verified_at = ?, verified_tool_version = ?, last_error = NULL, updated_at = ? WHERE agent_id = ? AND binding_version = ?`,
        )
        .run(timestamp, evidence.version, timestamp, agentId, expectedVersion);
      if (Number(changed.changes) !== 1)
        throw new CoreError(
          "MEMBER_ROUTE_CONFLICT",
          "Binding changed during verification.",
          409,
        );
      this.database
        .prepare(
          `INSERT INTO member_route_events
        (id, session_id, agent_id, binding_version, reason, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          sessionId,
          agentId,
          expectedVersion,
          `Verified native session (${evidence.version}): ${evidence.evidence}`,
          JSON.stringify(route),
          JSON.stringify(this.routes.get(agentId)),
          timestamp,
        );
      this.deliveries.unblockVerified(agentId, expectedVersion);
    });
    this.notify(sessionId);
    this.tick();
  }

  public async cancel(id: string): Promise<ProxyDelivery> {
    const delivery = this.requireDelivery(id);
    if (
      delivery.state === "queued" ||
      (delivery.state === "blocked" && !this.running.has(id))
    ) {
      inStoreTransaction(this.database, () => {
        this.database
          .prepare(
            "UPDATE message_deliveries SET state = 'cancelled', updated_at = ? WHERE id = ? AND state IN ('queued','blocked')",
          )
          .run(new Date().toISOString(), id);
        this.database
          .prepare(
            "UPDATE messages SET processing_status = 'failed', delivery_status = 'delivery_failed', failure_reason = 'Cancelled before execution', failed_at = ? WHERE id = ? AND processing_status = 'pending'",
          )
          .run(new Date().toISOString(), delivery.messageId);
        this.deliveries.addEvent(id, null, "cancelled_before_execution", {});
        if (!delivery.resultMessageId) {
          const source = this.messages.findById(delivery.messageId);
          const timestamp = new Date().toISOString();
          const text = "投递已取消，未重新执行任务。";
          const report = this.messages.insertAtomically({
            message: {
              id: randomUUID(),
              sessionId: delivery.sessionId,
              fromAgentId: delivery.targetAgentId,
              toAgentId: delivery.replyToAgentId,
              type: "result",
              payload: {
                kind: "proxy_report.v1",
                status: "cancelled",
                content: text,
                result: text,
                deliveryId: delivery.id,
                inReplyToMessageId: delivery.messageId,
                nativeSessionId: delivery.snapshot.binding.nativeSessionId,
              },
              correlationId: source?.correlationId ?? delivery.messageId,
              idempotencyKey: `proxy-cancel:${delivery.id}`,
              processingStatus: "pending",
              deliveryStatus: "sent",
              createdAt: timestamp,
            },
            processedAt: timestamp,
          });
          if (!report)
            throw new Error("Could not persist cancellation report.");
          this.deliveries.setResult(delivery.id, report.message.id);
        }
      });
    } else if (["delivering", "awaiting_result"].includes(delivery.state)) {
      const execution = this.running.get(id);
      if (!execution)
        throw new CoreError(
          "MEMBER_ROUTE_BUSY",
          "Execution is not owned by this Core; reconcile it first.",
          409,
        );
      execution.controller.abort();
      await execution.promise;
      const current = this.requireDelivery(id);
      if (current.state === "blocked" && current.attemptId === null)
        return this.cancel(id);
    }
    this.notify(delivery.sessionId);
    return this.requireDelivery(id);
  }

  /** An explicit operator decision after examining native history; never replays a task. */
  public resolveUnknown(
    id: string,
    input: {
      outcome: "reported" | "failed";
      summary: string;
      confirmedStopped: boolean;
    },
  ): ProxyDelivery {
    const delivery = this.requireDelivery(id);
    if (delivery.state !== "unknown" || !delivery.attemptId)
      throw coreErrors.invalidInput(
        "Only uncertain executions require this operation.",
      );
    if (!input.confirmedStopped || !input.summary.trim())
      throw coreErrors.invalidInput(
        "Confirm that the native execution has stopped and provide a review summary.",
      );
    this.finalize(
      delivery,
      {
        outcome: input.outcome,
        text: input.summary,
        nativeSessionId: delivery.snapshot.binding.nativeSessionId,
        exitCode: null,
      },
      true,
    );
    return this.requireDelivery(id);
  }

  private tick(): void {
    if (this.stopping || this.ticking || !this.ownsDatabase) return;
    this.ticking = true;
    try {
      while (this.running.size < 4) {
        const delivery = this.deliveries.claim(this.ownerId);
        if (!delivery) break;
        const controller = new AbortController();
        const promise = this.execute(delivery, controller).finally(() => {
          this.running.delete(delivery.id);
          this.notify(delivery.sessionId);
          // Reuse the released slot immediately, including tasks in the same native session.
          this.tick();
        });
        this.running.set(delivery.id, { controller, promise });
        void promise.catch((error) => {
          console.error(
            "Proxy result persistence failed; execution requires recovery.",
            error,
          );
        });
      }
    } catch (error) {
      console.error(
        "Proxy delivery scheduling failed; durable tasks remain available for recovery.",
        error,
      );
    } finally {
      this.ticking = false;
    }
  }

  private async execute(
    delivery: ProxyDelivery,
    controller: AbortController,
  ): Promise<void> {
    const attemptId = delivery.attemptId!;
    let invoking = false;
    let context:
      | Awaited<ReturnType<NonNullable<typeof this.prepareContext>>>
      | undefined;
    let activeSnapshot = delivery.snapshot;
    let activeVersion = delivery.bindingVersion;
    let initializing = false;
    try {
      const route = this.routes.get(delivery.targetAgentId);
      if (
        !route ||
        route.bindingVersion !== delivery.bindingVersion ||
        route.accessMode !== "managed_proxy" ||
        !route.binding
      ) {
        throw new ProxyProcessError(
          "工具绑定已变化，请刷新成员接入设置后重试。",
          false,
        );
      }
      initializing = route.bindingStatus === "initializing";
      if (!initializing) {
        if (route.bindingStatus !== "ready")
          throw new ProxyProcessError(
            route.lastError ?? "成员工具尚未就绪。",
            false,
          );
        // The binding is verified when connected or explicitly rechecked. Each turn
        // resumes the recorded ID; process and response failures are persisted below.
        if (!route.verifiedAt)
          throw new ProxyProcessError("请先检查此成员的工具连接。", false);
      }
      if (controller.signal.aborted)
        throw new ProxyProcessError("Cancelled before execution.", false);
      const message = this.messages.findById(delivery.messageId);
      if (!message)
        throw new ProxyProcessError("Original message is missing.", false);
      const payload =
        typeof message.payload === "string"
          ? message.payload
          : JSON.stringify(message.payload);
      const member = this.database
        .prepare(
          "SELECT agent_name AS name, role_description AS duty FROM agents WHERE id = ?",
        )
        .get(delivery.targetAgentId) as
        | { name: string; duty: string | null }
        | undefined;
      context = await this.prepareContext?.(delivery);
      const prompt = `LoopMarshal task. ${initializing ? "This is a new native conversation; start fresh and use this first task as its opening message." : "Continue this existing conversation and preserve its history."}\nMember: ${member?.name ?? delivery.targetAgentId}\nResponsibility: ${member?.duty ?? "Complete the assigned task"}\nDelivery: ${delivery.id}\nReturn the task result in your final response. Do not enter a LoopMarshal await loop.\n${context?.prompt ?? ""}\n\n${payload}`;
      const callbacks = {
        signal: controller.signal,
        ...(context?.automaticSetup
          ? { automaticSetup: context.automaticSetup }
          : {}),
        onStarted: (pid: number) => {
          this.deliveries.recordProcess(delivery.id, attemptId, pid);
          this.deliveries.addEvent(delivery.id, attemptId, "process_started", {
            pid,
          });
        },
        onEvent: (type: string, event: unknown) => {
          this.deliveries.addEvent(delivery.id, attemptId, type, event);
        },
      };
      this.deliveries.transition(
        delivery.id,
        attemptId,
        ["delivering"],
        "awaiting_result",
      );
      invoking = true;
      let result: NativeTurnResult;
      if (initializing) {
        if (!this.adapter.create || !this.bindCreatedNativeSession)
          throw new ProxyProcessError(
            "当前工具暂不支持自动创建原生会话。",
            false,
          );
        const created = await this.adapter.create(
          delivery.snapshot,
          prompt,
          callbacks,
        );
        if (!created.nativeSessionId)
          throw new ProxyProcessError("工具没有返回新建会话编号。", true);
        this.bindCreatedNativeSession(
          delivery.sessionId,
          delivery.targetAgentId,
          route.bindingVersion,
          created.nativeSessionId,
          created.version,
        );
        const bound = this.routes.get(delivery.targetAgentId);
        if (!bound?.binding || bound.bindingStatus !== "ready")
          throw new ProxyProcessError("新建原生会话后绑定未能就绪。", true);
        activeSnapshot = {
          ...delivery.snapshot,
          binding: bound.binding,
          nativeSessionKey: bound.nativeSessionKey!,
        };
        activeVersion = bound.bindingVersion;
        if (
          !this.deliveries.rebind(
            delivery.id,
            attemptId,
            activeSnapshot,
            activeVersion,
          )
        )
          throw new ProxyProcessError(
            "新原生会话已创建，但投递记录未能更新，请检查成员接入状态。",
            true,
          );
        result = created.result;
      } else {
        result = await this.adapter.execute(
          delivery.snapshot,
          prompt,
          callbacks,
        );
      }
      this.finalize(
        {
          ...delivery,
          snapshot: activeSnapshot,
          bindingVersion: activeVersion,
        },
        result,
      );
    } catch (error) {
      if (invoking && controller.signal.aborted && this.adapter.abort) {
        try {
          await this.adapter.abort(activeSnapshot);
        } catch {
          /* Cancellation is still uncertain; retain the native-session lock. */
        }
      }
      const text =
        error instanceof Error ? error.message : "Native execution failed.";
      const beforeStart =
        !invoking || (error instanceof ProxyProcessError && !error.started);
      if (initializing) {
        if (this.failNativeSessionCreation)
          this.failNativeSessionCreation(
            delivery.sessionId,
            delivery.targetAgentId,
            delivery.bindingVersion,
            text,
          );
        else
          this.database
            .prepare(
              "UPDATE session_member_routes SET binding_status = 'blocked', last_error = ?, updated_at = ? WHERE agent_id = ? AND binding_version = ?",
            )
            .run(
              text,
              new Date().toISOString(),
              delivery.targetAgentId,
              delivery.bindingVersion,
            );
      }
      this.finalize(
        delivery,
        {
          outcome: beforeStart ? "blocked" : "unknown",
          text,
          nativeSessionId: null,
          exitCode: null,
        },
        false,
        beforeStart,
      );
    } finally {
      context?.cleanup();
    }
  }

  private finalize(
    delivery: ProxyDelivery,
    result: NativeTurnResult,
    reviewed = false,
    notStarted = false,
  ): void {
    inStoreTransaction(this.database, () => {
      const current = this.requireDelivery(delivery.id);
      if (current.attemptId !== delivery.attemptId || current.resultMessageId)
        return;
      if (!reviewed && current.ownerId !== this.ownerId) return;
      const allowed = reviewed
        ? ["unknown" as const]
        : ["delivering" as const, "awaiting_result" as const];
      const outcome =
        result.nativeSessionId &&
        result.nativeSessionId !== delivery.snapshot.binding.nativeSessionId
          ? "unknown"
          : result.outcome;
      const state = outcome === "reported" ? "completed" : outcome;
      if (
        !this.deliveries.transition(
          delivery.id,
          delivery.attemptId!,
          allowed,
          state,
          outcome === "reported" ? null : result.text,
        )
      )
        return;
      this.deliveries.completeAttempt(
        delivery.attemptId!,
        state,
        result.exitCode,
      );
      this.deliveries.addEvent(
        delivery.id,
        delivery.attemptId,
        reviewed ? "operator_reconciled" : "execution_finished",
        { outcome, nativeSessionId: result.nativeSessionId },
      );
      if (outcome === "blocked") {
        this.database
          .prepare(
            "UPDATE session_member_routes SET binding_status = 'blocked', last_error = ?, updated_at = ? WHERE agent_id = ? AND binding_version = ?",
          )
          .run(
            result.text,
            new Date().toISOString(),
            delivery.targetAgentId,
            delivery.bindingVersion,
          );
      }
      const timestamp = new Date().toISOString();
      const source = this.messages.findById(delivery.messageId);
      if (!source) throw new Error("Original message no longer exists.");
      const targetRole = this.database
        .prepare("SELECT role FROM agents WHERE id = ?")
        .get(delivery.targetAgentId)?.role;
      const clientInput =
        targetRole === "host" &&
        source.fromAgentId === delivery.targetAgentId &&
        source.toAgentId === delivery.targetAgentId &&
        source.payload &&
        typeof source.payload === "object" &&
        "kind" in source.payload &&
        source.payload.kind === "web_user_message";
      const diagnostic =
        outcome === "unknown" || (outcome === "blocked" && notStarted);
      if (outcome === "blocked" && notStarted) {
        this.database
          .prepare(
            "UPDATE messages SET processing_status = 'pending', claimed_by_agent_id = NULL, claimed_at = NULL WHERE id = ? AND processing_status = 'claimed'",
          )
          .run(delivery.messageId);
        this.database
          .prepare(
            "UPDATE message_deliveries SET attempt_id = NULL, owner_id = NULL WHERE id = ?",
          )
          .run(delivery.id);
      }
      const changed = diagnostic
        ? source
        : outcome === "reported"
          ? this.messages.markProcessed(
              delivery.messageId,
              delivery.targetAgentId,
              timestamp,
            )
          : this.messages.markFailed(
              delivery.messageId,
              delivery.targetAgentId,
              timestamp,
              result.text,
            );
      if (!changed)
        throw new Error(
          "Original message is no longer owned by the proxy executor.",
        );
      const report = this.messages.insertAtomically({
        message: {
          id: randomUUID(),
          sessionId: delivery.sessionId,
          fromAgentId: delivery.targetAgentId,
          toAgentId: delivery.replyToAgentId,
          type: "result",
          payload: {
            kind: clientInput
              ? "host_reply"
              : targetRole === "knowledge_keeper" && outcome === "reported"
                ? "knowledge_maintenance_report"
                : "proxy_report.v1",
            content: result.text,
            result: result.text,
            status: outcome === "reported" ? "ready_for_review" : outcome,
            deliveryId: delivery.id,
            inReplyToMessageId: delivery.messageId,
            nativeSessionId: delivery.snapshot.binding.nativeSessionId,
          },
          correlationId: source.correlationId ?? source.id,
          idempotencyKey: diagnostic
            ? `proxy-status:${delivery.id}:${delivery.attemptId}`
            : `proxy-report:${delivery.id}`,
          deliveryStatus: clientInput ? "delivered" : "sent",
          processingStatus: clientInput ? "processed" : "pending",
          ...(clientInput ? { processedAt: timestamp } : {}),
          createdAt: timestamp,
        },
        processedAt: timestamp,
      });
      if (!report) throw new Error("Could not persist native report.");
      if (targetRole === "host" && !clientInput && outcome === "reported") {
        // A Host's final review is a user-facing update. Keep the original
        // directed report and its routing intact, and publish a processed copy
        // to the Host's client conversation without creating another execution.
        this.messages.insertAtomically({
          message: {
            id: randomUUID(),
            sessionId: delivery.sessionId,
            fromAgentId: delivery.targetAgentId,
            toAgentId: delivery.targetAgentId,
            type: "result",
            payload: {
              kind: "host_reply",
              content: result.text,
              inReplyTo: source.id,
              deliveryId: delivery.id,
            },
            correlationId: source.correlationId ?? source.id,
            idempotencyKey: `proxy-host-update:${delivery.id}`,
            deliveryStatus: "delivered",
            processingStatus: "processed",
            processedAt: timestamp,
            createdAt: timestamp,
          },
          processedAt: timestamp,
        });
      }
      if (
        outcome === "reported" &&
        this.database
          .prepare("SELECT 1 FROM agents WHERE id = ? AND role = 'worker'")
          .get(delivery.targetAgentId)
      ) {
        const host = this.database
          .prepare("SELECT host_agent_id AS id FROM sessions WHERE id = ?")
          .get(delivery.sessionId) as { id: string } | undefined;
        if (host)
          this.queueKnowledgeMaintenance?.(
            delivery.sessionId,
            delivery.targetAgentId,
            host.id,
            source.correlationId ?? source.id,
            result.text,
            `knowledge-after-worker:${delivery.id}`,
          );
      }
      if (!diagnostic)
        this.deliveries.setResult(delivery.id, report.message.id);
      if (diagnostic)
        this.database
          .prepare(
            "UPDATE message_deliveries SET state = 'blocked', error = 'Review the interrupted member execution before resuming Host' WHERE message_id = ? AND state = 'queued'",
          )
          .run(report.message.id);
    });
    this.notify(delivery.sessionId);
  }

  private requireDelivery(id: string): ProxyDelivery {
    const delivery = this.deliveries.get(id);
    if (!delivery)
      throw new CoreError("INVALID_INPUT", "Delivery was not found.", 404);
    return delivery;
  }
}
