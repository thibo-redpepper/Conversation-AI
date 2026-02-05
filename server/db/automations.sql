-- CRM Automations (drafts only, no auto-send yet)

create table if not exists crm_automations (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  trigger_type text default 'stage',
  trigger_value text,
  channel text default 'both', -- email | sms | both
  email_subject text,
  email_body text,
  sms_body text,
  delay_minutes int default 0,
  business_hours_only boolean default false,
  enabled boolean default true,
  steps jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

create index if not exists crm_automations_enabled_idx on crm_automations (enabled);

alter table crm_automations
  add column if not exists steps jsonb default '[]'::jsonb;
