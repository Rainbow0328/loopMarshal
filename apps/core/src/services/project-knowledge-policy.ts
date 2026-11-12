import {
  knowledgeLevelDefinitions,
  knowledgeLevels,
} from "@loopmarshal/protocol";

export const projectKnowledgePolicy = `# Session project knowledge
${knowledgeLevels.map((level) => `${level.toUpperCase()} ${knowledgeLevelDefinitions[level].label}: ${knowledgeLevelDefinitions[level].guidance}`).join("\n")}
Store durable knowledge about the selected project, not a diary of this collaboration. Member lists, native session IDs, task rounds, test pass counts, file hashes, transport debugging and write/read probes belong in messages, session progress or acceptance records. A stable project limitation or development command may be documented at the appropriate level with its source; a test run is not a project direction.
Read existing documents and inspect relevant project files before changing knowledge. Distinguish user-approved intent from observed implementation and unverified worker reports. Never invent goals, promote a report to Host acceptance, or change project direction independently. If intent is unknown, report the question to the Host.
Write only new or changed, source-supported project facts at the proper level, preserving unrelated facts. If there is no durable change, report no change and the reason; do not create a document merely to prove maintenance ran. Rereading a write verifies persistence, not semantic correctness or Host approval. Report refs, evidence, uncertainties and conflicts to the Host for review.`;
