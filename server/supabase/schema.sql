-- Supabase schema for conversation monitoring + AI drafts
create extension if not exists "pgcrypto";

create table if not exists accounts (
  id uuid default gen_random_uuid() primary key,
  name text unique not null,
  created_at timestamptz default now()
);

create table if not exists conversations (
  conversation_hash text primary key,
  account_name text references accounts(name),
  contact_hash text,
  context jsonb,
  last_message_at timestamptz,
  last_message_direction text,
  last_message_body text,
  updated_at timestamptz default now()
);

create table if not exists messages (
  message_hash text primary key,
  conversation_hash text references conversations(conversation_hash),
  account_name text references accounts(name),
  direction text,
  type text,
  subject text,
  body text,
  timestamp timestamptz,
  raw jsonb
);

create table if not exists drafts (
  draft_id uuid default gen_random_uuid() primary key,
  message_hash text unique references messages(message_hash),
  conversation_hash text references conversations(conversation_hash),
  account_name text references accounts(name),
  draft_text text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  cost_eur numeric,
  created_at timestamptz default now()
);

create table if not exists sync_state (
  account_name text primary key,
  last_synced_at timestamptz
);
