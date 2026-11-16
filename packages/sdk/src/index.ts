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

import type {
  AckPayload,
  AttachSessionInput,
  AcquireIdentityLeaseInput,
  Agent,
  AgentHeartbeat,
  AgentQueueStats,
  CompleteTaskInput,
  CreateSessionInput,
  CreateTaskInput,
  IdentityLease,
  JoinSessionByNameInput,
  JoinSessionInput,
  LeaveAgentResult,
  MessageRecord,
  MessageProcessCompleteInput,
  MessageProcessFailInput,
  RemoveSessionMemberInput,
  ReleaseIdentityLeaseInput,
  SendMessageInput,
  SessionInsight,
  SessionConsole,
  Session,
  SessionJoinResult,
  SessionSummary,
  Task,
  UpdateSessionInsightInput,
  UpdateWindowBindingDefaultsInput,
  UpdateWindowRuntimeStateInput,
  WindowBinding,
} from "@loopmarshal/protocol";
import { errorCodes } from "@loopmarshal/protocol";

export class LoopMarshalSdkError extends Error {
  public readonly statusCode: number;
  public readonly code: string | undefined;

  public constructor(
    message: string,
    options: {
      statusCode: number;
      code?: string;
    },
  ) {
    super(message);
    this.statusCode = options.statusCode;
    this.code = options.code;
  }
}

export type LoopMarshalClientOptions = {
  baseUrl?: string;
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
};

export type EnsureHostedSessionResult = SessionJoinResult & {
  reusedExistingSession: boolean;
};

export type AttachSessionResult = SessionJoinResult & {
  reusedExistingSession: boolean;
};

import type {
  DiscussionRoom,
  DiscussionMessage,
  DiscussionKnowledge,
  ToolInstallJob,
  ToolInstallCatalogEntry,
  ToolInstallRequest,
  ToolConfigPreview,
} from "@loopmarshal/protocol";
export type {
  DiscussionRoom,
  DiscussionMessage,
  DiscussionKnowledge,
} from "@loopmarshal/protocol";

export class LoopMarshalClient {
  public getDiscussionKnowledgeSources(roomId: string, entryId: string) {
    return this.request<Array<DiscussionMessage & { truncated: boolean }>>(
      `/api/discussions/${encodeURIComponent(roomId)}/knowledge/${encodeURIComponent(entryId)}/sources`,
    );
  }
  public getToolInstaller() {
    return this.request<{
      root: string;
      npmAvailable: boolean;
      catalog: ToolInstallCatalogEntry[];
      jobs: ToolInstallJob[];
    }>("/api/tool-installer");
  }
  public saveToolInstallRoot(root: string) {
    return this.request("/api/tool-installer/settings", {
      method: "PUT",
      body: { root },
    });
  }
  public startToolInstall(input: ToolInstallRequest) {
    return this.request<ToolInstallJob>("/api/tool-installer/jobs", {
      method: "POST",
      body: input,
    });
  }
  public previewToolModel(
    profileId: string,
    input: {
      modelId: string;
      expectedFingerprint: string;
      responsesConfirmed?: boolean | undefined;
    },
  ) {
    return this.request<ToolConfigPreview>(
      `/api/tool-config/profiles/${encodeURIComponent(profileId)}/model-preview`,
      { method: "POST", body: input },
    );
  }
  public stopDiscussion(id: string) {
    return this.request(`/api/discussions/${encodeURIComponent(id)}/stop`, {
      method: "POST",
      body: {},
    });
  }
  public getDiscussionGrants(sessionId: string) {
    return this.request<string[]>(
      `/api/discussions/access/${encodeURIComponent(sessionId)}`,
    );
  }
  public setDiscussionGrant(
    sessionId: string,
    roomId: string,
    enabled: boolean,
  ) {
    return this.request<string[]>(
      `/api/discussions/access/${encodeURIComponent(sessionId)}/${encodeURIComponent(roomId)}`,
      { method: "PUT", body: { enabled } },
    );
  }
  public listDiscussionKnowledge(id: string) {
    return this.request<DiscussionKnowledge[]>(
      `/api/discussions/${encodeURIComponent(id)}/knowledge`,
    );
  }
  public draftDiscussionKnowledge(
    id: string,
    input: { modelId: string; sourceIds: string[] },
  ) {
    return this.request<{ content: string; sourceIds: string[] }>(
      `/api/discussions/${encodeURIComponent(id)}/knowledge/draft`,
      { method: "POST", body: input },
    );
  }
  public saveDiscussionKnowledge(
    id: string,
    input: { title: string; content: string; sourceIds: string[] },
  ) {
    return this.request<DiscussionKnowledge>(
      `/api/discussions/${encodeURIComponent(id)}/knowledge`,
      { method: "POST", body: input },
    );
  }

  public listDiscussions() {
    return this.request<DiscussionRoom[]>("/api/discussions");
  }
  public createDiscussion(input: {
    name: string;
    modelIds: string[];
    cliMembers?: Array<{
      installationId: string;
      runtimeNamespace?: string | undefined;
    }>;
  }) {
    return this.request<DiscussionRoom>("/api/discussions", {
      method: "POST",
      body: input,
    });
  }
  public listDiscussionMessages(id: string, before?: string, limit?: number) {
    const query = new URLSearchParams();
    if (before) query.set("before", before);
    if (limit !== undefined) query.set("limit", String(limit));
    return this.request<DiscussionMessage[]>(
      `/api/discussions/${encodeURIComponent(id)}/messages${query.size ? `?${query.toString()}` : ""}`,
    );
  }
  public sendDiscussionMessage(
    id: string,
    input: { content: string; memberIds: string[] },
  ) {
    return this.request<DiscussionMessage[]>(
      `/api/discussions/${encodeURIComponent(id)}/messages`,
      { method: "POST", body: input },
    );
  }

  public async createSessionSetup(
    input: import("@loopmarshal/protocol").CreateSessionSetupInput,
  ) {
    return this.request<
      SessionJoinResult & { members: Agent[]; warnings: string[] }
    >("/api/sessions/setup", { method: "POST", body: input });
  }

  public async discoverSessions(
    input: import("@loopmarshal/protocol").DiscoverSessionsInput = {},
  ): Promise<import("@loopmarshal/protocol").DiscoverSessionsResult> {
    return this.request("/api/sessions/discover", {
      method: "POST",
      body: input,
    });
  }

  public async refreshAgentSetups(
    sessionId: string,
  ): Promise<{ setups: import("@loopmarshal/protocol").ManagedAgentSetup[] }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/agent-setups/refresh`,
      { method: "POST", body: {} },
    );
  }
  public async createAwaitMember(
    sessionId: string,
    input: {
      agentName: string;
      role?: "worker" | "knowledge_keeper" | undefined;
      roleDescription: string;
      accessMode: "mcp_await" | "cli_await";
    },
  ) {
    const response = await this.request<{
      member: import("@loopmarshal/protocol").SessionMemberRouteView;
    }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/member-routes/await-members`,
      { method: "POST", body: input },
    );
    return response.member;
  }
  public async issueMemberCredential(
    sessionId: string,
    agentId: string,
    label: string,
  ) {
    return this.request<{
      credential: import("@loopmarshal/protocol").MemberCredential;
      token: string;
    }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/member-routes/${encodeURIComponent(agentId)}/credentials`,
      { method: "POST", body: { label } },
    );
  }
  public async listMemberCredentials(sessionId: string, agentId: string) {
    const result = await this.request<{
      credentials: import("@loopmarshal/protocol").MemberCredential[];
    }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/member-routes/${encodeURIComponent(agentId)}/credentials`,
    );
    return result.credentials;
  }
  public async revokeMemberCredential(
    sessionId: string,
    agentId: string,
    credentialId: string,
  ) {
    return this.request<{ revoked: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/member-routes/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
    );
  }
  public async sendByName(
    input: import("@loopmarshal/protocol").NamedSendInput,
  ) {
    const response = await this.request<{ messages: MessageRecord[] }>(
      "/api/messages/send-by-name",
      { method: "POST", body: input },
    );
    return response.messages;
  }
  public async listDeliveries(sessionId: string) {
    const response = await this.request<{
      deliveries: import("@loopmarshal/protocol").ProxyDelivery[];
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/deliveries`);
    return response.deliveries;
  }

  public async getMemberActivity(sessionId: string) {
    const response = await this.request<{
      members: import("@loopmarshal/protocol").MemberActivity[];
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/activity`);
    return response.members;
  }

  public async verifyMemberRoute(
    sessionId: string,
    agentId: string,
    expectedBindingVersion: number,
  ) {
    return this.request<{ verified: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/member-routes/${encodeURIComponent(agentId)}/verify`,
      { method: "POST", body: { expectedBindingVersion } },
    );
  }

  public async retryNativeSessionCreation(
    sessionId: string,
    agentId: string,
    expectedBindingVersion: number,
  ) {
    const response = await this.request<{
      member: import("@loopmarshal/protocol").SessionMemberRouteView;
    }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/member-routes/${encodeURIComponent(agentId)}/retry-create`,
      { method: "POST", body: { expectedBindingVersion } },
    );
    return response.member;
  }

  public async cancelDelivery(id: string) {
    return this.request<{
      delivery: import("@loopmarshal/protocol").ProxyDelivery;
    }>(`/api/deliveries/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  public async getDeliveryEvents(id: string, after = 0) {
    const response = await this.request<{
      events: import("@loopmarshal/protocol").DeliveryEvent[];
    }>(`/api/deliveries/${encodeURIComponent(id)}/events?after=${after}`);
    return response.events;
  }

  public async reconcileDelivery(
    id: string,
    input: {
      outcome: "reported" | "failed";
      summary: string;
      confirmedStopped: true;
    },
  ) {
    return this.request<{
      delivery: import("@loopmarshal/protocol").ProxyDelivery;
    }>(`/api/deliveries/${encodeURIComponent(id)}/reconcile`, {
      method: "POST",
      body: input,
    });
  }

  public async listToolInstallations(): Promise<
    import("@loopmarshal/protocol").ToolInstallation[]
  > {
    const response = await this.request<{
      installations: import("@loopmarshal/protocol").ToolInstallation[];
    }>("/api/tool-installations");
    return response.installations;
  }

  public async discoverTools() {
    return this.request<{
      candidates: import("@loopmarshal/protocol").ToolDiscoveryCandidate[];
      defaults: Record<import("@loopmarshal/protocol").ProxyToolId, string>;
    }>("/api/tool-config/discover");
  }
  public async checkToolInstallation(
    id: string,
    input: { endpoint?: string } = {},
  ) {
    return this.request<import("@loopmarshal/protocol").ToolCheckResult>(
      `/api/tool-config/installations/${encodeURIComponent(id)}/check`,
      { method: "POST", body: input },
    );
  }
  public async listToolConfigProfiles() {
    return this.request<{
      profiles: import("@loopmarshal/protocol").ToolConfigProfile[];
      defaults: Record<import("@loopmarshal/protocol").ProxyToolId, string>;
    }>("/api/tool-config/profiles");
  }
  public async createToolConfigProfile(
    input: import("@loopmarshal/protocol").CreateToolConfigProfileInput,
  ) {
    return this.request<{
      profile: import("@loopmarshal/protocol").ToolConfigProfile;
    }>("/api/tool-config/profiles", { method: "POST", body: input });
  }
  public async getToolConfigDocuments(profileId: string) {
    return this.request<{
      documents: import("@loopmarshal/protocol").ToolConfigDocument[];
    }>(`/api/tool-config/profiles/${encodeURIComponent(profileId)}/documents`);
  }
  public async previewToolConfig(
    profileId: string,
    input: import("@loopmarshal/protocol").PreviewToolConfigInput,
  ) {
    return this.request<import("@loopmarshal/protocol").ToolConfigPreview>(
      `/api/tool-config/profiles/${encodeURIComponent(profileId)}/preview`,
      { method: "POST", body: input },
    );
  }
  public async applyToolConfig(profileId: string, previewId: string) {
    return this.request<{
      document: import("@loopmarshal/protocol").ToolConfigDocument;
      backup: import("@loopmarshal/protocol").ToolConfigBackup;
    }>(`/api/tool-config/profiles/${encodeURIComponent(profileId)}/apply`, {
      method: "POST",
      body: { previewId },
    });
  }
  public async getToolConfigBackups(profileId: string) {
    return this.request<{
      backups: import("@loopmarshal/protocol").ToolConfigBackup[];
    }>(`/api/tool-config/profiles/${encodeURIComponent(profileId)}/backups`);
  }
  public async restoreToolConfig(profileId: string, backupId: string) {
    return this.request<{
      documents: import("@loopmarshal/protocol").ToolConfigDocument[];
    }>(
      `/api/tool-config/profiles/${encodeURIComponent(profileId)}/backups/${encodeURIComponent(backupId)}/restore`,
      { method: "POST" },
    );
  }

  public async createToolInstallation(
    input: import("@loopmarshal/protocol").CreateToolInstallationInput,
  ) {
    const response = await this.request<{
      installation: import("@loopmarshal/protocol").ToolInstallation;
    }>("/api/tool-installations", { method: "POST", body: input });
    return response.installation;
  }
  public async updateToolInstallation(
    id: string,
    input: import("@loopmarshal/protocol").UpdateToolInstallationInput,
  ) {
    const response = await this.request<{
      installation: import("@loopmarshal/protocol").ToolInstallation;
    }>(`/api/tool-installations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: input,
    });
    return response.installation;
  }
  public async discoverNativeSessions(
    installationId: string,
    input: { workspacePath: string; runtimeNamespace?: string | undefined },
  ) {
    const query = new URLSearchParams({
      workspacePath: input.workspacePath,
      runtimeNamespace: input.runtimeNamespace ?? "",
    });
    return this.request<
      import("@loopmarshal/protocol").NativeSessionDiscoveryResult
    >(
      `/api/tool-installations/${encodeURIComponent(installationId)}/native-sessions?${query.toString()}`,
    );
  }

  public async listMemberRoutes(sessionId: string) {
    const response = await this.request<{
      members: import("@loopmarshal/protocol").SessionMemberRouteView[];
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/member-routes`);
    return response.members;
  }

  public async createProxyMember(
    sessionId: string,
    input: import("@loopmarshal/protocol").CreateProxyMemberInput,
  ) {
    const response = await this.request<{
      member: import("@loopmarshal/protocol").SessionMemberRouteView;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/proxy-members`, {
      method: "POST",
      body: input,
    });
    return response.member;
  }

  public async updateMemberRoute(
    sessionId: string,
    agentId: string,
    input: import("@loopmarshal/protocol").UpdateMemberRouteInput,
  ) {
    const response = await this.request<{
      member: import("@loopmarshal/protocol").SessionMemberRouteView;
    }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/member-routes/${encodeURIComponent(agentId)}`,
      { method: "PUT", body: input },
    );
    return response.member;
  }

  private readonly baseUrl: string;
  private readonly headerProvider: () =>
    | Record<string, string>
    | Promise<Record<string, string>>;

  public constructor(options: LoopMarshalClientOptions = {}) {
    this.baseUrl =
      options.baseUrl ??
      (typeof process !== "undefined"
        ? process.env.LOOPMARSHAL_BASE_URL
        : undefined) ??
      `http://${process.env.LOOPMARSHAL_HOST ?? "127.0.0.1"}:${process.env.LOOPMARSHAL_PORT ?? "42688"}`;
    this.headerProvider =
      typeof options.headers === "function"
        ? options.headers
        : () => ({ ...(options.headers ?? {}) });
  }

  public async getStatus(): Promise<{
    status: string;
    message: string;
  }> {
    return this.request("/api/status");
  }

  public async createSession(
    input: CreateSessionInput,
  ): Promise<SessionJoinResult> {
    return this.request("/api/sessions", {
      method: "POST",
      body: input,
    });
  }

  public async joinSession(
    sessionId: string,
    input: Omit<JoinSessionInput, "sessionId">,
  ): Promise<SessionJoinResult> {
    return this.request(`/api/sessions/${sessionId}/join`, {
      method: "POST",
      body: {
        agentName: input.agentName,
        displayName: input.displayName,
        platform: input.platform,
        role: input.role,
        ...(input.roleDescription
          ? { roleDescription: input.roleDescription }
          : {}),
        capabilities: input.capabilities,
        connectionMode: input.connectionMode,
      },
    });
  }

  public async listSessions(): Promise<SessionSummary[]> {
    const response = await this.request<{ sessions: SessionSummary[] }>(
      "/api/sessions",
    );
    return response.sessions;
  }

  public async listMemberHeartbeats(
    sessionId: string,
  ): Promise<AgentHeartbeat[]> {
    const response = await this.request<{ heartbeats: AgentHeartbeat[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/heartbeats`,
    );
    return response.heartbeats;
  }

  public async getSession(sessionId: string): Promise<Session> {
    return this.request(`/api/sessions/${sessionId}`);
  }

  public async getSessionConsole(sessionId: string): Promise<SessionConsole> {
    const response = await this.request<{ console: SessionConsole }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/console`,
    );
    return response.console;
  }

  public async getSessionByName(sessionName: string): Promise<Session> {
    return this.request(
      `/api/sessions/by-name/${encodeURIComponent(sessionName)}`,
    );
  }

  public async deleteSession(
    sessionId: string,
    options: {
      requesterAgentId?: string;
    } = {},
  ): Promise<{ sessionId: string; sessionName: string; deleted: true }> {
    return this.request(`/api/sessions/${sessionId}`, {
      method: "DELETE",
      ...(options.requesterAgentId
        ? {
            body: {
              requesterAgentId: options.requesterAgentId,
            },
          }
        : {}),
    });
  }

  public async deleteSessionByName(
    sessionName: string,
    options: {
      requesterAgentId?: string;
    } = {},
  ): Promise<{ sessionId: string; sessionName: string; deleted: true }> {
    return this.request(
      `/api/sessions/by-name/${encodeURIComponent(sessionName)}`,
      {
        method: "DELETE",
        ...(options.requesterAgentId
          ? {
              body: {
                requesterAgentId: options.requesterAgentId,
              },
            }
          : {}),
      },
    );
  }

  public async joinSessionByName(
    input: JoinSessionByNameInput,
  ): Promise<SessionJoinResult> {
    return this.request("/api/sessions/join-by-name", {
      method: "POST",
      body: input,
    });
  }

  public async attachSession(
    input: AttachSessionInput,
  ): Promise<AttachSessionResult> {
    return this.request("/api/sessions/attach", {
      method: "POST",
      body: input,
    });
  }

  public async getMembers(sessionId: string): Promise<Agent[]> {
    const response = await this.request<{ members: Agent[] }>(
      `/api/sessions/${sessionId}/members`,
    );
    return response.members;
  }

  public async listHeartbeats(
    sessionId: string,
  ): Promise<import("@loopmarshal/protocol").AgentHeartbeat[]> {
    const response = await this.request<{
      heartbeats: import("@loopmarshal/protocol").AgentHeartbeat[];
    }>(`/api/sessions/${sessionId}/heartbeats`);
    return response.heartbeats;
  }

  public async getSessionQueueStats(
    sessionId: string,
  ): Promise<AgentQueueStats[]> {
    const response = await this.request<{ agents: AgentQueueStats[] }>(
      `/api/sessions/${sessionId}/queue-stats`,
    );
    return response.agents;
  }

  public async getSessionInsight(sessionId: string): Promise<SessionInsight> {
    const response = await this.request<{ insight: SessionInsight }>(
      `/api/sessions/${sessionId}/insight`,
    );
    return response.insight;
  }

  public async updateSessionInsight(
    input: UpdateSessionInsightInput,
  ): Promise<SessionInsight> {
    const response = await this.request<{ insight: SessionInsight }>(
      `/api/sessions/${input.sessionId}/insight`,
      {
        method: "PUT",
        body: input,
      },
    );
    return response.insight;
  }

  public async heartbeat(
    agentId: string,
  ): Promise<{ agentId: string; heartbeatAt: string }> {
    return this.request(`/api/agents/${agentId}/heartbeat`, {
      method: "POST",
      body: {},
    });
  }

  public async leaveAgent(agentId: string): Promise<LeaveAgentResult> {
    return this.request(`/api/agents/${agentId}/leave`, {
      method: "POST",
      body: {},
    });
  }

  public async removeSessionMember(
    input: RemoveSessionMemberInput,
  ): Promise<LeaveAgentResult> {
    return this.request(
      `/api/sessions/${input.sessionId}/members/${input.targetAgentId}/remove`,
      {
        method: "POST",
        body: {
          requesterAgentId: input.requesterAgentId,
        },
      },
    );
  }

  public async sendMessage(input: SendMessageInput): Promise<MessageRecord> {
    return this.request("/api/messages/send", {
      method: "POST",
      body: input,
    });
  }

  public async acquireIdentityLease(
    input: AcquireIdentityLeaseInput,
  ): Promise<IdentityLease> {
    const response = await this.request<{ lease: IdentityLease }>(
      "/api/identity-leases/acquire",
      {
        method: "POST",
        body: input,
      },
    );
    return response.lease;
  }

  public async releaseIdentityLease(
    input: ReleaseIdentityLeaseInput,
  ): Promise<{ released: boolean; identityKey: string }> {
    return this.request("/api/identity-leases/release", {
      method: "POST",
      body: input,
    });
  }

  public async listWindowBindings(
    sessionName?: string,
  ): Promise<WindowBinding[]> {
    const search = new URLSearchParams();
    if (sessionName) {
      search.set("sessionName", sessionName);
    }
    const response = await this.request<{ bindings: WindowBinding[] }>(
      `/api/window-bindings${search.size > 0 ? `?${search.toString()}` : ""}`,
    );
    return response.bindings;
  }

  public async getWindowBinding(
    sessionName: string,
    windowName: string,
  ): Promise<WindowBinding> {
    const response = await this.request<{ binding: WindowBinding }>(
      `/api/window-bindings/${encodeURIComponent(sessionName)}/${encodeURIComponent(
        windowName,
      )}`,
    );
    return response.binding;
  }

  public async updateWindowBindingDefaults(
    sessionName: string,
    windowName: string,
    input: UpdateWindowBindingDefaultsInput,
  ): Promise<WindowBinding> {
    const response = await this.request<{ binding: WindowBinding }>(
      `/api/window-bindings/${encodeURIComponent(sessionName)}/${encodeURIComponent(
        windowName,
      )}/defaults`,
      {
        method: "PUT",
        body: input,
      },
    );
    return response.binding;
  }

  public async updateWindowRuntimeState(
    sessionName: string,
    windowName: string,
    input: UpdateWindowRuntimeStateInput,
  ): Promise<WindowBinding> {
    const response = await this.request<{ binding: WindowBinding }>(
      `/api/window-bindings/${encodeURIComponent(sessionName)}/${encodeURIComponent(
        windowName,
      )}/runtime`,
      {
        method: "PUT",
        body: input,
      },
    );
    return response.binding;
  }

  public async clearWindowRuntimeState(
    sessionName: string,
    windowName: string,
  ): Promise<WindowBinding> {
    const response = await this.request<{ binding: WindowBinding }>(
      `/api/window-bindings/${encodeURIComponent(sessionName)}/${encodeURIComponent(
        windowName,
      )}/runtime`,
      {
        method: "DELETE",
      },
    );
    return response.binding;
  }

  public async getMessageById(messageId: string): Promise<MessageRecord> {
    const response = await this.request<{ message: MessageRecord }>(
      `/api/messages/${messageId}`,
    );
    return response.message;
  }

  public async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const response = await this.request<{ messages: MessageRecord[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    );
    return response.messages;
  }

  public async getInbox(agentId: string): Promise<MessageRecord[]> {
    return this.getInboxWithOptions(agentId);
  }

  public async getInboxWithOptions(
    agentId: string,
    options: {
      pendingOnly?: boolean;
      claimedOnly?: boolean;
    } = {},
  ): Promise<MessageRecord[]> {
    const search = new URLSearchParams();
    if (options.pendingOnly) {
      search.set("pendingOnly", "true");
    }
    if (options.claimedOnly) {
      search.set("claimedOnly", "true");
    }

    const response = await this.request<{ messages: MessageRecord[] }>(
      `/api/agents/${agentId}/inbox${
        search.size > 0 ? `?${search.toString()}` : ""
      }`,
    );
    return response.messages;
  }

  public async claimNext(
    agentId: string,
    options: {
      types?: MessageRecord["type"][];
      fromAgentId?: string;
      correlationId?: string;
      identity?: string;
      flow?: "host" | "worker";
      ownerToken?: string;
    } = {},
  ): Promise<MessageRecord | null> {
    const response = await this.request<{ message: MessageRecord | null }>(
      "/api/messages/claim-next",
      {
        method: "POST",
        body: {
          agentId,
          ...(options.types ? { types: options.types } : {}),
          ...(options.fromAgentId ? { fromAgentId: options.fromAgentId } : {}),
          ...(options.correlationId
            ? { correlationId: options.correlationId }
            : {}),
          ...(options.identity ? { identity: options.identity } : {}),
          ...(options.flow ? { flow: options.flow } : {}),
          ...(options.ownerToken ? { ownerToken: options.ownerToken } : {}),
        },
      },
    );
    return response.message;
  }

  public async completeMessage(
    messageId: string,
    input: MessageProcessCompleteInput,
  ): Promise<MessageRecord> {
    const response = await this.request<{ message: MessageRecord }>(
      `/api/messages/${messageId}/process-complete`,
      {
        method: "POST",
        body: input,
      },
    );
    return response.message;
  }

  public async failMessage(
    messageId: string,
    input: MessageProcessFailInput,
  ): Promise<MessageRecord> {
    const response = await this.request<{ message: MessageRecord }>(
      `/api/messages/${messageId}/process-fail`,
      {
        method: "POST",
        body: input,
      },
    );
    return response.message;
  }

  public async acknowledgeMessage(
    messageId: string,
    processed = false,
  ): Promise<AckPayload> {
    return this.request(`/api/messages/${messageId}/ack`, {
      method: "POST",
      body: {
        processed,
      },
    });
  }

  public async createTask(input: CreateTaskInput): Promise<Task> {
    return this.request("/api/tasks", {
      method: "POST",
      body: input,
    });
  }

  public async listTasks(sessionId: string): Promise<Task[]> {
    const response = await this.request<{ tasks: Task[] }>(
      `/api/sessions/${sessionId}/tasks`,
    );
    return response.tasks;
  }

  public async upsertProgress(
    input: import("@loopmarshal/protocol").UpsertProgressInput,
  ): Promise<import("@loopmarshal/protocol").Progress> {
    const response = await this.request<{
      progress: import("@loopmarshal/protocol").Progress;
    }>("/api/progress", {
      method: "PUT",
      body: input,
    });
    return response.progress;
  }

  public async getProgress(
    sessionId: string,
    agentId: string,
  ): Promise<import("@loopmarshal/protocol").Progress | undefined> {
    const response = await this.request<{
      progress: import("@loopmarshal/protocol").Progress | undefined;
    }>(
      `/api/progress/${encodeURIComponent(sessionId)}/${encodeURIComponent(agentId)}`,
    );
    return response.progress;
  }

  public async listProgress(
    filter: import("@loopmarshal/protocol").ListProgressFilter = {},
  ): Promise<import("@loopmarshal/protocol").Progress[]> {
    const searchParams = new URLSearchParams();
    if (filter.sessionId) searchParams.set("sessionId", filter.sessionId);
    if (filter.agentId) searchParams.set("agentId", filter.agentId);
    if (filter.status) searchParams.set("status", filter.status);

    const response = await this.request<{
      progressList: import("@loopmarshal/protocol").Progress[];
    }>(
      `/api/progress${searchParams.size > 0 ? `?${searchParams.toString()}` : ""}`,
    );
    return response.progressList;
  }

  public async clearProgress(sessionId: string): Promise<{ cleared: number }> {
    return this.request(`/api/progress/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  public async getKnowledgeManifest(
    sessionId?: string,
  ): Promise<import("@loopmarshal/protocol").KnowledgeManifest> {
    const response = await this.request<{
      manifest: import("@loopmarshal/protocol").KnowledgeManifest;
      items: import("@loopmarshal/protocol").KnowledgeListItem[];
    }>(
      `/api/knowledge${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    );
    return response.manifest;
  }

  public async listKnowledge(
    input: import("@loopmarshal/protocol").ListKnowledgeInput = {},
  ): Promise<import("@loopmarshal/protocol").KnowledgeListItem[]> {
    const searchParams = new URLSearchParams();
    if (input.sessionId) searchParams.set("sessionId", input.sessionId);
    if (input.level) searchParams.set("level", input.level);
    if (input.tag) searchParams.set("tag", input.tag);
    if (input.query) searchParams.set("query", input.query);

    const response = await this.request<{
      manifest: import("@loopmarshal/protocol").KnowledgeManifest;
      items: import("@loopmarshal/protocol").KnowledgeListItem[];
    }>(
      `/api/knowledge${searchParams.size > 0 ? `?${searchParams.toString()}` : ""}`,
    );
    return response.items;
  }

  public async getKnowledge(
    level: import("@loopmarshal/protocol").KnowledgeLevel,
    slug: string,
    sessionId?: string,
  ): Promise<import("@loopmarshal/protocol").KnowledgeDocument | undefined> {
    const response = await this.request<{
      document: import("@loopmarshal/protocol").KnowledgeDocument | undefined;
    }>(
      `/api/knowledge/${level}/${encodeURIComponent(slug)}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    );
    return response.document;
  }

  public async getKnowledgeByRef(
    ref: string,
    sessionId?: string,
  ): Promise<import("@loopmarshal/protocol").KnowledgeDocument | undefined> {
    const parsed = this.parseKnowledgeRef(ref);
    return this.getKnowledge(parsed.level, parsed.slug, sessionId);
  }

  public async upsertKnowledge(
    input: import("@loopmarshal/protocol").UpsertKnowledgeInput,
  ): Promise<import("@loopmarshal/protocol").KnowledgeDocument> {
    const response = await this.request<{
      document: import("@loopmarshal/protocol").KnowledgeDocument;
    }>(`/api/knowledge/${input.level}/${encodeURIComponent(input.slug)}`, {
      method: "PUT",
      body: {
        title: input.title,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        content: input.content,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.ownerAgentId !== undefined
          ? { ownerAgentId: input.ownerAgentId }
          : {}),
        ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
        ...(input.sourceAgentId !== undefined
          ? { sourceAgentId: input.sourceAgentId }
          : {}),
        ...(input.changeSummary !== undefined
          ? { changeSummary: input.changeSummary }
          : {}),
      },
    });
    return response.document;
  }

  public async deleteKnowledge(
    input: import("@loopmarshal/protocol").DeleteKnowledgeInput,
  ): Promise<{ deleted: boolean }> {
    return this.request(
      `/api/knowledge/${input.level}/${encodeURIComponent(input.slug)}`,
      {
        method: "DELETE",
        body: {
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}),
          ...(input.sourceAgentId !== undefined
            ? { sourceAgentId: input.sourceAgentId }
            : {}),
          ...(input.changeSummary !== undefined
            ? { changeSummary: input.changeSummary }
            : {}),
        },
      },
    );
  }

  public async listKnowledgeChanges(
    input: import("@loopmarshal/protocol").ListKnowledgeChangesInput = {},
  ): Promise<import("@loopmarshal/protocol").KnowledgeChangeRecord[]> {
    const searchParams = new URLSearchParams();
    if (input.sessionId) searchParams.set("sessionId", input.sessionId);
    if (input.level) searchParams.set("level", input.level);
    if (input.slug) searchParams.set("slug", input.slug);
    if (input.limit !== undefined)
      searchParams.set("limit", String(input.limit));

    const response = await this.request<{
      changes: import("@loopmarshal/protocol").KnowledgeChangeRecord[];
    }>(
      `/api/knowledge/changes${
        searchParams.size > 0 ? `?${searchParams.toString()}` : ""
      }`,
    );
    return response.changes;
  }

  public async listPendingKnowledgePatches(
    sessionId?: string,
  ): Promise<import("@loopmarshal/protocol").KnowledgePatchRecord[]> {
    const response = await this.request<{
      patches: import("@loopmarshal/protocol").KnowledgePatchRecord[];
    }>(
      `/api/knowledge/patches/pending${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    );
    return response.patches;
  }

  public async listKnowledgePatches(
    input: import("@loopmarshal/protocol").ListKnowledgePatchRecordsInput = {},
  ): Promise<import("@loopmarshal/protocol").KnowledgePatchRecord[]> {
    const searchParams = new URLSearchParams();
    if (input.status) searchParams.set("status", input.status);
    if (input.sessionId) searchParams.set("sessionId", input.sessionId);

    const response = await this.request<{
      patches: import("@loopmarshal/protocol").KnowledgePatchRecord[];
    }>(
      `/api/knowledge/patches${
        searchParams.size > 0 ? `?${searchParams.toString()}` : ""
      }`,
    );
    return response.patches;
  }

  public async getKnowledgePatch(
    patchId: string,
    sessionId?: string,
  ): Promise<{
    patch: import("@loopmarshal/protocol").KnowledgePatchRecord;
    review: import("@loopmarshal/protocol").KnowledgePatchReviewRecord | null;
    persistence:
      | import("@loopmarshal/protocol").KnowledgePersistenceRecord
      | null;
  }> {
    const response = await this.request<{
      patch: import("@loopmarshal/protocol").KnowledgePatchRecord;
      review: import("@loopmarshal/protocol").KnowledgePatchReviewRecord | null;
      persistence:
        | import("@loopmarshal/protocol").KnowledgePersistenceRecord
        | null;
    }>(
      `/api/knowledge/patches/${encodeURIComponent(patchId)}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    );
    return response;
  }

  public async adjudicateKnowledgePatch(
    patchId: string,
    input: Omit<
      import("@loopmarshal/protocol").AdjudicateKnowledgePatchInput,
      "patchId"
    >,
  ): Promise<{
    patchRecord: import("@loopmarshal/protocol").KnowledgePatchRecord | null;
    reviewRecord: import("@loopmarshal/protocol").KnowledgePatchReviewRecord;
    persistenceRecord: import("@loopmarshal/protocol").KnowledgePersistenceRecord;
  }> {
    const response = await this.request<{
      patchRecord: import("@loopmarshal/protocol").KnowledgePatchRecord | null;
      reviewRecord: import("@loopmarshal/protocol").KnowledgePatchReviewRecord;
      persistenceRecord: import("@loopmarshal/protocol").KnowledgePersistenceRecord;
    }>(`/api/knowledge/patches/${encodeURIComponent(patchId)}/adjudicate`, {
      method: "POST",
      body: input,
    });
    return response;
  }

  public async executeKnowledgePatchPersistence(
    patchId: string,
    sessionId?: string,
  ): Promise<
    import("@loopmarshal/protocol").ExecuteKnowledgePatchPersistenceResult
  > {
    const response = await this.request<
      import("@loopmarshal/protocol").ExecuteKnowledgePatchPersistenceResult
    >(`/api/knowledge/patches/${encodeURIComponent(patchId)}/execute`, {
      method: "POST",
      body: { ...(sessionId ? { sessionId } : {}) },
    });
    return response;
  }

  public async completeTask(
    taskId: string,
    input: CompleteTaskInput,
  ): Promise<Task> {
    return this.request(`/api/tasks/${taskId}/complete`, {
      method: "POST",
      body: input,
    });
  }

  private parseKnowledgeRef(ref: string): {
    level: import("@loopmarshal/protocol").KnowledgeLevel;
    slug: string;
  } {
    const withoutHash = ref.split("#", 1)[0] ?? "";
    const normalized = withoutHash
      .replace(/^knowledge:/i, "")
      .replace(/^\/+/, "");
    const [level, ...slugParts] = normalized.split("/");
    if (
      (level !== "l1" && level !== "l2" && level !== "l3") ||
      slugParts.length === 0
    ) {
      throw new LoopMarshalSdkError(`Invalid knowledge ref "${ref}".`, {
        statusCode: 400,
        code: errorCodes.invalidInput,
      });
    }
    return {
      level,
      slug: slugParts.join("/"),
    };
  }

  public async hostSessionByName(
    sessionName: string,
    options: Omit<CreateSessionInput, "sessionName">,
  ): Promise<SessionJoinResult> {
    return this.createSession({
      sessionName,
      ...options,
    });
  }

  public async joinNamedSession(
    sessionName: string,
    options: Omit<JoinSessionByNameInput, "sessionName">,
  ): Promise<SessionJoinResult> {
    return this.joinSessionByName({
      sessionName,
      ...options,
    });
  }

  public async ensureHostedSessionByName(
    sessionName: string,
    options: Omit<CreateSessionInput, "sessionName">,
  ): Promise<EnsureHostedSessionResult> {
    try {
      const created = await this.hostSessionByName(sessionName, options);
      return {
        ...created,
        reusedExistingSession: false,
      };
    } catch (error: unknown) {
      if (
        !(error instanceof LoopMarshalSdkError) ||
        error.code !== errorCodes.duplicateSessionName
      ) {
        throw error;
      }

      const session = await this.getSessionByName(sessionName);
      const members = await this.getMembers(session.id);
      const hostAgent = members.find(
        (member) => member.id === session.hostAgentId,
      );

      if (!hostAgent || hostAgent.agentName !== options.agentName) {
        throw error;
      }

      return {
        session,
        agent: hostAgent,
        reusedExistingSession: true,
      };
    }
  }

  public async attachNamedSession(
    sessionName: string,
    options: Omit<AttachSessionInput, "sessionName">,
  ): Promise<AttachSessionResult> {
    return this.attachSession({
      sessionName,
      ...options,
    });
  }

  // Workflow Management
  public async listWorkflows(): Promise<
    import("@loopmarshal/protocol").WorkflowDefinitionRecord[]
  > {
    return this.request("/api/workflows");
  }

  public async getWorkflow(
    workflowId: string,
  ): Promise<import("@loopmarshal/protocol").WorkflowDefinitionRecord> {
    return this.request(`/api/workflows/${encodeURIComponent(workflowId)}`);
  }

  public async createWorkflow(input: {
    id?: string;
    name: string;
    description?: string | null;
    role: import("@loopmarshal/protocol").AgentRole;
    nodes: import("@loopmarshal/protocol").WorkflowNodeDefinition[];
    edges: import("@loopmarshal/protocol").WorkflowEdgeDefinition[];
    enabled?: boolean;
  }): Promise<import("@loopmarshal/protocol").WorkflowDefinitionRecord> {
    return this.request("/api/workflows", {
      method: "POST",
      body: input,
    });
  }

  public async updateWorkflow(
    workflowId: string,
    input: {
      name?: string;
      description?: string | null;
      role?: import("@loopmarshal/protocol").AgentRole;
      nodes?: import("@loopmarshal/protocol").WorkflowNodeDefinition[];
      edges?: import("@loopmarshal/protocol").WorkflowEdgeDefinition[];
      enabled?: boolean;
    },
  ): Promise<import("@loopmarshal/protocol").WorkflowDefinitionRecord> {
    return this.request(`/api/workflows/${encodeURIComponent(workflowId)}`, {
      method: "PUT",
      body: input,
    });
  }

  public async deleteWorkflow(workflowId: string): Promise<void> {
    await this.request(`/api/workflows/${encodeURIComponent(workflowId)}`, {
      method: "DELETE",
    });
  }

  // Web Agent Runtime Management
  public async listWebAgentRuntimes(
    sessionId?: string,
  ): Promise<import("@loopmarshal/protocol").WebAgentRuntime[]> {
    const query = sessionId
      ? `?sessionId=${encodeURIComponent(sessionId)}`
      : "";
    return this.request(`/api/web-agent-runtimes${query}`);
  }

  public async createWebAgentRuntime(input: {
    sessionId: string;
    agentId: string;
    role: string;
    modelConfigId?: string;
    agentProfileId?: string | null;
    toolsetId?: string | null;
  }): Promise<import("@loopmarshal/protocol").WebAgentRuntime> {
    return this.request("/api/web-agent-runtimes", {
      method: "POST",
      body: input,
    });
  }

  public async getWebAgentRuntime(
    runtimeId: string,
  ): Promise<import("@loopmarshal/protocol").WebAgentRuntime> {
    return this.request(
      `/api/web-agent-runtimes/${encodeURIComponent(runtimeId)}`,
    );
  }

  public async updateWebAgentRuntime(
    runtimeId: string,
    input: {
      toolsetId?: string | null;
      modelConfigId?: string | undefined;
      status?: string;
      currentStep?: string | null;
      lastError?: string | null;
      lastTickAt?: string | null;
      lastSelfMaintenanceAt?: string | null;
      customDuty?: string | null | undefined;
      customSkillIds?: string[] | undefined;
      externalMcpServerIds?: string[] | undefined;
    },
  ): Promise<import("@loopmarshal/protocol").WebAgentRuntime> {
    return this.request(
      `/api/web-agent-runtimes/${encodeURIComponent(runtimeId)}`,
      {
        method: "PATCH",
        body: input,
      },
    );
  }

  public async deleteWebAgentRuntime(runtimeId: string): Promise<void> {
    await this.request(
      `/api/web-agent-runtimes/${encodeURIComponent(runtimeId)}`,
      {
        method: "DELETE",
      },
    );
  }

  public async startWebAgentRuntime(
    runtimeId: string,
  ): Promise<import("@loopmarshal/protocol").WebAgentRuntime> {
    return this.request(
      `/api/web-agent-runtimes/${encodeURIComponent(runtimeId)}/start`,
      {
        method: "POST",
      },
    );
  }

  public async pauseWebAgentRuntime(
    runtimeId: string,
  ): Promise<import("@loopmarshal/protocol").WebAgentRuntime> {
    return this.request(
      `/api/web-agent-runtimes/${encodeURIComponent(runtimeId)}/pause`,
      {
        method: "POST",
      },
    );
  }

  public async stopWebAgentRuntime(
    runtimeId: string,
  ): Promise<import("@loopmarshal/protocol").WebAgentRuntime> {
    return this.request(
      `/api/web-agent-runtimes/${encodeURIComponent(runtimeId)}/stop`,
      {
        method: "POST",
      },
    );
  }

  // User Profile
  public async getUserProfile(
    agentId: string,
  ): Promise<Array<{ key: string; value: string; updatedAt: string }>> {
    return this.request(`/api/agents/${encodeURIComponent(agentId)}/profile`);
  }

  public async setUserProfileEntry(
    agentId: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.request(`/api/agents/${encodeURIComponent(agentId)}/profile`, {
      method: "PUT",
      body: { key, value },
    });
  }

  public async deleteUserProfileEntry(
    agentId: string,
    key: string,
  ): Promise<void> {
    await this.request(
      `/api/agents/${encodeURIComponent(agentId)}/profile/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
      },
    );
  }

  // Global User Preferences
  public async listUserPreferences(
    input: import("@loopmarshal/protocol").ListUserPreferencesInput = {},
  ): Promise<{
    manifest: import("@loopmarshal/protocol").UserPreferencesManifest;
    preferences: import("@loopmarshal/protocol").UserPreference[];
  }> {
    const searchParams = new URLSearchParams();
    if (input.category) searchParams.set("category", input.category);
    if (input.query) searchParams.set("query", input.query);
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return this.request(`/api/user-preferences${query}`);
  }

  public async upsertUserPreference(
    key: string,
    input: Omit<
      import("@loopmarshal/protocol").UpsertUserPreferenceInput,
      "key"
    >,
  ): Promise<import("@loopmarshal/protocol").UserPreference> {
    const response = await this.request<{
      preference: import("@loopmarshal/protocol").UserPreference;
    }>(`/api/user-preferences/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: input,
    });
    return response.preference;
  }

  public async deleteUserPreference(
    key: string,
  ): Promise<{ deleted: boolean }> {
    return this.request(`/api/user-preferences/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
  }

  // Models
  public async listModels(): Promise<
    import("@loopmarshal/protocol").ModelConfigSummary[]
  > {
    return this.request("/api/models");
  }

  public async createModel(
    input: import("@loopmarshal/protocol").SaveModelConfigInput,
  ): Promise<import("@loopmarshal/protocol").ModelConfigSummary> {
    return this.request("/api/models", {
      method: "POST",
      body: input,
    });
  }

  public async deleteModel(modelId: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/models/${encodeURIComponent(modelId)}`, {
      method: "DELETE",
    });
  }

  // MCP Servers
  public async listMcpServers(): Promise<
    Array<{
      id: string;
      name: string;
      url: string;
      description: string | null;
      transport: "stdio" | "sse";
      enabled: boolean;
      toolCount: number;
      createdAt: string;
      updatedAt: string;
    }>
  > {
    return this.request("/api/mcp-servers");
  }

  public async createMcpServer(input: {
    name: string;
    url: string;
    description?: string | null;
    transport?: "stdio" | "sse";
    headers?: Record<string, string> | null;
    enabled?: boolean;
  }): Promise<{ id: string; name: string; url: string; enabled: boolean }> {
    return this.request("/api/mcp-servers", { method: "POST", body: input });
  }

  public async updateMcpServer(
    serverId: string,
    input: {
      name?: string;
      url?: string;
      description?: string | null;
      transport?: "stdio" | "sse";
      headers?: Record<string, string> | null;
      enabled?: boolean;
    },
  ): Promise<{ id: string; name: string; url: string; enabled: boolean }> {
    return this.request(`/api/mcp-servers/${encodeURIComponent(serverId)}`, {
      method: "PUT",
      body: input,
    });
  }

  public async deleteMcpServer(serverId: string): Promise<void> {
    await this.request(`/api/mcp-servers/${encodeURIComponent(serverId)}`, {
      method: "DELETE",
    });
  }

  public async listMcpServerTools(serverId: string): Promise<
    Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>
  > {
    return this.request(
      `/api/mcp-servers/${encodeURIComponent(serverId)}/tools`,
    );
  }

  // Agent Profiles
  public async getAgentProfile(profileId: string): Promise<{
    id: string;
    name: string;
    systemPrompt: string | null;
    skillIds: string[];
    toolsetId: string | null;
    externalToolNames: string[];
    permissionPolicy: Record<string, unknown> | null;
    runtimePolicy: Record<string, unknown> | null;
  }> {
    return this.request(`/api/agent-profiles/${encodeURIComponent(profileId)}`);
  }

  public async listAgentProfiles(): Promise<
    Array<{
      id: string;
      name: string;
      systemPrompt: string | null;
      skillIds: string[];
      toolsetId: string | null;
      externalToolNames: string[];
      permissionPolicy: Record<string, unknown> | null;
      runtimePolicy: Record<string, unknown> | null;
    }>
  > {
    return this.request("/api/agent-profiles");
  }

  // MCP Tool Calls
  public async callMcpTool(
    input: import("@loopmarshal/protocol").McpCallRequest,
  ): Promise<import("@loopmarshal/protocol").McpCallResponse> {
    return this.request("/api/mcp/call", { method: "POST", body: input });
  }

  public async getMcpTools(options?: {
    toolsetId?: string;
    extraToolNames?: string[];
  }): Promise<{ tools: import("@loopmarshal/protocol").McpToolDefinition[] }> {
    const params = new URLSearchParams();
    if (options?.toolsetId) params.set("toolsetId", options.toolsetId);
    if (options?.extraToolNames?.length)
      params.set("extraToolNames", options.extraToolNames.join(","));
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/api/mcp/tools${query}`);
  }

  // LLM
  public async llmChat(input: {
    modelConfigId?: string;
    messages: Array<{ role: string; content: string }>;
    stream?: boolean;
    tools?: import("@loopmarshal/protocol").McpToolDefinition[];
    tool_choice?: unknown;
    temperature?: number;
  }): Promise<{
    content: string | null;
    role: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | null;
    tool_calls: import("@loopmarshal/protocol").McpToolCall[] | null;
  }> {
    return this.request("/api/llm/chat", { method: "POST", body: input });
  }

  // Skills
  public async getSkill(
    skillId: string,
  ): Promise<import("@loopmarshal/protocol").SkillDefinition> {
    return this.request(`/api/skills/${encodeURIComponent(skillId)}`);
  }

  public async listSkills(): Promise<
    import("@loopmarshal/protocol").SkillDefinition[]
  > {
    return this.request("/api/skills");
  }

  // Session with Agent (join/create)
  public async joinSessionWithAgent(input: {
    sessionId: string;
    role: string;
    agentName: string;
    displayName: string;
    modelConfigId?: string;
    agentProfileId?: string | null;
    roleDescription?: string | null;
  }): Promise<{ agent: import("@loopmarshal/protocol").Agent }> {
    return this.request("/api/sessions/join-with-agent", {
      method: "POST",
      body: input,
    });
  }

  public async createSessionWithAgent(input: {
    sessionName: string;
    agentName: string;
    displayName: string;
    modelConfigId?: string;
    agentProfileId?: string | null;
    roleDescription?: string | null;
  }): Promise<{
    agent: import("@loopmarshal/protocol").Agent;
    session: import("@loopmarshal/protocol").SessionSummary;
  }> {
    return this.request("/api/sessions/create-with-agent", {
      method: "POST",
      body: input,
    });
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
    } = {},
  ): Promise<T> {
    const resolvedHeaders = await this.headerProvider();
    const hasBody = options.body !== undefined;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...resolvedHeaders,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LoopMarshalSdkError(
        "后台返回了无效响应，请检查服务地址和运行状态。",
        {
          statusCode: response.status,
          code: "INVALID_RESPONSE",
        },
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new LoopMarshalSdkError("后台响应格式不正确。", {
        statusCode: response.status,
        code: "INVALID_RESPONSE",
      });
    const result = payload as {
      success: boolean;
      data: T;
      error?: {
        code?: string;
        message?: string;
        details?: unknown;
      };
      timestamp: string;
    };

    if (!response.ok || result.success !== true) {
      throw new LoopMarshalSdkError(
        result.error?.message ?? `Request failed for ${path}.`,
        {
          statusCode: response.status,
          ...(result.error?.code ? { code: result.error.code } : {}),
        },
      );
    }
    if (!("data" in result))
      throw new LoopMarshalSdkError("后台响应缺少操作结果。", {
        statusCode: response.status,
        code: "INVALID_RESPONSE",
      });
    return result.data;
  }
}

export const createLoopMarshalClient = (
  options?: LoopMarshalClientOptions,
): LoopMarshalClient => {
  return new LoopMarshalClient(options);
};

export {
  LoopMarshalWebSocketClient,
  type LoopMarshalWebSocketClientOptions,
} from "./websocket-client.js";
