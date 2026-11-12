import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProxyDelivery } from "@loopmarshal/protocol";
import type { ServerServices } from "../server/create-server.js";
import { projectContext } from "./project-context.js";
import { managedCollaborationSkill } from "./managed-collaboration-skill.js";
import { managedCommandInputSource } from "./managed-member-bridge.js";

export function prepareProxySessionContext(
  services: ServerServices,
  delivery: ProxyDelivery,
  baseUrl: string,
  databasePath: string,
) {
  const session = services.sessionService.getSession(delivery.sessionId);
  const members = services.sessionService.listMembers(session.id);
  const agent = members.find((member) => member.id === delivery.targetAgentId)!;
  const automaticSetup = services.managedAgentSetupService?.ensure(
    session.id,
    agent.id,
  );
  const knowledge = services.knowledgeService.forSession(session.id);
  const index = knowledge.list();
  const recent = index
    .slice(0, 8)
    .map((doc) => {
      const value = knowledge.get(doc.level, doc.slug);
      return `${doc.level}/${doc.slug} v${doc.version}: ${value.title}\n${value.content.slice(0, 2400)}`;
    })
    .join("\n\n");
  const issued = services.memberCredentialService!.issue(
    session.id,
    agent.id,
    `proxy-execution:${delivery.id}`,
  );
  const root = join(dirname(databasePath), "proxy-bridges");
  const bridgePath = join(root, `${delivery.id}.cjs`);
  // Credentials are written to a short-lived local file, never interpolated in prompts or event logs.
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      bridgePath,
      `const binding=${JSON.stringify({ sessionId: session.id, agentId: agent.id, baseUrl, token: issued.token })};
${managedCommandInputSource}
(async()=>{const toolName=process.argv[2];const args=await commandArguments();const r=await fetch(binding.baseUrl+'/api/mcp/call',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+binding.token},body:JSON.stringify({sessionId:binding.sessionId,agentId:binding.agentId,toolName,arguments:args})});const body=await r.json();console.log(JSON.stringify(body));if(!r.ok||body.data?.success===false)process.exitCode=1})().catch(e=>{console.error(e.message);process.exitCode=1});`,
      { mode: 0o600 },
    );
  } catch (error) {
    services.memberCredentialService!.revoke(
      session.id,
      agent.id,
      issued.credential.id,
    );
    try {
      unlinkSync(bridgePath);
    } catch {}
    throw error;
  }
  return {
    prompt: [
      `Role: ${agent.role}. Collaboration session: ${session.name} (${session.id}).`,
      managedCollaborationSkill(agent.role, "managed_proxy"),
      ...(automaticSetup
        ? [
            `# Automatically managed Skill and MCP\nSkill: ${automaticSetup.skillPath}\nMCP server: ${automaticSetup.serverName}\nRead the managed role Skill and use its scoped tools. It is configured by LoopMarshal, not by the user. All calls use this member identity automatically.\nManaged command bridge executable: ${process.execPath}\nManaged command bridge script: ${automaticSetup.bridgePath}`,
          ]
        : []),
      projectContext(session),
      `# Session members\n${members.map((member) => `${member.agentName} | ${member.role} | agentId=${member.id} | ${member.roleDescription ?? ""}`).join("\n")}`,
      `# Current session knowledge\n${index.map((doc) => `${doc.level}/${doc.slug} v${doc.version} ${doc.title}`).join("\n")}\n\n${recent}`,
      `# Live collaboration tools\nRun the following executable and script with two literal arguments: tool name and JSON arguments. Use your native command runner; adapt quoting to its shell.\nExecutable: ${process.execPath}\nScript: ${bridgePath}\nExamples of arguments: knowledge_list {} ; knowledge_read {"level":"l2","slug":"<slug returned by knowledge_list>"}.`,
      "For long or multiline arguments, write the exact JSON into a temporary UTF-8 file using your native file tool, then pass @ followed by its full path as the JSON argument. This needs only one bridge command and no shell pipeline. Alternatively, pass --stdin and supply UTF-8 JSON on standard input (a Bash quoted heredoc or PowerShell literal here-string). Preserve spaces, newlines, quotes and backslashes exactly; never replace spaces with visible symbols or rewrite commands to fit the shell. Windows cmd.exe does not treat single quotes as argument delimiters: use double quotes around the entire JSON argument and backslash-escape its inner double quotes. A JSON parsing error means quoting must be fixed; it does not mean knowledge cannot contain spaces.",
      "Knowledge is scoped to this collaboration session. Read fresh knowledge before decisions; do not rely solely on earlier conversation history.",
      agent.role === "worker"
        ? "Report proposed knowledge changes to the Host or Keeper. Do not overwrite architecture facts."
        : "Use knowledge_update {level,slug,title,content,summary} to persist verified knowledge promptly. Preserve unrelated facts. Host may assign knowledge work to the Keeper with send_message.",
      agent.role === "host"
        ? "Use dispatch_task {toAgentId,content} for workers, send_message {toAgentId,type,content} for Keeper tasks, and update_insight for session progress. Review member reports then give the user a clear response. These commands route by registered member identity."
        : "Your final response is returned to the sender automatically.",
    ].join("\n\n"),
    ...(automaticSetup ? { automaticSetup } : {}),
    cleanup: () => {
      try {
        services.memberCredentialService!.revoke(
          session.id,
          agent.id,
          issued.credential.id,
        );
      } finally {
        try {
          unlinkSync(bridgePath);
        } catch {}
      }
      /* Revoked credentials cannot be reused. */
    },
  };
}
