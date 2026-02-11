-- Create table used by /api/workflows endpoints.
-- Run this in your Supabase SQL editor.

create table if not exists public.workflows (
  id uuid primary key,
  name text not null,
  description text,
  status text not null check (status in ('draft', 'active', 'inactive')),
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflows_updated_at_idx on public.workflows (updated_at desc);

-- Enrollment history for workflow runs/tests.
create table if not exists public.workflow_enrollments (
  id uuid primary key,
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  location_id text,
  source text not null default 'manual_test',
  lead_name text,
  lead_email text,
  lead_phone text,
  status text not null check (status in ('success', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists workflow_enrollments_workflow_created_idx
  on public.workflow_enrollments (workflow_id, created_at desc);

create index if not exists workflow_enrollments_location_created_idx
  on public.workflow_enrollments (location_id, created_at desc);

create table if not exists public.workflow_enrollment_steps (
  id uuid primary key,
  enrollment_id uuid not null references public.workflow_enrollments (id) on delete cascade,
  node_id text not null,
  node_type text not null,
  status text not null check (status in ('success', 'failed')),
  output jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workflow_enrollment_steps_enrollment_idx
  on public.workflow_enrollment_steps (enrollment_id, created_at asc);

-- Active AI agent sessions started from workflow automation (used for inbound auto-replies).
create table if not exists public.workflow_agent_sessions (
  id uuid primary key,
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  enrollment_id uuid references public.workflow_enrollments (id) on delete set null,
  location_id text,
  agent_id text not null,
  channel text not null default 'SMS' check (channel in ('SMS', 'EMAIL')),
  lead_name text,
  lead_email text,
  lead_email_norm text,
  lead_phone text,
  lead_phone_norm text,
  lead_phone_last10 text,
  ghl_contact_id text,
  ghl_conversation_id text,
  twilio_to_phone text,
  twilio_to_phone_norm text,
  twilio_to_phone_last10 text,
  active boolean not null default true,
  activated_at timestamptz not null default now(),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_inbound_message_id text,
  last_outbound_message_id text,
  follow_up_step integer not null default 0,
  next_follow_up_at timestamptz,
  last_follow_up_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Backward compatible upgrades for existing installs.
alter table public.workflow_agent_sessions
  add column if not exists channel text;
update public.workflow_agent_sessions set channel = 'SMS' where channel is null;
alter table public.workflow_agent_sessions
  alter column channel set default 'SMS';
alter table public.workflow_agent_sessions
  alter column channel set not null;
alter table public.workflow_agent_sessions
  drop constraint if exists workflow_agent_sessions_channel_check;
alter table public.workflow_agent_sessions
  add constraint workflow_agent_sessions_channel_check check (channel in ('SMS', 'EMAIL'));

alter table public.workflow_agent_sessions
  add column if not exists lead_email_norm text;
update public.workflow_agent_sessions
set lead_email_norm = lower(trim(lead_email))
where lead_email is not null
  and lead_email_norm is null;

alter table public.workflow_agent_sessions
  alter column lead_phone drop not null;
alter table public.workflow_agent_sessions
  alter column lead_phone_norm drop not null;

alter table public.workflow_agent_sessions
  add column if not exists ghl_contact_id text;
alter table public.workflow_agent_sessions
  add column if not exists ghl_conversation_id text;
alter table public.workflow_agent_sessions
  add column if not exists last_inbound_message_id text;
alter table public.workflow_agent_sessions
  add column if not exists last_outbound_message_id text;
alter table public.workflow_agent_sessions
  add column if not exists follow_up_step integer;
update public.workflow_agent_sessions
set follow_up_step = 0
where follow_up_step is null;
alter table public.workflow_agent_sessions
  alter column follow_up_step set default 0;
alter table public.workflow_agent_sessions
  alter column follow_up_step set not null;
alter table public.workflow_agent_sessions
  add column if not exists next_follow_up_at timestamptz;
alter table public.workflow_agent_sessions
  add column if not exists last_follow_up_at timestamptz;

create index if not exists workflow_agent_sessions_lead_norm_idx
  on public.workflow_agent_sessions (active, lead_phone_norm, updated_at desc);

create index if not exists workflow_agent_sessions_lead_last10_idx
  on public.workflow_agent_sessions (active, lead_phone_last10, updated_at desc);

create index if not exists workflow_agent_sessions_workflow_idx
  on public.workflow_agent_sessions (workflow_id, created_at desc);

create index if not exists workflow_agent_sessions_email_idx
  on public.workflow_agent_sessions (active, channel, lead_email_norm, updated_at desc);

create index if not exists workflow_agent_sessions_ghl_contact_idx
  on public.workflow_agent_sessions (active, location_id, ghl_contact_id, updated_at desc);

create index if not exists workflow_agent_sessions_followup_due_idx
  on public.workflow_agent_sessions (active, next_follow_up_at asc);

-- Detailed event log for workflow-driven AI agent behavior.
create table if not exists public.workflow_agent_events (
  id uuid primary key,
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  session_id uuid references public.workflow_agent_sessions (id) on delete cascade,
  enrollment_id uuid references public.workflow_enrollments (id) on delete set null,
  event_type text not null,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  message text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workflow_agent_events_workflow_idx
  on public.workflow_agent_events (workflow_id, created_at desc);

create index if not exists workflow_agent_events_session_idx
  on public.workflow_agent_events (session_id, created_at desc);
