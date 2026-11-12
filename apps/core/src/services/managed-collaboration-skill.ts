import type { AgentRole, MemberAccessMode } from "@loopmarshal/protocol";
import { projectKnowledgePolicy } from "./project-knowledge-policy.js";

export const managedSkillVersion = 4;
export function managedCollaborationSkill(
  role: AgentRole,
  mode: MemberAccessMode,
): string {
  const roleRules =
    role === "host"
      ? "Understand the user goal and inspect the project before deciding. Maintain the session direction, assign implementation work to registered Workers with dispatch_task, delegate knowledge maintenance to the Keeper when present, review reports and verify results. Registered LoopMarshal members are not native subagents: their agentId values only work with LoopMarshal dispatch_task/send_message, never with native spawn_agent/send_input tools. Use query_messages with the exact memberName from session_context to inspect Worker/Keeper collaboration history, or correlationId to review a task thread; this read does not claim work. Client messages marked web_user_message are direct user requests: answer them in your final response, or with resolve_message(messageId, summary) when externally waiting; the summary is returned to the client. Without a Keeper, maintain verified knowledge yourself. Never treat an unverified report as accepted work."
      : role === "knowledge_keeper"
        ? "Maintain this session's project knowledge on behalf of the Host. Read current documents first, preserve unrelated facts, and write only durable, verified changes at the correct level. An explicit no-change report is valid. Rereading proves persistence, not semantic correctness or Host approval. Report evidence, refs, uncertainties and conflicts. Do not make independent architecture decisions or dispatch implementation tasks."
        : "Read the assigned task and current project knowledge, inspect and change the project as needed, verify your work, and report results, evidence, blockers and proposed knowledge changes to the Host. Do not overwrite architecture knowledge or dispatch work to other members.";
  return `---\nname: loopmarshal-${role.replaceAll("_", "-")}\ndescription: Managed collaboration rules for this LoopMarshal member.\n---\n\n# LoopMarshal managed collaboration · v${managedSkillVersion}\n\n${roleRules}\n\n${projectKnowledgePolicy}\n\nBefore work, use session_context and knowledge_list / knowledge_read to obtain the latest member identities and knowledge. Knowledge belongs to this collaboration session; earlier conversation history can be stale. Never invent a member ID, change the bound native session, expose credentials, or configure an unrelated session. The MCP connection supplies your identity automatically.\n\n${mode === "managed_proxy" ? "The Core owns task delivery and returns your final response to its sender automatically. Do not attach, claim, submit_result or enter await loops. Use the managed MCP tools; if the native tool cannot load MCP, use the provided managed command bridge with the same identity." : mode === "core_runtime" ? "The Core owns task delivery, role workflow and result submission. Use the supplied tools and return the result; do not attach or enter an external waiting loop." : "This external member is already registered. Use claim_next to receive work and the existing completion/report protocol to return results. Do not create another Host or replace the session identity."}\n`;
}

export function managedToolNames(
  role: AgentRole,
  mode: MemberAccessMode,
): string[] {
  const tools = [
    "session_context",
    "knowledge_list",
    "knowledge_read",
    "file_read",
    "file_list",
    "send_message",
  ];
  if (role === "host")
    tools.push(
      "knowledge_update",
      "dispatch_task",
      "update_insight",
      "query_messages",
    );
  if (role === "knowledge_keeper") tools.push("knowledge_update");
  if (["mcp_await", "cli_await"].includes(mode)) {
    tools.push("heartbeat", "claim_next");
    if (role === "host") tools.push("resolve_message");
    else tools.push("submit_result", "fail_task");
  }
  return tools;
}
