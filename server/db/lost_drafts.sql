-- Lost draft storage (fictieve losts, niet naar GHL)

create table if not exists lost_drafts (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  conversation_id text not null references conversations(id) on delete cascade,
  message_id text references messages(id) on delete set null,
  status text default 'draft',
  reason text,
  confidence numeric,
  model text,
  tokens integer,
  cost_eur numeric,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists lost_drafts_account_idx on lost_drafts (account_id);
create index if not exists lost_drafts_status_idx on lost_drafts (status);
