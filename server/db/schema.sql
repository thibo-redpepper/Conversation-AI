-- LeadPilot (Supabase) schema
-- Run these in Supabase SQL editor

create table if not exists accounts (
  id text primary key,
  name text not null,
  created_at timestamptz default now()
);

create table if not exists conversations (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  contact_id text,
  last_message_date timestamptz,
  last_message_body text,
  last_message_direction text,
  last_message_type text,
  updated_at timestamptz,
  metadata jsonb,
  created_at timestamptz default now()
);

create table if not exists messages (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  conversation_id text not null references conversations(id) on delete cascade,
  contact_id text,
  direction text,
  type text,
  body text,
  subject text,
  timestamp timestamptz,
  metadata jsonb,
  created_at timestamptz default now()
);

create table if not exists drafts (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  conversation_id text not null references conversations(id) on delete cascade,
  message_id text references messages(id) on delete set null,
  prompt_summary text,
  ai_reply text,
  model text,
  tokens integer,
  cost_eur numeric,
  status text default 'draft',
  created_at timestamptz default now()
);

create table if not exists sync_state (
  account_id text primary key references accounts(id) on delete cascade,
  last_synced_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
