export type Contact = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

export type Conversation = {
  id: string;
  contactId?: string;
  channel?: string;
  lastMessageDate?: string;
  unreadCount?: number;
  lastMessageBody?: string;
};

export type Message = {
  id: string;
  conversationId?: string;
  contactId?: string;
  type: string;
  direction: string;
  body: string;
  subject?: string;
  timestamp: string;
};

export type MessageFilter = "ALL" | "TYPE_SMS" | "TYPE_EMAIL";

export type AiAgent = {
  id: string;
  name: string;
  description?: string;
  locationId?: string;
  status?: "draft" | "published" | "inactive" | "archived";
  currentVersion?: number;
  publishedVersion?: number;
  publishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  primaryGoal?: string;
  language?: string;
  active?: boolean;
  systemPrompt?: string;
  firstMessage?: string;
  toneOfVoice?: string;
  assertiveness?: number;
  responseSpeed?: string;
  maxFollowUps?: number;
  intervalHours?: number;
  followUpScheduleHours?: number[];
  followUpAutoEnabled?: boolean;
  followUpDelayMinMinutes?: number;
  followUpDelayMaxMinutes?: number;
  qualificationCriteriaMode?: string;
  qualificationCriteria?: string[];
  handoffEnabled?: boolean;
  handoffKeywords?: string[];
  autoMarkOutcomes?: boolean;
  salesHandoverStage?: string;
  reviewNeededStage?: string;
  lostStage?: string;
  lostDecisionPrompt?: string;
  lostKeywords?: string[];
  complianceBlockedPhrases?: string[];
  requireOptInForSms?: boolean;
  maxReplyChars?: number;
  faqs?: { question: string; answer: string }[];
  websites?: string[];
};

export type AiAgentVersion = {
  id: string;
  agentId: string;
  locationId: string;
  version: number;
  changeNote?: string;
  createdAt: string;
  settings: Record<string, unknown>;
};

export type AiAgentKnowledge = {
  id: string;
  agentId: string;
  locationId: string;
  sourceType: "faq" | "website" | "note" | "file";
  title?: string;
  sourceUrl?: string;
  content: string;
  contentHash?: string;
  refreshIntervalHours: number;
  lastRefreshedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowStatus = "draft" | "active" | "inactive";

export type WorkflowNodeType =
  | "trigger.manual"
  | "trigger.voicemail5"
  | "action.email"
  | "action.sms"
  | "action.wait"
  | "action.agent";

export type WorkflowDefinitionNode = {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

export type WorkflowDefinitionEdge = {
  id: string;
  source: string;
  target: string;
};

export type WorkflowDefinition = {
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
  settings?: {
    sendWindow?: {
      enabled: boolean;
      startTime: string;
      endTime: string;
      days: number[];
      timezone?: string;
    };
  };
};

export type Workflow = {
  id: string;
  name: string;
  description?: string | null;
  status: WorkflowStatus;
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
};
