-- Mailgun email tracking + inbound replies

create table if not exists mail_events (
  id uuid default gen_random_uuid() primary key,
  provider text default 'mailgun',
  to_email text,
  from_email text,
  subject text,
  status text,
  provider_id text,
  created_at timestamptz default now(),
  metadata jsonb
);

create table if not exists mail_inbound (
  id uuid default gen_random_uuid() primary key,
  provider text default 'mailgun',
  message_id text,
  from_email text,
  to_email text,
  subject text,
  body_plain text,
  body_html text,
  timestamp timestamptz,
  created_at timestamptz default now(),
  raw jsonb
);
