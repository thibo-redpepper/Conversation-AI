import { AiAgent, AiAgentKnowledge, AiAgentVersion } from "../types";
import { normalizeAgent } from "./aiAgents";

const apiRequest = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({ error: "Onverwachte response." }));
  if (!response.ok) {
    throw new Error((data as { error?: string })?.error || "Er ging iets mis.");
  }
  return data as T;
};

type ServerAgent = {
  id: string;
  locationId: string;
  name: string;
  description?: string;
  status: "draft" | "published" | "inactive" | "archived";
  active: boolean;
  currentVersion: number;
  publishedVersion: number;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  settings: Record<string, unknown>;
};

const toClientAgent = (serverAgent: ServerAgent): AiAgent =>
  normalizeAgent({
    ...serverAgent.settings,
    id: serverAgent.id,
    locationId: serverAgent.locationId,
    name: serverAgent.name,
    description: serverAgent.description,
    status: serverAgent.status,
    active: serverAgent.active,
    currentVersion: serverAgent.currentVersion,
    publishedVersion: serverAgent.publishedVersion,
    publishedAt: serverAgent.publishedAt,
    createdAt: serverAgent.createdAt,
    updatedAt: serverAgent.updatedAt,
  });

const toServerSettings = (agent: AiAgent) => {
  const settings = { ...agent } as Record<string, unknown>;
  delete settings["id"];
  delete settings["locationId"];
  delete settings["status"];
  delete settings["currentVersion"];
  delete settings["publishedVersion"];
  delete settings["publishedAt"];
  delete settings["createdAt"];
  delete settings["updatedAt"];
  delete settings["name"];
  delete settings["description"];
  delete settings["active"];
  return settings;
};

export const fetchAgentsForLocation = async (locationId: string) => {
  const data = await apiRequest<{ agents: ServerAgent[] }>(
    `/api/agents?locationId=${encodeURIComponent(locationId)}`
  );
  return (data.agents ?? []).map(toClientAgent);
};

export const createAgentForLocation = async (
  locationId: string,
  agent: AiAgent,
  changeNote?: string
) => {
  const data = await apiRequest<{ agent: ServerAgent }>("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      locationId,
      name: agent.name,
      description: agent.description,
      active: agent.active,
      settings: toServerSettings(agent),
      changeNote,
    }),
  });
  return toClientAgent(data.agent);
};

export const updateAgentOnServer = async (agentId: string, agent: AiAgent, changeNote?: string) => {
  const data = await apiRequest<{ agent: ServerAgent }>(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: agent.name,
      description: agent.description,
      active: agent.active,
      settings: toServerSettings(agent),
      changeNote,
    }),
  });
  return toClientAgent(data.agent);
};

export const archiveAgentOnServer = async (agentId: string) => {
  await apiRequest<{ success: boolean }>(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
};

export const publishAgentOnServer = async (agentId: string, note?: string) => {
  const data = await apiRequest<{ agent: ServerAgent }>(
    `/api/agents/${encodeURIComponent(agentId)}/publish`,
    {
      method: "POST",
      body: JSON.stringify({ note }),
    }
  );
  return toClientAgent(data.agent);
};

export const rollbackAgentOnServer = async (
  agentId: string,
  version: number,
  publish = true,
  note?: string
) => {
  const data = await apiRequest<{ agent: ServerAgent }>(
    `/api/agents/${encodeURIComponent(agentId)}/rollback`,
    {
      method: "POST",
      body: JSON.stringify({ version, publish, note }),
    }
  );
  return toClientAgent(data.agent);
};

export const fetchAgentVersions = async (agentId: string) => {
  const data = await apiRequest<{ versions: AiAgentVersion[] }>(
    `/api/agents/${encodeURIComponent(agentId)}/versions`
  );
  return data.versions ?? [];
};

export const fetchAgentKnowledge = async (agentId: string) => {
  const data = await apiRequest<{ knowledge: AiAgentKnowledge[] }>(
    `/api/agents/${encodeURIComponent(agentId)}/knowledge`
  );
  return data.knowledge ?? [];
};

export const refreshAllWebsiteKnowledge = async (agentId: string) => {
  const data = await apiRequest<{ entries: AiAgentKnowledge[] }>(
    `/api/agents/${encodeURIComponent(agentId)}/knowledge/refresh-all`,
    { method: "POST" }
  );
  return data.entries ?? [];
};

export const addKnowledgeNote = async (
  agentId: string,
  payload: { title?: string; content: string; sourceType?: "note" | "file" }
) => {
  const data = await apiRequest<{ entry: AiAgentKnowledge }>(
    `/api/agents/${encodeURIComponent(agentId)}/knowledge/note`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
  return data.entry;
};

export const deleteKnowledge = async (knowledgeId: string) => {
  await apiRequest<{ success: boolean }>(`/api/agents/knowledge/${encodeURIComponent(knowledgeId)}`, {
    method: "DELETE",
  });
};

export const refreshKnowledge = async (knowledgeId: string) => {
  const data = await apiRequest<{ entry: AiAgentKnowledge }>(
    `/api/agents/knowledge/${encodeURIComponent(knowledgeId)}/refresh`,
    {
      method: "POST",
    }
  );
  return data.entry;
};

export const fetchAgentStats = async (locationId: string, days = 30) => {
  return await apiRequest<{
    overall: {
      count: number;
      avgCostEur: number;
      avgLatencyMs: number;
      handoffCount: number;
      handoffRate: number;
      followUpStops: number;
      bySource: Record<string, number>;
    };
    byAgent: Record<
      string,
      {
        count: number;
        avgCostEur: number;
        avgLatencyMs: number;
        handoffCount: number;
        handoffRate: number;
        followUpStops: number;
        bySource: Record<string, number>;
      }
    >;
    windowDays: number;
  }>(`/api/agents/stats?locationId=${encodeURIComponent(locationId)}&days=${days}`);
};

export const fetchAgentHandoffs = async (locationId: string, limit = 100) => {
  const data = await apiRequest<{ handoffs: Array<Record<string, unknown>> }>(
    `/api/agents/handoffs?locationId=${encodeURIComponent(locationId)}&limit=${limit}`
  );
  return data.handoffs ?? [];
};

export const fetchEvalCases = async (locationId: string) => {
  const data = await apiRequest<{ cases: Array<Record<string, unknown>> }>(
    `/api/agents/evals/cases?locationId=${encodeURIComponent(locationId)}`
  );
  return data.cases ?? [];
};

export const saveEvalCase = async (
  locationId: string,
  payload: {
    id?: string;
    title: string;
    payload: Record<string, unknown>;
    expected: Record<string, unknown>;
    active?: boolean;
  }
) => {
  const data = await apiRequest<{ case: Record<string, unknown> }>("/api/agents/evals/cases", {
    method: "POST",
    body: JSON.stringify({
      locationId,
      ...payload,
    }),
  });
  return data.case;
};

export const removeEvalCase = async (id: string) => {
  await apiRequest<{ success: boolean }>(`/api/agents/evals/cases/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
};

export const fetchEvalRuns = async (locationId: string, limit = 100) => {
  const data = await apiRequest<{ runs: Array<Record<string, unknown>> }>(
    `/api/agents/evals/runs?locationId=${encodeURIComponent(locationId)}&limit=${limit}`
  );
  return data.runs ?? [];
};

export const runAgentEvals = async (agentId: string, locationId: string) => {
  return await apiRequest<{
    summary: { total: number; passed: number; failed: number; averageScore: number };
    results: Array<{
      id?: string;
      title: string;
      passed: boolean;
      score: number;
      output: string;
      feedback: string;
    }>;
  }>(`/api/agents/${encodeURIComponent(agentId)}/evals/run`, {
    method: "POST",
    body: JSON.stringify({ locationId }),
  });
};
