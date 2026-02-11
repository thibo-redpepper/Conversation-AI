import crypto from "crypto";
import { getSupabaseClient } from "../supabase/client.js";
import type { WorkflowDefinition, WorkflowRecord, WorkflowStatus } from "./types.js";
import { normalizePhoneDigits, phoneLast10 } from "../shared/phone.js";

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  definition: WorkflowDefinition;
  created_at: string;
  updated_at: string;
};

type WorkflowEnrollmentRow = {
  id: string;
  workflow_id: string;
  location_id: string | null;
  source: string;
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  status: "success" | "failed";
  started_at: string;
  completed_at: string;
  created_at: string;
};

type WorkflowEnrollmentStepRow = {
  id: string;
  enrollment_id: string;
  node_id: string;
  node_type: string;
  status: "success" | "failed";
  output: Record<string, unknown> | null;
  created_at: string;
};

type WorkflowAgentSessionRow = {
  id: string;
  workflow_id: string;
  enrollment_id: string | null;
  location_id: string | null;
  agent_id: string;
  channel: "SMS" | "EMAIL";
  lead_name: string | null;
  lead_email: string | null;
  lead_email_norm: string | null;
  lead_phone: string | null;
  lead_phone_norm: string | null;
  lead_phone_last10: string | null;
  ghl_contact_id: string | null;
  ghl_conversation_id: string | null;
  twilio_to_phone: string | null;
  twilio_to_phone_norm: string | null;
  twilio_to_phone_last10: string | null;
  active: boolean;
  activated_at: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_message_id: string | null;
  last_outbound_message_id: string | null;
  follow_up_step: number | null;
  next_follow_up_at: string | null;
  last_follow_up_at: string | null;
  created_at: string;
  updated_at: string;
};

type WorkflowAgentEventRow = {
  id: string;
  workflow_id: string;
  session_id: string | null;
  enrollment_id: string | null;
  event_type: string;
  level: "info" | "warn" | "error";
  message: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

const toRecord = (row: WorkflowRow): WorkflowRecord => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  definition: row.definition,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapWorkflowRepoError = (error: unknown) => {
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const message = String((error as { message: string }).message);
    if (
      message.includes('relation "public.workflows" does not exist') ||
      message.includes('relation "workflows" does not exist') ||
      message.includes('relation "public.workflow_enrollments" does not exist') ||
      message.includes('relation "workflow_enrollments" does not exist') ||
      message.includes('relation "public.workflow_enrollment_steps" does not exist') ||
      message.includes('relation "workflow_enrollment_steps" does not exist') ||
      message.includes('relation "public.workflow_agent_sessions" does not exist') ||
      message.includes('relation "workflow_agent_sessions" does not exist') ||
      message.includes('relation "public.workflow_agent_events" does not exist') ||
      message.includes('relation "workflow_agent_events" does not exist')
    ) {
      return new Error(
        "Workflow storage is not initialized. Run SQL in `server/supabase/workflows.sql` in Supabase SQL Editor, then refresh."
      );
    }
    if (
      message.includes('column "follow_up_step"') ||
      message.includes('column "next_follow_up_at"') ||
      message.includes('column "last_follow_up_at"') ||
      message.includes("follow_up_step does not exist") ||
      message.includes("next_follow_up_at does not exist") ||
      message.includes("last_follow_up_at does not exist")
    ) {
      return new Error(
        "Workflow schema mist follow-up kolommen. Run `server/supabase/workflows.sql` opnieuw in Supabase SQL Editor en herstart de server."
      );
    }
    return new Error(message);
  }
  if (typeof error === "string" && error.trim()) {
    return new Error(error.trim());
  }
  return error;
};

export const listWorkflows = async (): Promise<
  { id: string; name: string; status: WorkflowStatus; updatedAt: string }[]
> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { data, error } = await supabase
      .from("workflows")
      .select("id, name, status, updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row: any) => ({
      id: String(row.id),
      name: String(row.name),
      status: row.status as WorkflowStatus,
      updatedAt: String(row.updated_at),
    }));
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const getWorkflow = async (id: string): Promise<WorkflowRecord | null> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { data, error } = await supabase
      .from("workflows")
      .select("id, name, description, status, definition, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return toRecord(data as WorkflowRow);
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const createWorkflow = async (input: {
  name: string;
  description?: string | null;
  status: WorkflowStatus;
  definition: WorkflowDefinition;
}): Promise<WorkflowRecord> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const { data, error } = await supabase
      .from("workflows")
      .insert({
        id,
        name: input.name,
        description: input.description ?? null,
        status: input.status,
        definition: input.definition,
        created_at: now,
        updated_at: now,
      })
      .select("id, name, description, status, definition, created_at, updated_at")
      .single();
    if (error) throw error;
    return toRecord(data as WorkflowRow);
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const updateWorkflow = async (
  id: string,
  input: {
    name: string;
    description?: string | null;
    status: WorkflowStatus;
    definition: WorkflowDefinition;
  }
): Promise<WorkflowRecord | null> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("workflows")
      .update({
        name: input.name,
        description: input.description ?? null,
        status: input.status,
        definition: input.definition,
        updated_at: now,
      })
      .eq("id", id)
      .select("id, name, description, status, definition, created_at, updated_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return toRecord(data as WorkflowRow);
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const deleteWorkflow = async (id: string): Promise<boolean> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { error, count } = await supabase
      .from("workflows")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw error;
    return (count ?? 0) > 0;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export type WorkflowEnrollmentStepRecord = {
  id: string;
  nodeId: string;
  nodeType: string;
  status: "success" | "failed";
  output?: Record<string, unknown>;
  createdAt: string;
};

export type WorkflowEnrollmentRecord = {
  id: string;
  workflowId: string;
  locationId?: string | null;
  source: string;
  leadName?: string | null;
  leadEmail?: string | null;
  leadPhone?: string | null;
  status: "success" | "failed";
  startedAt: string;
  completedAt: string;
  createdAt: string;
  steps: WorkflowEnrollmentStepRecord[];
};

export type WorkflowAgentSessionRecord = {
  id: string;
  workflowId: string;
  enrollmentId?: string | null;
  locationId?: string | null;
  agentId: string;
  channel: "SMS" | "EMAIL";
  leadName?: string | null;
  leadEmail?: string | null;
  leadEmailNorm?: string | null;
  leadPhone?: string | null;
  leadPhoneNorm?: string | null;
  leadPhoneLast10?: string | null;
  ghlContactId?: string | null;
  ghlConversationId?: string | null;
  twilioToPhone?: string | null;
  twilioToPhoneNorm?: string | null;
  twilioToPhoneLast10?: string | null;
  active: boolean;
  activatedAt: string;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  lastInboundMessageId?: string | null;
  lastOutboundMessageId?: string | null;
  followUpStep: number;
  nextFollowUpAt?: string | null;
  lastFollowUpAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowAgentEventRecord = {
  id: string;
  workflowId: string;
  sessionId?: string | null;
  enrollmentId?: string | null;
  eventType: string;
  level: "info" | "warn" | "error";
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
};

const mapEnrollmentRowToRecord = (
  row: WorkflowEnrollmentRow,
  steps: WorkflowEnrollmentStepRecord[]
): WorkflowEnrollmentRecord => ({
  id: row.id,
  workflowId: row.workflow_id,
  locationId: row.location_id,
  source: row.source,
  leadName: row.lead_name,
  leadEmail: row.lead_email,
  leadPhone: row.lead_phone,
  status: row.status,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  createdAt: row.created_at,
  steps,
});

const mapWorkflowAgentSessionRowToRecord = (
  row: WorkflowAgentSessionRow
): WorkflowAgentSessionRecord => ({
  id: row.id,
  workflowId: row.workflow_id,
  enrollmentId: row.enrollment_id,
  locationId: row.location_id,
  agentId: row.agent_id,
  channel: row.channel === "EMAIL" ? "EMAIL" : "SMS",
  leadName: row.lead_name,
  leadEmail: row.lead_email,
  leadEmailNorm: row.lead_email_norm,
  leadPhone: row.lead_phone,
  leadPhoneNorm: row.lead_phone_norm,
  leadPhoneLast10: row.lead_phone_last10,
  ghlContactId: row.ghl_contact_id,
  ghlConversationId: row.ghl_conversation_id,
  twilioToPhone: row.twilio_to_phone,
  twilioToPhoneNorm: row.twilio_to_phone_norm,
  twilioToPhoneLast10: row.twilio_to_phone_last10,
  active: row.active,
  activatedAt: row.activated_at,
  lastInboundAt: row.last_inbound_at,
  lastOutboundAt: row.last_outbound_at,
  lastInboundMessageId: row.last_inbound_message_id,
  lastOutboundMessageId: row.last_outbound_message_id,
  followUpStep:
    Number.isFinite(Number(row.follow_up_step)) && Number(row.follow_up_step) >= 0
      ? Math.floor(Number(row.follow_up_step))
      : 0,
  nextFollowUpAt: row.next_follow_up_at,
  lastFollowUpAt: row.last_follow_up_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapWorkflowAgentEventRowToRecord = (
  row: WorkflowAgentEventRow
): WorkflowAgentEventRecord => ({
  id: row.id,
  workflowId: row.workflow_id,
  sessionId: row.session_id,
  enrollmentId: row.enrollment_id,
  eventType: row.event_type,
  level: row.level,
  message: row.message,
  payload: row.payload ?? undefined,
  createdAt: row.created_at,
});

const WORKFLOW_AGENT_SESSION_SELECT =
  "id, workflow_id, enrollment_id, location_id, agent_id, channel, lead_name, lead_email, lead_email_norm, lead_phone, lead_phone_norm, lead_phone_last10, ghl_contact_id, ghl_conversation_id, twilio_to_phone, twilio_to_phone_norm, twilio_to_phone_last10, active, activated_at, last_inbound_at, last_outbound_at, last_inbound_message_id, last_outbound_message_id, follow_up_step, next_follow_up_at, last_follow_up_at, created_at, updated_at";

export const recordWorkflowEnrollmentExecution = async (input: {
  workflowId: string;
  locationId?: string;
  source?: string;
  lead?: { name?: string; email?: string; phone?: string };
  status: "success" | "failed";
  startedAt?: string;
  completedAt?: string;
  steps: Array<{
    nodeId: string;
    nodeType: string;
    status: "success" | "failed";
    output?: Record<string, unknown>;
  }>;
}): Promise<string> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const enrollmentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const startedAt = input.startedAt ?? now;
    const completedAt = input.completedAt ?? now;
    const { error: enrollmentError } = await supabase.from("workflow_enrollments").insert({
      id: enrollmentId,
      workflow_id: input.workflowId,
      location_id: input.locationId ?? null,
      source: input.source ?? "manual_test",
      lead_name: input.lead?.name?.trim() || null,
      lead_email: input.lead?.email?.trim().toLowerCase() || null,
      lead_phone: input.lead?.phone?.trim() || null,
      status: input.status,
      started_at: startedAt,
      completed_at: completedAt,
      created_at: now,
    });
    if (enrollmentError) throw enrollmentError;

    if (input.steps.length > 0) {
      const { error: stepsError } = await supabase.from("workflow_enrollment_steps").insert(
        input.steps.map((step) => ({
          id: crypto.randomUUID(),
          enrollment_id: enrollmentId,
          node_id: step.nodeId,
          node_type: step.nodeType,
          status: step.status,
          output: step.output ?? null,
          created_at: now,
        }))
      );
      if (stepsError) throw stepsError;
    }
    return enrollmentId;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const listWorkflowEnrollments = async (workflowId: string, limit = 50) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { data: enrollments, error: enrollmentsError } = await supabase
      .from("workflow_enrollments")
      .select(
        "id, workflow_id, location_id, source, lead_name, lead_email, lead_phone, status, started_at, completed_at, created_at"
      )
      .eq("workflow_id", workflowId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (enrollmentsError) throw enrollmentsError;

    const enrollmentRows = (enrollments ?? []) as WorkflowEnrollmentRow[];
    if (enrollmentRows.length === 0) return [] as WorkflowEnrollmentRecord[];
    const ids = enrollmentRows.map((row) => row.id);

    const { data: steps, error: stepsError } = await supabase
      .from("workflow_enrollment_steps")
      .select("id, enrollment_id, node_id, node_type, status, output, created_at")
      .in("enrollment_id", ids)
      .order("created_at", { ascending: true });
    if (stepsError) throw stepsError;

    const grouped = new Map<string, WorkflowEnrollmentStepRecord[]>();
    ((steps ?? []) as WorkflowEnrollmentStepRow[]).forEach((row) => {
      const list = grouped.get(row.enrollment_id) ?? [];
      list.push({
        id: row.id,
        nodeId: row.node_id,
        nodeType: row.node_type,
        status: row.status,
        output: row.output ?? undefined,
        createdAt: row.created_at,
      });
      grouped.set(row.enrollment_id, list);
    });

    return enrollmentRows.map((row) =>
      mapEnrollmentRowToRecord(row, grouped.get(row.id) ?? [])
    );
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const getWorkflowEnrollment = async (
  workflowId: string,
  enrollmentId: string
): Promise<WorkflowEnrollmentRecord | null> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { data: enrollment, error: enrollmentError } = await supabase
      .from("workflow_enrollments")
      .select(
        "id, workflow_id, location_id, source, lead_name, lead_email, lead_phone, status, started_at, completed_at, created_at"
      )
      .eq("workflow_id", workflowId)
      .eq("id", enrollmentId)
      .maybeSingle();
    if (enrollmentError) throw enrollmentError;
    if (!enrollment) return null;

    const { data: steps, error: stepsError } = await supabase
      .from("workflow_enrollment_steps")
      .select("id, enrollment_id, node_id, node_type, status, output, created_at")
      .eq("enrollment_id", enrollmentId)
      .order("created_at", { ascending: true });
    if (stepsError) throw stepsError;
    const mappedSteps = ((steps ?? []) as WorkflowEnrollmentStepRow[]).map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      nodeType: row.node_type,
      status: row.status,
      output: row.output ?? undefined,
      createdAt: row.created_at,
    }));
    return mapEnrollmentRowToRecord(enrollment as WorkflowEnrollmentRow, mappedSteps);
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const appendWorkflowEnrollmentSteps = async (
  enrollmentId: string,
  steps: Array<{
    nodeId: string;
    nodeType: string;
    status: "success" | "failed";
    output?: Record<string, unknown>;
  }>
) => {
  if (steps.length === 0) return;
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const now = Date.now();
    const { error } = await supabase.from("workflow_enrollment_steps").insert(
      steps.map((step, index) => ({
        id: crypto.randomUUID(),
        enrollment_id: enrollmentId,
        node_id: step.nodeId,
        node_type: step.nodeType,
        status: step.status,
        output: step.output ?? null,
        created_at: new Date(now + index).toISOString(),
      }))
    );
    if (error) throw error;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const updateWorkflowEnrollmentStatus = async (
  workflowId: string,
  enrollmentId: string,
  status: "success" | "failed",
  completedAt = new Date().toISOString()
) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { error } = await supabase
      .from("workflow_enrollments")
      .update({ status, completed_at: completedAt })
      .eq("workflow_id", workflowId)
      .eq("id", enrollmentId);
    if (error) throw error;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const deleteWorkflowEnrollment = async (
  workflowId: string,
  enrollmentId: string
): Promise<boolean> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { error, count } = await supabase
      .from("workflow_enrollments")
      .delete({ count: "exact" })
      .eq("workflow_id", workflowId)
      .eq("id", enrollmentId);
    if (error) throw error;
    return (count ?? 0) > 0;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const upsertWorkflowAgentSession = async (input: {
  workflowId: string;
  enrollmentId?: string;
  locationId?: string;
  agentId: string;
  channel?: "SMS" | "EMAIL";
  leadName?: string;
  leadEmail?: string;
  leadPhone?: string;
  ghlContactId?: string;
  ghlConversationId?: string;
  twilioToPhone?: string;
  activatedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastInboundMessageId?: string;
  lastOutboundMessageId?: string;
  followUpStep?: number;
  nextFollowUpAt?: string | null;
  lastFollowUpAt?: string | null;
}) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const channel = input.channel === "EMAIL" ? "EMAIL" : "SMS";
    const leadPhoneNorm = normalizePhoneDigits(input.leadPhone);
    const leadEmailNorm = input.leadEmail?.trim().toLowerCase() || undefined;
    if (channel === "SMS" && !leadPhoneNorm) {
      throw new Error("Lead telefoon ontbreekt of is ongeldig voor SMS sessie.");
    }
    if (channel === "EMAIL" && !leadEmailNorm && !input.ghlContactId?.trim()) {
      throw new Error(
        "Lead email of GHL contactId ontbreekt voor email sessie."
      );
    }
    const twilioToPhoneNorm = normalizePhoneDigits(input.twilioToPhone);
    const now = new Date().toISOString();
    const activatedAt = input.activatedAt ?? now;
    const lastInboundAt = input.lastInboundAt ?? null;
    const lastOutboundAt = input.lastOutboundAt ?? now;
    const followUpStep =
      Number.isFinite(Number(input.followUpStep)) && Number(input.followUpStep) >= 0
        ? Math.floor(Number(input.followUpStep))
        : 0;
    const leadPhoneLast10 = phoneLast10(leadPhoneNorm);
    const twilioToPhoneLast10 = phoneLast10(twilioToPhoneNorm);

    let candidatesQuery = supabase
      .from("workflow_agent_sessions")
      .select(WORKFLOW_AGENT_SESSION_SELECT)
      .eq("workflow_id", input.workflowId)
      .eq("agent_id", input.agentId)
      .eq("channel", channel)
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(10);
    if (channel === "SMS") {
      candidatesQuery = candidatesQuery.eq("lead_phone_norm", leadPhoneNorm ?? "__missing__");
    } else {
      candidatesQuery = candidatesQuery.eq("lead_email_norm", leadEmailNorm ?? "__missing__");
    }
    const { data: candidates, error: candidatesError } = await candidatesQuery;
    if (candidatesError) throw candidatesError;
    const existing = ((candidates ?? []) as WorkflowAgentSessionRow[]).find((row) => {
      if (channel === "EMAIL") {
        return true;
      }
      if (!twilioToPhoneNorm) {
        return !row.twilio_to_phone_norm;
      }
      return row.twilio_to_phone_norm === twilioToPhoneNorm;
    });

    if (existing) {
      const { data: updated, error: updateError } = await supabase
        .from("workflow_agent_sessions")
        .update({
          enrollment_id: input.enrollmentId ?? existing.enrollment_id,
          location_id: input.locationId ?? existing.location_id,
          channel,
          lead_name: input.leadName?.trim() || existing.lead_name,
          lead_email: leadEmailNorm ?? existing.lead_email,
          lead_email_norm: leadEmailNorm ?? existing.lead_email_norm,
          lead_phone:
            channel === "SMS"
              ? input.leadPhone?.trim() || existing.lead_phone
              : input.leadPhone?.trim() || existing.lead_phone,
          lead_phone_norm:
            channel === "SMS"
              ? leadPhoneNorm ?? existing.lead_phone_norm
              : leadPhoneNorm ?? existing.lead_phone_norm,
          lead_phone_last10:
            channel === "SMS"
              ? leadPhoneLast10 ?? existing.lead_phone_last10
              : leadPhoneLast10 ?? existing.lead_phone_last10,
          ghl_contact_id: input.ghlContactId?.trim() || existing.ghl_contact_id,
          ghl_conversation_id:
            input.ghlConversationId?.trim() || existing.ghl_conversation_id,
          twilio_to_phone:
            channel === "SMS" ? input.twilioToPhone?.trim() || null : null,
          twilio_to_phone_norm:
            channel === "SMS" ? twilioToPhoneNorm ?? null : null,
          twilio_to_phone_last10:
            channel === "SMS" ? twilioToPhoneLast10 ?? null : null,
          active: true,
          activated_at: activatedAt,
          last_inbound_at: lastInboundAt ?? existing.last_inbound_at,
          last_outbound_at: lastOutboundAt,
          last_inbound_message_id:
            input.lastInboundMessageId?.trim() || existing.last_inbound_message_id,
          last_outbound_message_id:
            input.lastOutboundMessageId?.trim() || existing.last_outbound_message_id,
          follow_up_step:
            input.followUpStep === undefined
              ? existing.follow_up_step ?? 0
              : followUpStep,
          ...(input.nextFollowUpAt !== undefined
            ? { next_follow_up_at: input.nextFollowUpAt }
            : {}),
          ...(input.lastFollowUpAt !== undefined
            ? { last_follow_up_at: input.lastFollowUpAt }
            : {}),
          updated_at: now,
        })
        .eq("id", existing.id)
        .select(WORKFLOW_AGENT_SESSION_SELECT)
        .single();
      if (updateError) throw updateError;
      return mapWorkflowAgentSessionRowToRecord(updated as WorkflowAgentSessionRow);
    }

    const id = crypto.randomUUID();
    const { data: inserted, error: insertError } = await supabase
      .from("workflow_agent_sessions")
      .insert({
        id,
        workflow_id: input.workflowId,
        enrollment_id: input.enrollmentId ?? null,
        location_id: input.locationId ?? null,
        agent_id: input.agentId,
        channel,
        lead_name: input.leadName?.trim() || null,
        lead_email: leadEmailNorm ?? null,
        lead_email_norm: leadEmailNorm ?? null,
        lead_phone: input.leadPhone?.trim() || null,
        lead_phone_norm: leadPhoneNorm ?? null,
        lead_phone_last10: leadPhoneLast10 ?? null,
        ghl_contact_id: input.ghlContactId?.trim() || null,
        ghl_conversation_id: input.ghlConversationId?.trim() || null,
        twilio_to_phone: channel === "SMS" ? input.twilioToPhone?.trim() || null : null,
        twilio_to_phone_norm: channel === "SMS" ? twilioToPhoneNorm ?? null : null,
        twilio_to_phone_last10: channel === "SMS" ? twilioToPhoneLast10 ?? null : null,
        active: true,
        activated_at: activatedAt,
        last_inbound_at: lastInboundAt,
        last_outbound_at: lastOutboundAt,
        last_inbound_message_id: input.lastInboundMessageId?.trim() || null,
        last_outbound_message_id: input.lastOutboundMessageId?.trim() || null,
        follow_up_step: followUpStep,
        next_follow_up_at: input.nextFollowUpAt ?? null,
        last_follow_up_at: input.lastFollowUpAt ?? null,
        created_at: now,
        updated_at: now,
      })
      .select(WORKFLOW_AGENT_SESSION_SELECT)
      .single();
    if (insertError) throw insertError;
    return mapWorkflowAgentSessionRowToRecord(inserted as WorkflowAgentSessionRow);
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const findActiveWorkflowAgentSessionForInbound = async (input: {
  fromPhone: string;
  toPhone?: string;
}) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const fromNorm = normalizePhoneDigits(input.fromPhone);
    if (!fromNorm) return null;
    const fromLast10 = phoneLast10(fromNorm);
    const toNorm = normalizePhoneDigits(input.toPhone);
    const toLast10 = phoneLast10(toNorm);

    const matchConditions = [
      `lead_phone_norm.eq.${fromNorm}`,
      fromLast10 ? `lead_phone_last10.eq.${fromLast10}` : undefined,
    ]
      .filter(Boolean)
      .join(",");

    const { data, error } = await supabase
      .from("workflow_agent_sessions")
      .select(WORKFLOW_AGENT_SESSION_SELECT)
      .eq("active", true)
      .eq("channel", "SMS")
      .or(matchConditions)
      .order("updated_at", { ascending: false })
      .limit(25);
    if (error) throw error;

    const rows = (data ?? []) as WorkflowAgentSessionRow[];
    const matched = rows.find((row) => {
      if (!toNorm) return true;
      if (!row.twilio_to_phone_norm && !row.twilio_to_phone_last10) return true;
      if (row.twilio_to_phone_norm && row.twilio_to_phone_norm === toNorm) return true;
      if (row.twilio_to_phone_last10 && toLast10 && row.twilio_to_phone_last10 === toLast10)
        return true;
      return false;
    });
    if (matched) return mapWorkflowAgentSessionRowToRecord(matched);
    // Fallback for providers/messaging-service cases where the receiving number can vary.
    return rows[0] ? mapWorkflowAgentSessionRowToRecord(rows[0]) : null;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const listWorkflowAgentSessions = async (
  workflowId: string,
  limit = 100
): Promise<WorkflowAgentSessionRecord[]> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { data, error } = await supabase
      .from("workflow_agent_sessions")
      .select(WORKFLOW_AGENT_SESSION_SELECT)
      .eq("workflow_id", workflowId)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as WorkflowAgentSessionRow[]).map((row) =>
      mapWorkflowAgentSessionRowToRecord(row)
    );
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const listActiveWorkflowAgentSessions = async (
  limit = 200
): Promise<WorkflowAgentSessionRecord[]> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { data, error } = await supabase
      .from("workflow_agent_sessions")
      .select(WORKFLOW_AGENT_SESSION_SELECT)
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as WorkflowAgentSessionRow[]).map((row) =>
      mapWorkflowAgentSessionRowToRecord(row)
    );
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const listWorkflowAgentSessionsDueForFollowUp = async (input?: {
  dueBefore?: string;
  limit?: number;
}): Promise<WorkflowAgentSessionRecord[]> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const dueBefore = input?.dueBefore ?? new Date().toISOString();
    const limit = Number.isFinite(Number(input?.limit))
      ? Math.max(1, Math.min(500, Math.floor(Number(input?.limit))))
      : 200;
    const { data, error } = await supabase
      .from("workflow_agent_sessions")
      .select(WORKFLOW_AGENT_SESSION_SELECT)
      .eq("active", true)
      .not("next_follow_up_at", "is", null)
      .lte("next_follow_up_at", dueBefore)
      .order("next_follow_up_at", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return ((data ?? []) as WorkflowAgentSessionRow[]).map((row) =>
      mapWorkflowAgentSessionRowToRecord(row)
    );
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const updateWorkflowAgentSessionFollowUpState = async (
  sessionId: string,
  patch: {
    followUpStep?: number;
    nextFollowUpAt?: string | null;
    lastFollowUpAt?: string | null;
  }
) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.followUpStep !== undefined) {
      const safeStep =
        Number.isFinite(Number(patch.followUpStep)) && Number(patch.followUpStep) >= 0
          ? Math.floor(Number(patch.followUpStep))
          : 0;
      updates["follow_up_step"] = safeStep;
    }
    if (patch.nextFollowUpAt !== undefined) {
      updates["next_follow_up_at"] = patch.nextFollowUpAt;
    }
    if (patch.lastFollowUpAt !== undefined) {
      updates["last_follow_up_at"] = patch.lastFollowUpAt;
    }
    const { error } = await supabase
      .from("workflow_agent_sessions")
      .update(updates)
      .eq("id", sessionId);
    if (error) throw error;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const recordWorkflowAgentEvent = async (input: {
  workflowId: string;
  sessionId?: string;
  enrollmentId?: string;
  eventType: string;
  level?: "info" | "warn" | "error";
  message: string;
  payload?: Record<string, unknown>;
}) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { error } = await supabase.from("workflow_agent_events").insert({
      id: crypto.randomUUID(),
      workflow_id: input.workflowId,
      session_id: input.sessionId ?? null,
      enrollment_id: input.enrollmentId ?? null,
      event_type: input.eventType,
      level: input.level ?? "info",
      message: input.message,
      payload: input.payload ?? null,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const listWorkflowAgentEvents = async (input: {
  workflowId: string;
  sessionId?: string;
  limit?: number;
}): Promise<WorkflowAgentEventRecord[]> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    let query = supabase
      .from("workflow_agent_events")
      .select(
        "id, workflow_id, session_id, enrollment_id, event_type, level, message, payload, created_at"
      )
      .eq("workflow_id", input.workflowId)
      .order("created_at", { ascending: false })
      .limit(input.limit ?? 300);
    if (input.sessionId) {
      query = query.eq("session_id", input.sessionId);
    }
    const { data, error } = await query;
    if (error) throw error;
    return ((data ?? []) as WorkflowAgentEventRow[]).map((row) =>
      mapWorkflowAgentEventRowToRecord(row)
    );
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const touchWorkflowAgentSessionInbound = async (
  sessionId: string,
  inboundAt = new Date().toISOString(),
  messageId?: string
) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { error } = await supabase
      .from("workflow_agent_sessions")
      .update({
        last_inbound_at: inboundAt,
        ...(messageId ? { last_inbound_message_id: messageId } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
    if (error) throw error;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const touchWorkflowAgentSessionOutbound = async (
  sessionId: string,
  outboundAt = new Date().toISOString(),
  messageId?: string
) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { error } = await supabase
      .from("workflow_agent_sessions")
      .update({
        last_outbound_at: outboundAt,
        ...(messageId ? { last_outbound_message_id: messageId } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId);
    if (error) throw error;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};

export const deactivateWorkflowAgentSessionsByEnrollment = async (
  workflowId: string,
  enrollmentId: string
) => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured.");
  try {
    const { error } = await supabase
      .from("workflow_agent_sessions")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("workflow_id", workflowId)
      .eq("enrollment_id", enrollmentId)
      .eq("active", true);
    if (error) throw error;
  } catch (error) {
    throw mapWorkflowRepoError(error);
  }
};
