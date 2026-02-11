export type WorkflowStatus = "draft" | "active" | "inactive";

export type WorkflowNodeType =
  | "trigger.manual"
  | "trigger.voicemail5"
  | "action.email"
  | "action.sms"
  | "action.wait"
  | "action.agent";

export type WorkflowWaitUnit = "minutes" | "hours" | "days";

export type WorkflowPosition = { x: number; y: number };

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  position: WorkflowPosition;
  data: Record<string, unknown>;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
};

export type WorkflowSendWindow = {
  enabled: boolean;
  startTime: string;
  endTime: string;
  days: number[];
  timezone?: string;
};

export type WorkflowDefinitionSettings = {
  sendWindow?: WorkflowSendWindow;
};

export type WorkflowDefinition = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  settings?: WorkflowDefinitionSettings;
};

export type WorkflowRecord = {
  id: string;
  name: string;
  description?: string | null;
  status: WorkflowStatus;
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
};
