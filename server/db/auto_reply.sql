-- Auto-reply rules for CRM AI prompts

create table if not exists auto_reply_rules (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  prompt text not null,
  channel text default 'both', -- email | sms | both
  enabled boolean default true,
  delay_minutes int default 0,
  business_hours_only boolean default false,
  created_at timestamptz default now()
);

create index if not exists auto_reply_rules_enabled_idx on auto_reply_rules (enabled);
create index if not exists auto_reply_rules_channel_idx on auto_reply_rules (channel);
