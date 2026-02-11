import React, { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  type NodeProps,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import type {
  AiAgent,
  Workflow,
  WorkflowDefinition,
  WorkflowDefinitionNode,
  WorkflowNodeType,
  WorkflowStatus,
} from "../types";
import { fetchAgentsForLocation } from "../utils/agentApi";

type Location = { id: string; name: string };

type ValidationError = { message: string; nodeId?: string };
type BuilderTab = "builder" | "settings" | "history" | "debug";
type EnrollmentItem = {
  id: string;
  leadName?: string | null;
  leadEmail?: string | null;
  leadPhone?: string | null;
  status: "success" | "failed";
  source: string;
  completedAt?: string;
  createdAt: string;
  steps: Array<{
    id: string;
    nodeId: string;
    nodeType: WorkflowNodeType | string;
    status: "success" | "failed";
    output?: Record<string, unknown>;
  }>;
};

type DebugSummary = {
  total: number;
  active: number;
  inactive: number;
  autoReplyReady: number;
  totalEvents: number;
  errorEvents: number;
};

type DebugEvent = {
  id: string;
  eventType: string;
  level: "info" | "warn" | "error";
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
};

type DebugSession = {
  id: string;
  workflowId: string;
  enrollmentId?: string | null;
  locationId?: string | null;
  active: boolean;
  activatedAt: string;
  updatedAt: string;
  lead: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    phoneNorm?: string | null;
  };
  twilio: {
    fromPhone?: string | null;
  };
  agent: {
    id: string;
    name: string;
    active: boolean;
    status: string;
  };
  enrollment: {
    id: string;
    status: string;
    source: string;
    currentNodeId?: string;
    currentNodeType?: string;
    currentNodeStatus?: string;
    currentNodePaused?: boolean;
    createdAt?: string;
    completedAt?: string;
  } | null;
  autoReply: {
    ready: boolean;
    reason: string;
    lastInboundAt?: string | null;
    lastOutboundAt?: string | null;
  };
  lastInboundMessage: {
    body: string;
    fromPhone: string;
    toPhone: string;
    timestamp: string;
  } | null;
  lastOutboundMessage: {
    body: string;
    fromPhone: string;
    toPhone: string;
    status?: string;
    timestamp: string;
  } | null;
  lastAgentRun: {
    id: string;
    source: string;
    model?: string;
    responseMs?: number;
    handoffRequired: boolean;
    handoffReason?: string;
    safetyFlags: string[];
    createdAt: string;
  } | null;
  recentEvents: DebugEvent[];
};

type OpportunitySearchItem = {
  id: string;
  contactId?: string;
  name?: string;
  pipelineStageName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
};

type OpportunitySearchResponse = {
  opportunities?: OpportunitySearchItem[];
  error?: string;
};

const DAY_OPTIONS = [
  { label: "Zondag", value: 0 },
  { label: "Maandag", value: 1 },
  { label: "Dinsdag", value: 2 },
  { label: "Woensdag", value: 3 },
  { label: "Donderdag", value: 4 },
  { label: "Vrijdag", value: 5 },
  { label: "Zaterdag", value: 6 },
];

const isTriggerType = (type: WorkflowNodeType | string) =>
  type === "trigger.manual" || type === "trigger.voicemail5";

const buildLinearChain = (
  definition: WorkflowDefinition,
  options?: { validateConfig?: boolean }
): ValidationError | { chain: WorkflowDefinitionNode[] } => {
  const nodes = definition.nodes ?? [];
  const edges = definition.edges ?? [];
  const byId = new Map<string, WorkflowDefinitionNode>();
  for (const node of nodes) {
    if (!node?.id) return { message: "Node id ontbreekt." };
    if (byId.has(node.id)) return { message: "Node id moet uniek zijn.", nodeId: node.id };
    byId.set(node.id, node);
  }

  const triggers = nodes.filter((n) => isTriggerType(n.type));
  if (triggers.length !== 1) return { message: "Workflow moet exact 1 trigger hebben." };
  const trigger = triggers[0]!;

  const outgoing = new Map<string, string>();
  const incomingCount = new Map<string, number>();
  nodes.forEach((n) => incomingCount.set(n.id, 0));

  for (const edge of edges) {
    if (!edge.source || !edge.target) return { message: "Edge mist source/target." };
    if (!byId.has(edge.source)) return { message: "Edge source bestaat niet.", nodeId: edge.source };
    if (!byId.has(edge.target)) return { message: "Edge target bestaat niet.", nodeId: edge.target };
    if (outgoing.has(edge.source)) return { message: "Max 1 outgoing edge per node.", nodeId: edge.source };
    outgoing.set(edge.source, edge.target);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  for (const node of nodes) {
    const inc = incomingCount.get(node.id) ?? 0;
    if (node.id === trigger.id) {
      if (inc !== 0) return { message: "Trigger mag geen incoming edges hebben.", nodeId: node.id };
      continue;
    }
    if (inc !== 1) return { message: "Elke module moet exact 1 incoming edge hebben.", nodeId: node.id };
  }

  const visited = new Set<string>();
  const chain: WorkflowDefinitionNode[] = [];
  let currentId: string | undefined = trigger.id;
  while (currentId) {
    if (visited.has(currentId)) return { message: "Cycle gedetecteerd.", nodeId: currentId };
    visited.add(currentId);
    const node = byId.get(currentId);
    if (!node) break;
    chain.push(node);
    currentId = outgoing.get(currentId);
  }

  if (visited.size !== nodes.length) {
    const unreachable = nodes.find((n) => !visited.has(n.id));
    return { message: "Niet alle nodes zijn bereikbaar vanaf de trigger.", nodeId: unreachable?.id };
  }

  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const posInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;

  if (options?.validateConfig !== false) {
    for (const node of chain) {
      if (node.type === "action.email") {
        if (!nonEmpty(node.data?.subject)) return { message: "Email: 'subject' ontbreekt.", nodeId: node.id };
        if (!nonEmpty(node.data?.body)) return { message: "Email: 'body' ontbreekt.", nodeId: node.id };
      }
      if (node.type === "action.sms") {
        if (!nonEmpty(node.data?.message)) return { message: "SMS: 'message' ontbreekt.", nodeId: node.id };
      }
      if (node.type === "action.wait") {
        if (!posInt(node.data?.amount)) return { message: "Wacht: amount moet > 0 zijn.", nodeId: node.id };
        if (!["minutes", "hours", "days"].includes(String(node.data?.unit)))
          return { message: "Wacht: unit moet minutes/hours/days zijn.", nodeId: node.id };
      }
      if (node.type === "action.agent") {
        if (!nonEmpty(node.data?.agentId))
          return { message: "Agent: kies een AI Agent.", nodeId: node.id };
      }
    }
  }

  return { chain };
};

const nodeLabel = (type: WorkflowNodeType) => {
  if (type === "trigger.manual") return "Test trigger";
  if (type === "trigger.voicemail5") return "Voicemail 5";
  if (type === "action.email") return "Email";
  if (type === "action.sms") return "SMS";
  if (type === "action.agent") return "Agent overdracht";
  return "Wachten";
};

const toOpportunityDisplayName = (item: OpportunitySearchItem) =>
  item.contactName?.trim() ||
  item.name?.trim() ||
  item.contactEmail?.split("@")[0] ||
  item.contactPhone ||
  "Onbekende lead";

const WORKFLOW_VERTICAL_GAP = 140;

const formatDateTime = (value?: string | null) => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("nl-BE");
};

const resolveEnrollmentCurrentNodeId = (
  steps: Array<{
    nodeId: string;
    nodeType: WorkflowNodeType | string;
    status: "success" | "failed";
    output?: Record<string, unknown>;
  }>
) => {
  if (!Array.isArray(steps) || steps.length === 0) return undefined;
  const failed = steps.find((step) => step.status === "failed");
  if (failed?.nodeId) return failed.nodeId;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step) continue;
    if (step.output && typeof step.output === "object" && step.output["paused"] === true) {
      return step.nodeId;
    }
  }
  return steps[steps.length - 1]?.nodeId;
};

const TriggerNode: React.FC<NodeProps<Record<string, unknown>>> = (props) => {
  const isManual = props.type === "trigger.manual";
  const enrollmentCount = Number(props.data?.enrollmentCount ?? 0);
  const isProjected = Boolean(props.data?.enrollmentProjected);
  const openEnrollments = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const callback = props.data?.onOpenEnrollments;
    if (typeof callback === "function") {
      callback(props.id);
    }
  };
  return (
    <div className={`wf-node wf-node--trigger ${props.selected ? "wf-node--selected" : ""}`}>
      {enrollmentCount > 0 ? (
        <button
          type="button"
          className={`wf-node__occupancy ${isProjected ? "wf-node__occupancy--projected" : ""}`}
          onClick={openEnrollments}
        >
          <svg viewBox="0 0 24 24" className="ghl-icon" aria-hidden="true">
            <path d="M7.5 12a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm9 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM3 20c0-2.6 2.8-4.5 6-4.5s6 1.9 6 4.5V21H3v-1zm11.3 1v-1c0-1.2-.4-2.3-1.1-3.2.8-.2 1.5-.3 2.3-.3 3.2 0 5.5 1.9 5.5 4.5V21h-6.7z" />
          </svg>
          <span>{enrollmentCount}</span>
        </button>
      ) : null}
      <div className="wf-node__tag wf-node__tag--trigger">
        <span className="wf-node__tag-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="ghl-icon">
            <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
          </svg>
        </span>
        TRIGGER
      </div>
      <div className="wf-node__title">{isManual ? "Test trigger" : "Voicemail 5"}</div>
      <div className="wf-node__subtitle">
        {isManual ? "Manueel starten voor tests" : "Start van de workflow"}
      </div>
      <Handle type="source" position={Position.Bottom} className="wf-handle" />
    </div>
  );
};

const ActionNode: React.FC<NodeProps<Record<string, unknown>>> = (props) => {
  const type = (props.type as WorkflowNodeType) ?? "action.wait";
  const title = nodeLabel(type);
  const enrollmentCount = Number(props.data?.enrollmentCount ?? 0);
  const isProjected = Boolean(props.data?.enrollmentProjected);
  const openEnrollments = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const callback = props.data?.onOpenEnrollments;
    if (typeof callback === "function") {
      callback(props.id);
    }
  };
  const tone =
    type === "action.email"
      ? "email"
      : type === "action.sms"
      ? "sms"
      : type === "action.agent"
      ? "agent"
      : "wait";
  return (
    <div
      className={`wf-node wf-node--action wf-node--${tone} ${
        props.selected ? "wf-node--selected" : ""
      }`}
    >
      {enrollmentCount > 0 ? (
        <button
          type="button"
          className={`wf-node__occupancy ${isProjected ? "wf-node__occupancy--projected" : ""}`}
          onClick={openEnrollments}
        >
          <svg viewBox="0 0 24 24" className="ghl-icon" aria-hidden="true">
            <path d="M7.5 12a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm9 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM3 20c0-2.6 2.8-4.5 6-4.5s6 1.9 6 4.5V21H3v-1zm11.3 1v-1c0-1.2-.4-2.3-1.1-3.2.8-.2 1.5-.3 2.3-.3 3.2 0 5.5 1.9 5.5 4.5V21h-6.7z" />
          </svg>
          <span>{enrollmentCount}</span>
        </button>
      ) : null}
      <div className="wf-node__tag">
        {type === "action.email"
          ? "EMAIL"
          : type === "action.sms"
          ? "SMS"
          : type === "action.agent"
          ? "AGENT"
          : "WAIT"}
      </div>
      <div className="wf-node__title">{title}</div>
      <div className="wf-node__subtitle">
        {type === "action.email"
          ? String(props.data?.subject || "Nieuw email bericht")
          : type === "action.sms"
          ? String(props.data?.message || "Nieuw SMS bericht")
          : type === "action.agent"
          ? String(props.data?.agentName || "Kies AI Agent")
          : `${String(props.data?.amount || 1)} ${String(props.data?.unit || "hours")}`}
      </div>
      <Handle type="target" position={Position.Top} className="wf-handle" />
      <Handle type="source" position={Position.Bottom} className="wf-handle" />
    </div>
  );
};

const WorkflowBuilder: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState<BuilderTab>("builder");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [workflowId, setWorkflowId] = useState<string | null>(id ?? null);
  const [name, setName] = useState("Nieuwe Workflow");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<WorkflowStatus>("draft");
  const [testOpen, setTestOpen] = useState(false);
  const [emailOverride, setEmailOverride] = useState("");
  const [smsOverride, setSmsOverride] = useState("");
  const [leadName, setLeadName] = useState("Workflow test lead");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadPhone, setLeadPhone] = useState("");
  const [leadChannel, setLeadChannel] = useState<"SMS" | "EMAIL">("SMS");
  const [leadLastMessage, setLeadLastMessage] = useState("");
  const [leadContactId, setLeadContactId] = useState("");
  const [leadConversationId, setLeadConversationId] = useState("");
  const [opportunityQuery, setOpportunityQuery] = useState("");
  const [opportunityResults, setOpportunityResults] = useState<OpportunitySearchItem[]>([]);
  const [opportunityLoading, setOpportunityLoading] = useState(false);
  const [opportunityError, setOpportunityError] = useState<string | undefined>();
  const [selectedOpportunityId, setSelectedOpportunityId] = useState<string | null>(null);
  const [sendWindowEnabled, setSendWindowEnabled] = useState(true);
  const [windowStartTime, setWindowStartTime] = useState("09:00");
  const [windowEndTime, setWindowEndTime] = useState("17:00");
  const [windowDays, setWindowDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [windowTimezone, setWindowTimezone] = useState("Europe/Brussels");
  const [enrollments, setEnrollments] = useState<EnrollmentItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | undefined>();
  const [testLoading, setTestLoading] = useState(false);
  const [testReport, setTestReport] = useState<any | null>(null);
  const [testError, setTestError] = useState<string | undefined>();
  const [nodeQueue, setNodeQueue] = useState<{ nodeId: string; label: string } | null>(null);
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | undefined>();
  const [debugSummary, setDebugSummary] = useState<DebugSummary>({
    total: 0,
    active: 0,
    inactive: 0,
    autoReplyReady: 0,
    totalEvents: 0,
    errorEvents: 0,
  });
  const [debugSessions, setDebugSessions] = useState<DebugSession[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | undefined>();

  const initialDefinition = useMemo<WorkflowDefinition>(() => {
    const triggerId = "trigger-manual";
    return {
      nodes: [
        {
          id: triggerId,
          type: "trigger.manual",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
      settings: {
        sendWindow: {
          enabled: true,
          startTime: "09:00",
        endTime: "17:00",
        days: [1, 2, 3, 4, 5],
        timezone: "Europe/Brussels",
      },
      },
    };
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialDefinition.nodes as any);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialDefinition.edges as any);

  const nodeTypes = useMemo(
    () => ({
      "trigger.manual": TriggerNode,
      "trigger.voicemail5": TriggerNode,
      "action.email": ActionNode,
      "action.sms": ActionNode,
      "action.wait": ActionNode,
      "action.agent": ActionNode,
    }),
    []
  );

  useEffect(() => {
    const load = async () => {
      const response = await fetch("/api/locations");
      const data = await response.json().catch(() => ({}));
      setLocations(data.locations ?? []);
    };
    load();
  }, []);

  const subaccountOptions = useMemo(() => {
    const preferred = ["Vastgoed", "Dakwerken", "Gevelwerken"];
    const filtered = locations.filter((loc) => preferred.includes(loc.name));
    return filtered.length ? filtered : locations;
  }, [locations]);

  useEffect(() => {
    if (!selectedLocationId && subaccountOptions.length > 0) {
      setSelectedLocationId(subaccountOptions[0].id);
    }
  }, [selectedLocationId, subaccountOptions]);

  useEffect(() => {
    if (!selectedLocationId) return;
    fetchAgentsForLocation(selectedLocationId)
      .then((items) => setAgents(items))
      .catch(() => setAgents([]));
  }, [selectedLocationId]);

  const loadEnrollments = async () => {
    if (!workflowId) {
      setEnrollments([]);
      return;
    }
    setHistoryLoading(true);
    setHistoryError(undefined);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/enrollments?limit=100`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Enrollment history laden mislukt.");
      setEnrollments((data.enrollments ?? []) as EnrollmentItem[]);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Enrollment history laden mislukt.");
      setEnrollments([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadDebugPanel = async () => {
    if (!workflowId) {
      setDebugSummary({
        total: 0,
        active: 0,
        inactive: 0,
        autoReplyReady: 0,
        totalEvents: 0,
        errorEvents: 0,
      });
      setDebugSessions([]);
      return;
    }
    setDebugLoading(true);
    setDebugError(undefined);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/debug?limit=50`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Debug panel laden mislukt.");
      const summary = (data.summary ?? {}) as Partial<DebugSummary>;
      setDebugSummary({
        total: Number(summary.total ?? 0),
        active: Number(summary.active ?? 0),
        inactive: Number(summary.inactive ?? 0),
        autoReplyReady: Number(summary.autoReplyReady ?? 0),
        totalEvents: Number(summary.totalEvents ?? 0),
        errorEvents: Number(summary.errorEvents ?? 0),
      });
      setDebugSessions((data.sessions ?? []) as DebugSession[]);
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : "Debug panel laden mislukt.");
      setDebugSummary({
        total: 0,
        active: 0,
        inactive: 0,
        autoReplyReady: 0,
        totalEvents: 0,
        errorEvents: 0,
      });
      setDebugSessions([]);
    } finally {
      setDebugLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "history") return;
    loadEnrollments();
  }, [activeTab, workflowId]);

  useEffect(() => {
    if (activeTab !== "debug") return;
    void loadDebugPanel();
    const timer = window.setInterval(() => {
      void loadDebugPanel();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [activeTab, workflowId]);

  const toggleWindowDay = (day: number) => {
    setWindowDays((prev) =>
      prev.includes(day) ? prev.filter((item) => item !== day) : [...prev, day].sort((a, b) => a - b)
    );
  };

  const toDefinition = (): WorkflowDefinition => ({
    nodes: nodes.map((n: any) => ({ id: n.id, type: n.type, position: n.position, data: n.data ?? {} })),
    edges: edges.map((e: any) => ({ id: e.id, source: e.source, target: e.target })),
    settings: {
      sendWindow: {
        enabled: sendWindowEnabled,
        startTime: windowStartTime,
        endTime: windowEndTime,
        days: windowDays,
        timezone: windowTimezone,
      },
    },
  });

  const loadWorkflow = async (workflowIdToLoad: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/workflows/${workflowIdToLoad}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Workflow laden mislukt.");
      const wf: Workflow = data.workflow;
      setWorkflowId(wf.id);
      setName(wf.name);
      setDescription(wf.description ?? "");
      setStatus(wf.status);
      setNodes(wf.definition.nodes as any);
      setEdges(wf.definition.edges as any);
      const sendWindow = wf.definition.settings?.sendWindow;
      setSendWindowEnabled(sendWindow?.enabled ?? true);
      setWindowStartTime(sendWindow?.startTime ?? "09:00");
      setWindowEndTime(sendWindow?.endTime ?? "17:00");
      setWindowDays(
        Array.isArray(sendWindow?.days) && sendWindow.days.length > 0
          ? sendWindow.days
          : [1, 2, 3, 4, 5]
      );
      setWindowTimezone(sendWindow?.timezone ?? "Europe/Brussels");
      setSelectedNodeId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow laden mislukt.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (id) {
      loadWorkflow(id);
      return;
    }
    setWorkflowId(null);
    setName("Nieuwe Workflow");
    setDescription("");
    setStatus("draft");
    setNodes(initialDefinition.nodes as any);
    setEdges(initialDefinition.edges as any);
    setSendWindowEnabled(true);
    setWindowStartTime("09:00");
    setWindowEndTime("17:00");
    setWindowDays([1, 2, 3, 4, 5]);
    setWindowTimezone("Europe/Brussels");
    setEnrollments([]);
    setHistoryError(undefined);
    setSelectedNodeId(null);
  }, [id, initialDefinition, setEdges, setNodes]);

  const appendNode = (type: WorkflowNodeType) => {
    setError(undefined);
    const definition = toDefinition();
    const chainResult = buildLinearChain(definition, { validateConfig: false });
    if ("message" in chainResult) {
      setError(chainResult.message);
      return;
    }
    const chain = chainResult.chain;
    const last = chain[chain.length - 1];
    const newId = `n-${crypto.randomUUID()}`;
    const nextX = last?.position?.x ?? 0;
    const nextY = (last?.position?.y ?? 0) + WORKFLOW_VERTICAL_GAP;

    const baseData: Record<string, unknown> =
      type === "action.email"
        ? { to: "{{lead.email}}", subject: "", body: "" }
        : type === "action.sms"
        ? { to: "{{lead.phone}}", message: "" }
        : type === "action.wait"
        ? { amount: 2, unit: "hours" }
        : type === "action.agent"
        ? { agentId: "", agentName: "", notes: "" }
        : {};

    const newNode = {
      id: newId,
      type,
      position: { x: nextX, y: nextY },
      data: baseData,
    };

    const newEdge = last
      ? { id: `e-${last.id}-${newId}`, source: last.id, target: newId }
      : null;

    setNodes((prev: any[]) => [...prev, newNode]);
    if (newEdge) {
      setEdges((prev: any[]) => [...prev, newEdge]);
    }
    setSelectedNodeId(newId);
  };

  const removeSelectedNode = () => {
    const nodeId = selectedNodeId;
    if (!nodeId) return;
    const selected = nodes.find((n: any) => n.id === nodeId);
    if (!selected || isTriggerType(String(selected.type))) return;

    const incoming = edges.find((e: any) => e.target === nodeId);
    const outgoing = edges.find((e: any) => e.source === nodeId);

    const nextEdges = edges
      .filter((e: any) => e.source !== nodeId && e.target !== nodeId)
      .map((e: any) => ({ ...e }));

    if (incoming && outgoing) {
      nextEdges.push({
        id: `e-${incoming.source}-${outgoing.target}-${Date.now()}`,
        source: incoming.source,
        target: outgoing.target,
      });
    }

    setNodes((prev: any[]) => prev.filter((n: any) => n.id !== nodeId));
    setEdges(nextEdges as any);
    setSelectedNodeId(null);
  };

  const updateSelectedNodeData = (patch: Record<string, unknown>) => {
    const nodeId = selectedNodeId;
    if (!nodeId) return;
    setNodes((prev: any[]) =>
      prev.map((node: any) =>
        node.id === nodeId ? { ...node, data: { ...(node.data ?? {}), ...patch } } : node
      )
    );
  };

  const selectedNode = selectedNodeId ? nodes.find((n: any) => n.id === selectedNodeId) : null;
  const openNodeQueue = React.useCallback(
    (nodeId: string) => {
      const node = (nodes as any[]).find((item) => item.id === nodeId);
      const label = node ? nodeLabel(node.type as WorkflowNodeType) : "Node";
      setQueueError(undefined);
      setNodeQueue({ nodeId, label });
    },
    [nodes]
  );
  const projectedNodeId = useMemo(() => {
    if (!testReport || !Array.isArray(testReport.steps) || testReport.steps.length === 0) {
      return undefined;
    }
    const steps = testReport.steps as Array<{
      nodeId?: unknown;
      type?: unknown;
      status?: unknown;
    }>;
    const failed = steps.find((step) => step.status === "failed");
    if (failed && typeof failed.nodeId === "string" && failed.nodeId) {
      return failed.nodeId;
    }

    // Voor "waar zit deze lead nu?" pinnen we op de eerste wait-node.
    // Een enrollment blijft daar eerst hangen voordat hij naar de volgende node gaat.
    const firstWait = steps.find(
      (step) => step.type === "action.wait" && step.status === "success"
    );
    if (firstWait && typeof firstWait.nodeId === "string" && firstWait.nodeId) {
      return firstWait.nodeId;
    }

    const lastStep = steps[steps.length - 1];
    return typeof lastStep?.nodeId === "string" && lastStep.nodeId
      ? lastStep.nodeId
      : undefined;
  }, [testReport]);

  const nodeEnrollmentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const enrollment of enrollments) {
      const nodeId = resolveEnrollmentCurrentNodeId(
        (Array.isArray(enrollment.steps) ? enrollment.steps : []) as EnrollmentItem["steps"]
      );
      if (!nodeId) continue;
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
    }
    return counts;
  }, [enrollments]);

  const nodesForCanvas = useMemo(() => {
    return (nodes as any[]).map((node) => {
      const baseCount = nodeEnrollmentCounts.get(node.id) ?? 0;
      const isProjected = projectedNodeId === node.id;
      const projectedBoost = isProjected && baseCount === 0 ? 1 : 0;
      return {
        ...node,
        data: {
          ...(node.data ?? {}),
          enrollmentCount: baseCount + projectedBoost,
          enrollmentProjected: isProjected,
          onOpenEnrollments: openNodeQueue,
        },
      };
    });
  }, [nodes, nodeEnrollmentCounts, projectedNodeId, openNodeQueue]);

  const queueEnrollments = useMemo(() => {
    if (!nodeQueue) return [] as EnrollmentItem[];
    return enrollments.filter((enrollment) => {
      const currentNode = resolveEnrollmentCurrentNodeId(
        (Array.isArray(enrollment.steps) ? enrollment.steps : []) as EnrollmentItem["steps"]
      );
      return currentNode === nodeQueue.nodeId;
    });
  }, [enrollments, nodeQueue]);

  const alignFlow = () => {
    setError(undefined);
    const definition = toDefinition();
    const chainResult = buildLinearChain(definition, { validateConfig: false });
    if ("message" in chainResult) {
      setError(`Flow kan niet uitgelijnd worden: ${chainResult.message}`);
      return;
    }
    const chain = chainResult.chain;
    if (chain.length === 0) return;

    const baseX = Number(chain[0]?.position?.x ?? 0);
    const baseY = Number(chain[0]?.position?.y ?? 0);
    const aligned = new Map(
      chain.map((node, index) => [
        node.id,
        {
          x: baseX,
          y: baseY + index * WORKFLOW_VERTICAL_GAP,
        },
      ])
    );

    setNodes((prev: any[]) =>
      prev.map((node: any) =>
        aligned.has(node.id)
          ? { ...node, position: aligned.get(node.id)! }
          : node
      )
    );

    requestAnimationFrame(() => {
      reactFlowInstance?.fitView({ padding: 0.22, duration: 260 });
    });
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const definition = toDefinition();
      const validation = buildLinearChain(definition, { validateConfig: true });
      if ("message" in validation) {
        setError(validation.message);
        if (validation.nodeId) setSelectedNodeId(validation.nodeId);
        return;
      }

      const response = await fetch(workflowId ? `/api/workflows/${workflowId}` : "/api/workflows", {
        method: workflowId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, status, definition }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Opslaan mislukt.");
      }
      const wf: Workflow = data.workflow;
      setWorkflowId(wf.id);
      if (!id) {
        navigate(`/workflows/${wf.id}`, { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Opslaan mislukt.");
    } finally {
      setSaving(false);
    }
  };

  const openTest = async () => {
    setTestReport(null);
    setTestError(undefined);
    setOpportunityError(undefined);
    setOpportunityResults([]);
    setSelectedOpportunityId(null);
    if (!workflowId) {
      setTestError("Sla de workflow eerst op voordat je kan testen.");
      setTestOpen(true);
      return;
    }
    setTestOpen(true);
  };

  const searchOpportunities = async () => {
    if (!selectedLocationId) {
      setOpportunityError("Selecteer eerst een subaccount.");
      return;
    }
    const query = opportunityQuery.trim();
    if (!query) {
      setOpportunityError("Geef een naam, e-mail of telefoonnummer in om te zoeken.");
      setOpportunityResults([]);
      return;
    }

    setOpportunityLoading(true);
    setOpportunityError(undefined);
    try {
      const params = new URLSearchParams();
      params.set("locationId", selectedLocationId);
      params.set("q", query);
      const response = await fetch(`/api/ghl/opportunities?${params.toString()}`);
      const data = (await response.json().catch(() => ({}))) as OpportunitySearchResponse;
      if (!response.ok) {
        throw new Error(data?.error || "Zoeken naar opportunities mislukt.");
      }
      setOpportunityResults(data.opportunities ?? []);
      if ((data.opportunities ?? []).length === 0) {
        setOpportunityError("Geen matching opportunities gevonden.");
      }
    } catch (err) {
      setOpportunityError(
        err instanceof Error ? err.message : "Zoeken naar opportunities mislukt."
      );
      setOpportunityResults([]);
    } finally {
      setOpportunityLoading(false);
    }
  };

  const selectOpportunityForTest = (item: OpportunitySearchItem) => {
    const nextName = toOpportunityDisplayName(item);
    const nextEmail = item.contactEmail?.trim() ?? "";
    const nextPhone = item.contactPhone?.trim() ?? "";
    const nextChannel: "SMS" | "EMAIL" = nextPhone ? "SMS" : "EMAIL";
    setSelectedOpportunityId(item.id);
    setLeadName(nextName);
    setLeadEmail(nextEmail);
    setLeadPhone(nextPhone);
    setLeadChannel(nextChannel);
    setEmailOverride(nextEmail);
    setSmsOverride(nextPhone);
    setLeadContactId(item.contactId?.trim() ?? "");
    setLeadConversationId("");
    setTestError(undefined);
  };

  const runTest = async () => {
    if (!workflowId) return;
    setTestLoading(true);
    setTestError(undefined);
    setTestReport(null);
    try {
      const response = await fetch(`/api/workflows/${workflowId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId: selectedLocationId ?? undefined,
          testRecipients: {
            emailToOverride: emailOverride.trim() || undefined,
            smsToOverride: smsOverride.trim() || undefined,
            leadName: leadName.trim() || undefined,
            leadEmail: leadEmail.trim() || undefined,
            leadPhone: leadPhone.trim() || undefined,
            leadContactId: leadContactId.trim() || undefined,
            leadConversationId: leadConversationId.trim() || undefined,
            leadChannel,
            leadLastMessage: leadLastMessage.trim() || undefined,
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Testen mislukt.");
      setTestReport(data);
      await loadEnrollments();
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Testen mislukt.");
    } finally {
      setTestLoading(false);
    }
  };

  const advanceEnrollment = async (enrollmentId: string) => {
    if (!workflowId) return;
    setQueueBusyId(enrollmentId);
    setQueueError(undefined);
    try {
      const response = await fetch(
        `/api/workflows/${workflowId}/enrollments/${enrollmentId}/advance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locationId: selectedLocationId ?? undefined }),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Kon enrollment niet naar volgende stap pushen.");
      }
      await loadEnrollments();
    } catch (err) {
      setQueueError(
        err instanceof Error
          ? err.message
          : "Kon enrollment niet naar volgende stap pushen."
      );
    } finally {
      setQueueBusyId(null);
    }
  };

  const removeEnrollment = async (enrollmentId: string) => {
    if (!workflowId) return;
    setQueueBusyId(enrollmentId);
    setQueueError(undefined);
    try {
      const response = await fetch(
        `/api/workflows/${workflowId}/enrollments/${enrollmentId}`,
        {
          method: "DELETE",
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Kon enrollment niet verwijderen.");
      }
      await loadEnrollments();
    } catch (err) {
      setQueueError(
        err instanceof Error ? err.message : "Kon enrollment niet verwijderen."
      );
    } finally {
      setQueueBusyId(null);
    }
  };

  return (
    <div className="ghl-shell ghl-shell--workflows">
      <aside className="ghl-sidebar">
        <div className="ghl-brand">
          <span className="ghl-brand__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="ghl-icon">
              <path d="M4 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm6-3h4a2 2 0 0 1 2 2v1H8V6a2 2 0 0 1 2-2z" />
            </svg>
          </span>
          <div>
            <strong>LeadPilot</strong>
            <span>Workflows</span>
          </div>
        </div>

        <div className="ghl-account">
          <label>Subaccount</label>
          <select
            className="input"
            value={selectedLocationId ?? ""}
            onChange={(event) => setSelectedLocationId(event.target.value)}
          >
            {subaccountOptions.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </div>

        <nav className="ghl-nav">
          <NavLink className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`} to="/dashboard">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
              </svg>
            </span>
            Dashboard
          </NavLink>
          <NavLink className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`} to="/leads">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M7.5 12a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm9 0a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM3 20.5c0-3 3-5.5 6.5-5.5S16 17.5 16 20.5V22H3v-1.5zm9.5 1.5v-1.5c0-1.6-.6-3-1.6-4.1.8-.3 1.7-.4 2.6-.4 3.6 0 6.5 2.5 6.5 5.5V22h-7.5z" />
              </svg>
            </span>
            Leads
          </NavLink>
          <NavLink className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`} to="/conversations">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2zm3 4h10v2H7V9zm0 4h7v2H7v-2z" />
              </svg>
            </span>
            Conversations
          </NavLink>
          <NavLink className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`} to="/ai-agents">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2zm7 9l.9 2.6L22 14l-2.1.4L19 17l-.9-2.6L16 14l2.1-.4L19 11zM5 13l.9 2.6L8 16l-2.1.4L5 19l-.9-2.6L2 16l2.1-.4L5 13z" />
              </svg>
            </span>
            AI Agents
          </NavLink>
          <NavLink className={({ isActive }) => `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`} to="/workflows">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M9 3h6v4h2a2 2 0 0 1 2 2v2h-4V9H9v4H5V9a2 2 0 0 1 2-2h2V3zm-4 12h4v4H7a2 2 0 0 1-2-2v-2zm6 0h4v6h-4v-6zm6 0h4v2a2 2 0 0 1-2 2h-2v-4z" />
              </svg>
            </span>
            Workflows
          </NavLink>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M7 2h2v3H7V2zm8 0h2v3h-2V2zM4 5h16a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 6h16v9H4v-9z" />
              </svg>
            </span>
            Calendar
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 20V4h2v16H4zm7 0V9h2v11h-2zm7 0V13h2v7h-2z" />
              </svg>
            </span>
            Analytics
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M3 6h18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm0 4h18V8H3v2zm4 6h4v2H7v-2z" />
              </svg>
            </span>
            Billing
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm8.4 4a6.4 6.4 0 0 0-.1-1l2.1-1.6-2-3.5-2.5 1a7.7 7.7 0 0 0-1.7-1l-.3-2.7h-4l-.3 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1-2 3.5L3.6 11a6.4 6.4 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.7 7.7 0 0 0 1.7 1l.3 2.7h4l.3-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1 2-3.5-2.1-1.6c.1-.3.1-.6.1-1z" />
              </svg>
            </span>
            Settings
          </button>
        </nav>
      </aside>

      <main className="ghl-main ghl-main--workflows">
        <header className="ghl-main__header ghl-main__header--workflow-builder">
          <div className="workflow-header__top">
            <button className="button button--ghost" onClick={() => navigate("/workflows")}>
              ←
            </button>
            <div className="workflow-header__titles">
              <h1>{name || "Nieuwe Workflow"}</h1>
              <p>Workflow bewerken</p>
            </div>
          </div>
          <div className="workflow-toolbar">
            <div className="workflow-tabs">
              <button
                className={`workflow-tab ${activeTab === "builder" ? "workflow-tab--active" : ""}`}
                onClick={() => setActiveTab("builder")}
              >
                Builder
              </button>
              <button
                className={`workflow-tab ${activeTab === "settings" ? "workflow-tab--active" : ""}`}
                onClick={() => setActiveTab("settings")}
              >
                Settings
              </button>
              <button
                className={`workflow-tab ${activeTab === "history" ? "workflow-tab--active" : ""}`}
                onClick={() => setActiveTab("history")}
              >
                Enrollment History
              </button>
              <button
                className={`workflow-tab ${activeTab === "debug" ? "workflow-tab--active" : ""}`}
                onClick={() => setActiveTab("debug")}
              >
                Debug Panel
              </button>
            </div>

            <div className="workflow-header__actions">
              <button className="button button--ghost" onClick={openTest} disabled={saving || loading}>
                Test Workflow
              </button>
              <span className="workflow-status-label">{status === "active" ? "Publish" : "Draft"}</span>
              <label className="switch workflow-publish-switch" title="Workflow publiceren">
                <input
                  type="checkbox"
                  checked={status === "active"}
                  onChange={(event) => setStatus(event.target.checked ? "active" : "draft")}
                />
                <span className="slider" />
              </label>
              <button className="button" onClick={save} disabled={saving || loading}>
                {saving ? "Opslaan..." : "Opslaan"}
              </button>
            </div>
          </div>
        </header>

        {activeTab === "builder" ? (
          <>
            {error ? <div className="alert alert--error">{error}</div> : null}

            <section className="panel panel--workflows workflow-builder">
              <div className="workflow-builder__left">
                <div className="wf-section">
                  <h3>Workflow</h3>
                  <div className="field">
                    <label>Naam *</label>
                    <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Beschrijving</label>
                    <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Status</label>
                    <select className="input" value={status} onChange={(e) => setStatus(e.target.value as WorkflowStatus)}>
                      <option value="draft">Draft</option>
                      <option value="active">Actief</option>
                      <option value="inactive">Inactief</option>
                    </select>
                  </div>
                </div>

                <div className="wf-section">
                  <h3>Modules</h3>
                  <div className="wf-add">
                    <button className="button button--ghost" onClick={() => appendNode("action.email")}>
                      + Email
                    </button>
                    <button className="button button--ghost" onClick={() => appendNode("action.sms")}>
                      + SMS
                    </button>
                    <button className="button button--ghost" onClick={() => appendNode("action.wait")}>
                      + Wait
                    </button>
                    <button className="button button--ghost" onClick={() => appendNode("action.agent")}>
                      + Agent
                    </button>
                  </div>
                  <p className="muted">MVP: lineair. We voegen altijd toe aan het einde.</p>
                </div>

                <div className="wf-section">
                  <h3>Configuratie</h3>
                  {!selectedNode ? <div className="empty">Selecteer een node op het canvas.</div> : null}
                  {selectedNode && isTriggerType(String(selectedNode.type)) ? (
                    <div className="wf-config">
                      <div className="field">
                        <label>Trigger</label>
                        <input
                          className="input"
                          value={
                            selectedNode.type === "trigger.manual"
                              ? "Test trigger (manueel)"
                              : "Voicemail 5"
                          }
                          disabled
                        />
                      </div>
                    </div>
                  ) : null}

                  {selectedNode && selectedNode.type === "action.email" ? (
                    <div className="wf-config">
                      <div className="field">
                        <label>Naar</label>
                        <input
                          className="input"
                          value={String(selectedNode.data?.to ?? "")}
                          onChange={(e) => updateSelectedNodeData({ to: e.target.value })}
                          placeholder="{{lead.email}}"
                        />
                        <p className="workflow-settings__hint">
                          Optioneel. Leeg of <code>{"{{lead.email}}"}</code> gebruikt de lead email.
                        </p>
                      </div>
                      <div className="field">
                        <label>Onderwerp *</label>
                        <input
                          className="input"
                          value={String(selectedNode.data?.subject ?? "")}
                          onChange={(e) => updateSelectedNodeData({ subject: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label>Body *</label>
                        <textarea
                          className="textarea"
                          value={String(selectedNode.data?.body ?? "")}
                          onChange={(e) => updateSelectedNodeData({ body: e.target.value })}
                        />
                      </div>
                      <button className="button button--ghost button--danger" onClick={removeSelectedNode}>
                        Verwijderen
                      </button>
                    </div>
                  ) : null}

                  {selectedNode && selectedNode.type === "action.sms" ? (
                    <div className="wf-config">
                      <div className="field">
                        <label>Naar</label>
                        <input
                          className="input"
                          value={String(selectedNode.data?.to ?? "")}
                          onChange={(e) => updateSelectedNodeData({ to: e.target.value })}
                          placeholder="{{lead.phone}}"
                        />
                        <p className="workflow-settings__hint">
                          Optioneel. Leeg of <code>{"{{lead.phone}}"}</code> gebruikt de lead telefoon.
                        </p>
                      </div>
                      <div className="field">
                        <label>Bericht *</label>
                        <textarea
                          className="textarea"
                          value={String(selectedNode.data?.message ?? "")}
                          onChange={(e) => updateSelectedNodeData({ message: e.target.value })}
                        />
                      </div>
                      <button className="button button--ghost button--danger" onClick={removeSelectedNode}>
                        Verwijderen
                      </button>
                    </div>
                  ) : null}

                  {selectedNode && selectedNode.type === "action.wait" ? (
                    <div className="wf-config">
                      <div className="field">
                        <label>Aantal *</label>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          value={Number(selectedNode.data?.amount ?? 1)}
                          onChange={(e) => updateSelectedNodeData({ amount: Number(e.target.value) })}
                        />
                      </div>
                      <div className="field">
                        <label>Eenheid *</label>
                        <select
                          className="input"
                          value={String(selectedNode.data?.unit ?? "hours")}
                          onChange={(e) => updateSelectedNodeData({ unit: e.target.value })}
                        >
                          <option value="minutes">Minutes</option>
                          <option value="hours">Hours</option>
                          <option value="days">Days</option>
                        </select>
                      </div>
                      <button className="button button--ghost button--danger" onClick={removeSelectedNode}>
                        Verwijderen
                      </button>
                    </div>
                  ) : null}

                  {selectedNode && selectedNode.type === "action.agent" ? (
                    <div className="wf-config">
                      <div className="field">
                        <label>AI Agent *</label>
                        <select
                          className="input"
                          value={String(selectedNode.data?.agentId ?? "")}
                          onChange={(e) => {
                            const selectedAgent = agents.find((agent) => agent.id === e.target.value);
                            updateSelectedNodeData({
                              agentId: e.target.value,
                              agentName: selectedAgent?.name ?? "",
                            });
                          }}
                        >
                          <option value="">Kies agent</option>
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label>Interne notes</label>
                        <textarea
                          className="textarea"
                          value={String(selectedNode.data?.notes ?? "")}
                          onChange={(e) => updateSelectedNodeData({ notes: e.target.value })}
                        />
                      </div>
                      <button className="button button--ghost button--danger" onClick={removeSelectedNode}>
                        Verwijderen
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="workflow-builder__canvas">
                <ReactFlowProvider>
                  <ReactFlow
                    nodes={nodesForCanvas as any}
                    edges={edges as any}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onInit={setReactFlowInstance}
                    nodeTypes={nodeTypes}
                    fitView
                    nodesDraggable
                    nodesConnectable={false}
                    onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                  >
                    <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
                    <Controls position="bottom-right" />
                  </ReactFlow>
                </ReactFlowProvider>
                <button className="button button--ghost wf-align-button" onClick={alignFlow}>
                  Flow rechtzetten
                </button>
              </div>
            </section>
          </>
        ) : null}

        {activeTab === "settings" ? (
          <section className="panel panel--workflows workflow-settings">
            <div className="workflow-settings__inner">
              <div className="workflow-settings__section">
                <h3>Communication</h3>
                <div className="field">
                  <label>Timezone</label>
                  <select
                    className="input"
                    value={windowTimezone}
                    onChange={(event) => setWindowTimezone(event.target.value)}
                  >
                    <option value="Europe/Brussels">Account Timezone (Europe/Brussels)</option>
                    <option value="Europe/Amsterdam">Europe/Amsterdam</option>
                    <option value="Europe/Paris">Europe/Paris</option>
                    <option value="UTC">UTC</option>
                  </select>
                </div>
                <p>Wait stappen en time window execution volgen deze timezone.</p>
              </div>

              <div className="workflow-settings__section">
                <h3>Time Window</h3>
                <div className="wf-time-toggle">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={sendWindowEnabled}
                      onChange={(event) => setSendWindowEnabled(event.target.checked)}
                    />
                    <span className="slider" />
                  </label>
                  <span>Specific Time</span>
                </div>
                <p>Restrict acties zodat ze enkel verzonden worden binnen dit venster.</p>

                <div className="workflow-settings__grid">
                  <div className="field">
                    <label>Start Time</label>
                    <input
                      className="input"
                      type="time"
                      value={windowStartTime}
                      onChange={(event) => setWindowStartTime(event.target.value)}
                      disabled={!sendWindowEnabled}
                    />
                  </div>
                  <div className="field">
                    <label>End Time</label>
                    <input
                      className="input"
                      type="time"
                      value={windowEndTime}
                      onChange={(event) => setWindowEndTime(event.target.value)}
                      disabled={!sendWindowEnabled}
                    />
                  </div>
                </div>

                <div className="field">
                  <label>Include Days</label>
                  <div className="workflow-day-grid">
                    {DAY_OPTIONS.map((item) => {
                      const active = windowDays.includes(item.value);
                      return (
                        <button
                          key={item.value}
                          type="button"
                          className={`workflow-day ${active ? "workflow-day--active" : ""}`}
                          onClick={() => toggleWindowDay(item.value)}
                          disabled={!sendWindowEnabled}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="workflow-settings__hint">
                    Acties buiten dit venster worden overgeslagen in testmode.
                  </p>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "history" ? (
          <section className="panel panel--workflows workflow-history">
            {historyError ? <div className="alert alert--error">{historyError}</div> : null}
            {historyLoading ? <div className="ghl-muted">Enrollment history laden...</div> : null}
            {!historyLoading && enrollments.length === 0 ? (
              <div className="empty">Nog geen enrollment history.</div>
            ) : null}
            {!historyLoading && enrollments.length > 0 ? (
              <div className="workflow-history__list">
                {enrollments.map((entry) => (
                  <div key={entry.id} className="workflow-history__item">
                    <div className="workflow-history__head">
                      <div>
                        <strong>
                          {entry.leadName || entry.leadEmail || entry.leadPhone || "Onbekende lead"}
                        </strong>
                        <span>
                          {new Date(entry.createdAt).toLocaleString("nl-BE")} • {entry.source}
                        </span>
                      </div>
                      <span
                        className={`workflow-history__status ${
                          entry.status === "success" ? "workflow-history__status--ok" : "workflow-history__status--bad"
                        }`}
                      >
                        {entry.status}
                      </span>
                    </div>
                    <div className="workflow-history__steps">
                      {entry.steps.map((step) => (
                        <div key={step.id} className="workflow-history__step">
                          <strong>{nodeLabel(step.nodeType as WorkflowNodeType)}</strong>
                          <span>{step.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === "debug" ? (
          <section className="panel panel--workflows workflow-debug">
            <div className="workflow-debug__header">
              <div>
                <h3>AI Agent Debug</h3>
                <p>Live zicht op sessies, laatste berichten en auto-reply status.</p>
              </div>
              <button
                className="button button--ghost"
                onClick={() => void loadDebugPanel()}
                disabled={debugLoading}
              >
                {debugLoading ? "Vernieuwen..." : "Vernieuwen"}
              </button>
            </div>

            <div className="workflow-debug__summary">
              <div className="workflow-debug__summary-card">
                <span>Totaal sessies</span>
                <strong>{debugSummary.total}</strong>
              </div>
              <div className="workflow-debug__summary-card">
                <span>Actief</span>
                <strong>{debugSummary.active}</strong>
              </div>
              <div className="workflow-debug__summary-card">
                <span>Auto-reply klaar</span>
                <strong>{debugSummary.autoReplyReady}</strong>
              </div>
              <div className="workflow-debug__summary-card">
                <span>Inactief</span>
                <strong>{debugSummary.inactive}</strong>
              </div>
              <div className="workflow-debug__summary-card">
                <span>Events</span>
                <strong>{debugSummary.totalEvents}</strong>
              </div>
              <div className="workflow-debug__summary-card">
                <span>Error events</span>
                <strong>{debugSummary.errorEvents}</strong>
              </div>
            </div>

            {debugError ? <div className="alert alert--error">{debugError}</div> : null}
            {debugLoading && debugSessions.length === 0 ? (
              <div className="ghl-muted">Debug data laden...</div>
            ) : null}
            {!debugLoading && debugSessions.length === 0 ? (
              <div className="empty">Nog geen agent sessies voor deze workflow.</div>
            ) : null}

            {debugSessions.length > 0 ? (
              <div className="workflow-debug__list">
                {debugSessions.map((session) => (
                  <div key={session.id} className="workflow-debug__item">
                    <div className="workflow-debug__item-head">
                      <div>
                        <strong>
                          {session.lead.name ||
                            session.lead.email ||
                            session.lead.phone ||
                            "Onbekende lead"}
                        </strong>
                        <span>
                          Agent: {session.agent.name} • updated {formatDateTime(session.updatedAt)}
                        </span>
                      </div>
                      <span
                        className={`workflow-debug__state ${
                          session.autoReply.ready
                            ? "workflow-debug__state--ok"
                            : "workflow-debug__state--warn"
                        }`}
                      >
                        {session.autoReply.ready ? "Auto-reply klaar" : "Niet klaar"}
                      </span>
                    </div>

                    <div className="workflow-debug__grid">
                      <div className="workflow-debug__cell">
                        <span>Lead</span>
                        <strong>{session.lead.phone || "—"}</strong>
                        <small>{session.lead.email || "geen e-mail"}</small>
                      </div>
                      <div className="workflow-debug__cell">
                        <span>Twilio afzender</span>
                        <strong>{session.twilio.fromPhone || "onbekend"}</strong>
                        <small>Session: {session.id}</small>
                      </div>
                      <div className="workflow-debug__cell">
                        <span>Enrollment</span>
                        <strong>{session.enrollment?.currentNodeType || "—"}</strong>
                        <small>
                          {session.enrollment?.currentNodePaused
                            ? "Paused in wachtstap"
                            : session.enrollment?.status || "geen enrollment"}
                        </small>
                      </div>
                      <div className="workflow-debug__cell">
                        <span>Auto-reply reden</span>
                        <strong>{session.autoReply.reason}</strong>
                        <small>
                          Inbound: {formatDateTime(session.autoReply.lastInboundAt)} • Outbound:{" "}
                          {formatDateTime(session.autoReply.lastOutboundAt)}
                        </small>
                      </div>
                    </div>

                    <div className="workflow-debug__messages">
                      <div className="workflow-debug__message-card">
                        <span>Laatste inbound</span>
                        <p>{session.lastInboundMessage?.body || "Geen inbound bericht gevonden."}</p>
                        <small>{formatDateTime(session.lastInboundMessage?.timestamp)}</small>
                      </div>
                      <div className="workflow-debug__message-card">
                        <span>Laatste outbound</span>
                        <p>{session.lastOutboundMessage?.body || "Geen outbound bericht gevonden."}</p>
                        <small>{formatDateTime(session.lastOutboundMessage?.timestamp)}</small>
                      </div>
                      <div className="workflow-debug__message-card">
                        <span>Laatste AI run</span>
                        <p>
                          {session.lastAgentRun
                            ? `${session.lastAgentRun.source} • ${
                                session.lastAgentRun.model || "model onbekend"
                              }${session.lastAgentRun.responseMs ? ` • ${session.lastAgentRun.responseMs} ms` : ""}`
                            : "Geen AI run gevonden."}
                        </p>
                        <small>
                          {session.lastAgentRun
                            ? `${formatDateTime(session.lastAgentRun.createdAt)}${
                                session.lastAgentRun.handoffRequired
                                  ? ` • handoff: ${session.lastAgentRun.handoffReason || "ja"}`
                                  : ""
                              }`
                            : "—"}
                        </small>
                      </div>
                    </div>

                    <div className="workflow-debug__events">
                      <span className="workflow-debug__events-title">Recente events</span>
                      {session.recentEvents && session.recentEvents.length > 0 ? (
                        <div className="workflow-debug__events-list">
                          {session.recentEvents.map((event) => (
                            <div key={event.id} className="workflow-debug__event-item">
                              <div className="workflow-debug__event-head">
                                <span
                                  className={`workflow-debug__event-level workflow-debug__event-level--${event.level}`}
                                >
                                  {event.level.toUpperCase()}
                                </span>
                                <strong>{event.eventType}</strong>
                                <small>{formatDateTime(event.createdAt)}</small>
                              </div>
                              <p>{event.message}</p>
                              {event.payload ? (
                                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="workflow-debug__events-empty">
                          Nog geen events voor deze sessie.
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </main>

      {testOpen ? (
        <div className="modal modal--workflows">
          <div className="modal__content modal__content--workflows">
            <div className="modal__header">
              <div>
                <h3>Workflow testen</h3>
                <p>
                  Zoek eerst een opportunity op naam, e-mail of telefoon en selecteer die om alle
                  testvelden automatisch in te vullen.
                </p>
              </div>
              <button className="button button--ghost" onClick={() => setTestOpen(false)}>
                ✕
              </button>
            </div>

            {testError ? <div className="alert alert--error">{testError}</div> : null}

            <div className="modal__body">
              <div className="workflow-test-search">
                <div className="field">
                  <label>Opportunity / lead zoeken</label>
                  <div className="field-row workflow-test-search__controls">
                    <input
                      className="input"
                      placeholder="Zoek op naam, e-mail of telefoon..."
                      value={opportunityQuery}
                      onChange={(e) => setOpportunityQuery(e.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void searchOpportunities();
                        }
                      }}
                    />
                    <button
                      className="button button--ghost"
                      onClick={() => void searchOpportunities()}
                      disabled={opportunityLoading}
                    >
                      {opportunityLoading ? "Zoeken..." : "Zoek"}
                    </button>
                  </div>
                  <p className="workflow-settings__hint">
                    Tip: zoek jezelf op en klik op selecteren om direct bij jezelf te testen.
                  </p>
                </div>

                {opportunityError ? (
                  <div className="workflow-test-search__feedback">{opportunityError}</div>
                ) : null}

                {opportunityResults.length > 0 ? (
                  <div className="workflow-test-results">
                    {opportunityResults.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`workflow-test-result ${
                          selectedOpportunityId === item.id ? "workflow-test-result--active" : ""
                        }`}
                        onClick={() => selectOpportunityForTest(item)}
                      >
                        <div className="workflow-test-result__main">
                          <strong>{toOpportunityDisplayName(item)}</strong>
                          <span>
                            {item.contactEmail || "geen e-mail"} • {item.contactPhone || "geen telefoon"}
                          </span>
                          <span>Stage: {item.pipelineStageName?.trim() || "Geen stage"}</span>
                        </div>
                        <span className="workflow-test-result__cta">Selecteer</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="field">
                <label>Email override (optioneel)</label>
                <input className="input" value={emailOverride} onChange={(e) => setEmailOverride(e.target.value)} />
              </div>
              <div className="field">
                <label>SMS override (optioneel)</label>
                <input className="input" value={smsOverride} onChange={(e) => setSmsOverride(e.target.value)} />
              </div>
              <div className="field">
                <label>Lead naam (voor Agent module)</label>
                <input className="input" value={leadName} onChange={(e) => setLeadName(e.target.value)} />
              </div>
              <div className="field">
                <label>Lead email (optioneel)</label>
                <input className="input" value={leadEmail} onChange={(e) => setLeadEmail(e.target.value)} />
              </div>
              <div className="field">
                <label>Lead telefoon (optioneel)</label>
                <input className="input" value={leadPhone} onChange={(e) => setLeadPhone(e.target.value)} />
              </div>
              <div className="field">
                <label>Lead contactId (optioneel)</label>
                <input className="input" value={leadContactId} onChange={(e) => setLeadContactId(e.target.value)} />
              </div>
              <div className="field">
                <label>Lead conversationId (optioneel)</label>
                <input
                  className="input"
                  value={leadConversationId}
                  onChange={(e) => setLeadConversationId(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Lead kanaal</label>
                <select
                  className="input"
                  value={leadChannel}
                  onChange={(e) => setLeadChannel(e.target.value as "SMS" | "EMAIL")}
                >
                  <option value="SMS">SMS</option>
                  <option value="EMAIL">EMAIL</option>
                </select>
              </div>
              <div className="field">
                <label>Laatste lead bericht (Agent context)</label>
                <textarea
                  className="textarea"
                  value={leadLastMessage}
                  onChange={(e) => setLeadLastMessage(e.target.value)}
                />
              </div>

              <div className="modal__actions">
                <button className="button" onClick={runTest} disabled={testLoading || !workflowId}>
                  {testLoading ? "Testen..." : "Start test"}
                </button>
              </div>

              {testReport ? (
                <div className="wf-report">
                  <h4>Resultaat</h4>
                  <div className="wf-report__meta">
                    <span>Execution: {String(testReport.executionId)}</span>
                    <span className={testReport.status === "success" ? "ok" : "bad"}>
                      {String(testReport.status)}
                    </span>
                  </div>
                  <div className="wf-report__steps">
                    {(testReport.steps ?? []).map((step: any) => (
                      <div key={String(step.nodeId)} className={`wf-step wf-step--${step.status}`}>
                        <div className="wf-step__title">
                          <strong>{nodeLabel(step.type as WorkflowNodeType)}</strong>
                          <span className="wf-step__status">{String(step.status)}</span>
                        </div>
                        {step.output ? (
                          <pre className="wf-step__output">{JSON.stringify(step.output, null, 2)}</pre>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  {testReport.error ? (
                    <div className="alert alert--error">
                      {String(testReport.error?.message || "Test mislukt.")}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {nodeQueue ? (
        <div className="modal modal--workflows">
          <div className="modal__content modal__content--workflows modal__content--workflow-queue">
            <div className="modal__header">
              <div>
                <h3>{nodeQueue.label}: personen in deze stap</h3>
                <p>
                  Bekijk wie hier zit en push handmatig door naar de volgende stap, of verwijder uit
                  de workflow.
                </p>
              </div>
              <button className="button button--ghost" onClick={() => setNodeQueue(null)}>
                ✕
              </button>
            </div>
            {queueError ? <div className="alert alert--error">{queueError}</div> : null}
            <div className="modal__body">
              {queueEnrollments.length === 0 ? (
                <div className="empty">Er zitten momenteel geen personen in deze stap.</div>
              ) : (
                <div className="workflow-queue-list">
                  {queueEnrollments.map((item) => (
                    <div key={item.id} className="workflow-queue-item">
                      <div className="workflow-queue-item__meta">
                        <strong>
                          {item.leadName || item.leadEmail || item.leadPhone || "Onbekende lead"}
                        </strong>
                        <span>
                          {item.leadEmail || "geen e-mail"} • {item.leadPhone || "geen telefoon"}
                        </span>
                        <span>
                          Laatste update:{" "}
                          {new Date(item.completedAt ?? item.createdAt).toLocaleString("nl-BE")}
                        </span>
                      </div>
                      <div className="workflow-queue-item__actions">
                        <button
                          className="button button--ghost"
                          onClick={() => void advanceEnrollment(item.id)}
                          disabled={queueBusyId === item.id}
                        >
                          {queueBusyId === item.id ? "Pushen..." : "Push naar volgende stap"}
                        </button>
                        <button
                          className="button button--ghost button--danger"
                          onClick={() => void removeEnrollment(item.id)}
                          disabled={queueBusyId === item.id}
                        >
                          Verwijder uit workflow
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default WorkflowBuilder;
