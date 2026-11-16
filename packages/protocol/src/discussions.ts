export type DiscussionMember = {
  id: string;
  kind: "model" | "cli";
  name: string;
  modelId?: string;
  installationId?: string;
  runtimeNamespace?: string;
  nativeSessionId?: string;
  contextCursor?: string;
  blocked?: boolean;
};
export type DiscussionRoom = {
  id: string;
  name: string;
  members: DiscussionMember[];
  createdAt: string;
  busy: boolean;
};
export type DiscussionMessage = {
  id: string;
  roomId: string;
  speaker: string;
  content: string;
  status: string;
  createdAt: string;
};
export type DiscussionKnowledge = {
  id: string;
  roomId: string;
  title: string;
  content: string;
  sourceIds: string[];
  createdAt: string;
};
