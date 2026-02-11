-- AI Agents storage and observability
-- Run this in Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'inactive', 'archived')),
  active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  current_version integer not null default 1,
  published_version integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_agents_location_idx on public.ai_agents (location_id, updated_at desc);

create table if not exists public.ai_agent_versions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  location_id text not null,
  version integer not null,
  settings jsonb not null,
  change_note text,
  created_at timestamptz not null default now(),
  unique(agent_id, version)
);

create index if not exists ai_agent_versions_agent_idx on public.ai_agent_versions (agent_id, version desc);

create table if not exists public.ai_agent_knowledge (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  location_id text not null,
  source_type text not null check (source_type in ('faq', 'website', 'note', 'file')),
  title text,
  source_url text,
  content text not null,
  content_hash text,
  refresh_interval_hours integer not null default 72,
  last_refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_agent_knowledge_agent_idx on public.ai_agent_knowledge (agent_id, updated_at desc);

create table if not exists public.ai_agent_runs (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  agent_id uuid references public.ai_agents(id) on delete set null,
  source text not null check (source in ('suggest', 'test')),
  conversation_id text,
  contact_id text,
  channel text,
  model text,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  cost_eur numeric,
  response_ms integer,
  prompt_version integer,
  follow_up_limit_reached boolean not null default false,
  handoff_required boolean not null default false,
  handoff_reason text,
  safety_flags jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_agent_runs_location_idx on public.ai_agent_runs (location_id, created_at desc);
create index if not exists ai_agent_runs_agent_idx on public.ai_agent_runs (agent_id, created_at desc);

create table if not exists public.ai_agent_eval_cases (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  title text not null,
  payload jsonb not null,
  expected jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_agent_eval_cases_location_idx on public.ai_agent_eval_cases (location_id, updated_at desc);

create table if not exists public.ai_agent_eval_runs (
  id uuid primary key default gen_random_uuid(),
  location_id text not null,
  agent_id uuid references public.ai_agents(id) on delete set null,
  case_id uuid references public.ai_agent_eval_cases(id) on delete set null,
  passed boolean not null,
  score numeric not null,
  feedback text,
  output text,
  created_at timestamptz not null default now()
);

create index if not exists ai_agent_eval_runs_location_idx on public.ai_agent_eval_runs (location_id, created_at desc);
