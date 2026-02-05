-- Twilio SMS tracking + inbound (optional)

create table if not exists sms_events (
  id uuid default gen_random_uuid() primary key,
  provider text default 'twilio',
  to_phone text,
  from_phone text,
  body text,
  status text,
  provider_id text,
  created_at timestamptz default now(),
  metadata jsonb
);

create index if not exists sms_events_to_phone_idx on sms_events (to_phone);

create table if not exists sms_inbound (
  id uuid default gen_random_uuid() primary key,
  provider text default 'twilio',
  message_id text,
  from_phone text,
  to_phone text,
  body text,
  timestamp timestamptz,
  created_at timestamptz default now(),
  raw jsonb
);

create index if not exists sms_inbound_from_phone_idx on sms_inbound (from_phone);
