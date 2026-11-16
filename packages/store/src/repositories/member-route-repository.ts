import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  MemberRouteEvent,
  SessionMemberRoute,
  ToolInstallation,
} from "@loopmarshal/protocol";
import { inStoreTransaction } from "../transaction.js";

type RouteRow = Omit<SessionMemberRoute, "binding"> & {
  bindingJson: string | null;
};
const routeColumns = `session_id AS sessionId, agent_id AS agentId, access_mode AS accessMode,
  binding_status AS bindingStatus, binding_version AS bindingVersion, binding_json AS bindingJson,
  native_session_key AS nativeSessionKey, verified_at AS verifiedAt, verified_tool_version AS verifiedToolVersion, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt`;
type InstallationRow = Omit<
  ToolInstallation,
  "executableArgs" | "environmentKeys" | "compatibility" | "managedPaths"
> & {
  executableArgsJson: string;
  environmentKeysJson: string;
  managedPathsJson: string | null;
};
const installationColumns = `id, tool_id AS toolId, display_name AS displayName,
  executable_path AS executablePath, executable_args_json AS executableArgsJson, environment_keys_json AS environmentKeysJson, version,
  created_at AS createdAt, updated_at AS updatedAt, managed_paths_json AS managedPathsJson`;

export class MemberRouteRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public listInstallations(): ToolInstallation[] {
    return (
      this.database
        .prepare(
          `SELECT ${installationColumns} FROM tool_installations ORDER BY created_at, id`,
        )
        .all() as InstallationRow[]
    ).map(
      ({
        executableArgsJson,
        environmentKeysJson,
        managedPathsJson,
        ...row
      }) => ({
        ...row,
        ...(managedPathsJson
          ? { managedPaths: JSON.parse(managedPathsJson) }
          : {}),
        executableArgs: JSON.parse(executableArgsJson) as string[],
        environmentKeys: JSON.parse(environmentKeysJson) as string[],
      }),
    );
  }

  public getInstallation(id: string): ToolInstallation | null {
    const row = this.database
      .prepare(
        `SELECT ${installationColumns} FROM tool_installations WHERE id = ?`,
      )
      .get(id) as InstallationRow | undefined;
    if (!row) return null;
    const {
      executableArgsJson,
      environmentKeysJson,
      managedPathsJson,
      ...rest
    } = row;
    return {
      ...rest,
      ...(managedPathsJson
        ? { managedPaths: JSON.parse(managedPathsJson) }
        : {}),
      executableArgs: JSON.parse(executableArgsJson) as string[],
      environmentKeys: JSON.parse(environmentKeysJson) as string[],
    };
  }

  public insertInstallation(installation: ToolInstallation): void {
    this.database
      .prepare(
        `INSERT INTO tool_installations
      (id, tool_id, display_name, executable_path, executable_args_json, environment_keys_json, version, created_at, updated_at)
      VALUES (@id, @toolId, @displayName, @executablePath, @executableArgsJson, @environmentKeysJson, @version, @createdAt, @updatedAt)`,
      )
      .run({
        id: installation.id,
        toolId: installation.toolId,
        displayName: installation.displayName,
        executablePath: installation.executablePath,
        executableArgsJson: JSON.stringify(installation.executableArgs),
        environmentKeysJson: JSON.stringify(installation.environmentKeys),
        version: installation.version,
        createdAt: installation.createdAt,
        updatedAt: installation.updatedAt,
      });
  }

  public updateInstallation(installation: ToolInstallation): boolean {
    const result = this.database
      .prepare(
        `UPDATE tool_installations SET
      display_name = @displayName, executable_path = @executablePath,
      executable_args_json = @executableArgsJson, environment_keys_json = @environmentKeysJson,
      version = @version, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({
        id: installation.id,
        displayName: installation.displayName,
        executablePath: installation.executablePath,
        executableArgsJson: JSON.stringify(installation.executableArgs),
        environmentKeysJson: JSON.stringify(installation.environmentKeys),
        version: installation.version,
        updatedAt: installation.updatedAt,
      });
    return Number(result.changes) === 1;
  }

  public get(agentId: string): SessionMemberRoute | null {
    const row = this.database
      .prepare(
        `SELECT ${routeColumns} FROM session_member_routes WHERE agent_id = ?`,
      )
      .get(agentId) as RouteRow | undefined;
    return row ? this.mapRoute(row) : null;
  }

  public list(sessionId: string): SessionMemberRoute[] {
    return (
      this.database
        .prepare(
          `SELECT ${routeColumns} FROM session_member_routes WHERE session_id = ? ORDER BY created_at, agent_id`,
        )
        .all(sessionId) as RouteRow[]
    ).map((row) => this.mapRoute(row));
  }

  public findByNativeSessionKey(key: string): SessionMemberRoute | null {
    const row = this.database
      .prepare(
        `SELECT ${routeColumns} FROM session_member_routes
      WHERE native_session_key = ? AND binding_status != 'disabled'`,
      )
      .get(key) as RouteRow | undefined;
    return row ? this.mapRoute(row) : null;
  }

  public update(
    route: SessionMemberRoute,
    expectedVersion: number,
    event: MemberRouteEvent,
  ): boolean {
    return inStoreTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE session_member_routes SET
        access_mode = @accessMode, binding_status = @bindingStatus, binding_version = @bindingVersion,
        binding_json = @bindingJson, native_session_key = @nativeSessionKey, verified_at = @verifiedAt, verified_tool_version = @verifiedToolVersion,
        last_error = @lastError, updated_at = @updatedAt
        WHERE agent_id = @agentId AND session_id = @sessionId AND binding_version = @expectedVersion`,
        )
        .run({
          agentId: route.agentId,
          sessionId: route.sessionId,
          accessMode: route.accessMode,
          bindingStatus: route.bindingStatus,
          bindingVersion: route.bindingVersion,
          bindingJson: route.binding ? JSON.stringify(route.binding) : null,
          nativeSessionKey: route.nativeSessionKey,
          verifiedAt: route.verifiedAt,
          verifiedToolVersion: route.verifiedToolVersion,
          lastError: route.lastError,
          updatedAt: route.updatedAt,
          expectedVersion,
        });
      if (Number(result.changes) !== 1) return false;
      this.database
        .prepare(
          `INSERT INTO member_route_events
        (id, session_id, agent_id, binding_version, reason, before_json, after_json, created_at)
        VALUES (@id, @sessionId, @agentId, @bindingVersion, @reason, @beforeJson, @afterJson, @createdAt)`,
        )
        .run({
          id: event.id,
          sessionId: event.sessionId,
          agentId: event.agentId,
          bindingVersion: event.bindingVersion,
          reason: event.reason,
          beforeJson: JSON.stringify(event.before),
          afterJson: JSON.stringify(event.after),
          createdAt: event.createdAt,
        });
      return true;
    });
  }

  public failInitialization(
    route: SessionMemberRoute,
    expectedVersion: number,
    message: string,
  ): boolean {
    const timestamp = new Date().toISOString();
    const failed: SessionMemberRoute = {
      ...route,
      bindingStatus: "blocked",
      lastError: message,
      updatedAt: timestamp,
    };
    return this.update(failed, expectedVersion, {
      id: randomUUID(),
      sessionId: route.sessionId,
      agentId: route.agentId,
      bindingVersion: expectedVersion,
      reason: `Native session creation failed: ${message}`,
      before: route,
      after: failed,
      createdAt: timestamp,
    });
  }

  public retryInitialization(
    route: SessionMemberRoute,
    expectedVersion: number,
  ): SessionMemberRoute | null {
    return inStoreTransaction(this.database, () => {
      const timestamp = new Date().toISOString();
      const updated: SessionMemberRoute = {
        ...route,
        bindingStatus: "initializing",
        bindingVersion: expectedVersion + 1,
        lastError: null,
        updatedAt: timestamp,
      };
      const changed = this.update(updated, expectedVersion, {
        id: randomUUID(),
        sessionId: route.sessionId,
        agentId: route.agentId,
        bindingVersion: updated.bindingVersion,
        reason: "Retry native session creation",
        before: route,
        after: updated,
        createdAt: timestamp,
      });
      return changed ? updated : null;
    });
  }

  public listEvents(agentId: string): MemberRouteEvent[] {
    const rows = this.database
      .prepare(
        `SELECT id, session_id AS sessionId, agent_id AS agentId,
      binding_version AS bindingVersion, reason, before_json AS beforeJson, after_json AS afterJson, created_at AS createdAt
      FROM member_route_events WHERE agent_id = ? ORDER BY binding_version`,
      )
      .all(agentId) as Array<
      Omit<MemberRouteEvent, "before" | "after"> & {
        beforeJson: string;
        afterJson: string;
      }
    >;
    return rows.map(({ beforeJson, afterJson, ...row }) => ({
      ...row,
      before: JSON.parse(beforeJson) as SessionMemberRoute,
      after: JSON.parse(afterJson) as SessionMemberRoute,
    }));
  }

  private mapRoute({ bindingJson, ...row }: RouteRow): SessionMemberRoute {
    return {
      ...row,
      binding: bindingJson
        ? (JSON.parse(bindingJson) as NonNullable<
            SessionMemberRoute["binding"]
          >)
        : null,
    };
  }
}
