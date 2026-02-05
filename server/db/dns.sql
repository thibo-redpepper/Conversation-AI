create table if not exists dns_records (
  id uuid default gen_random_uuid() primary key,
  provider text not null default 'mailgun',
  domain text not null,
  txt_records jsonb,
  mx_records jsonb,
  cname_record jsonb,
  created_at timestamptz default now()
);

-- If the table already exists, run:
-- alter table dns_records add column if not exists provider text not null default 'mailgun';
