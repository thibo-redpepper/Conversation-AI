-- CRM leads storage

create table if not exists crm_leads (
  id uuid default gen_random_uuid() primary key,
  external_id text,
  name text not null,
  email text,
  phone text,
  status text,
  owner text,
  created_at timestamptz default now(),
  source text,
  pipeline_stage text,
  metadata jsonb
);

create index if not exists crm_leads_email_idx on crm_leads (email);
create index if not exists crm_leads_external_id_idx on crm_leads (external_id);

-- Leads with last inbound/outbound activity
create or replace view crm_leads_activity as
select
  l.id,
  l.external_id,
  l.name,
  l.email,
  l.phone,
  l.status,
  l.owner,
  l.created_at,
  l.source,
  l.pipeline_stage,
  l.metadata,
  case
    when max(me.created_at) is null and max(se.created_at) is null then null
    else greatest(
      coalesce(max(me.created_at), '1970-01-01'::timestamptz),
      coalesce(max(se.created_at), '1970-01-01'::timestamptz)
    )
  end as last_outbound_at,
  case
    when max(mi.timestamp) is null and max(si.timestamp) is null then null
    else greatest(
      coalesce(max(mi.timestamp), '1970-01-01'::timestamptz),
      coalesce(max(si.timestamp), '1970-01-01'::timestamptz)
    )
  end as last_inbound_at
from crm_leads l
left join mail_events me on lower(me.to_email) = lower(l.email)
left join mail_inbound mi on lower(mi.from_email) = lower(l.email)
left join sms_events se on regexp_replace(se.to_phone, '\D', '', 'g') = regexp_replace(l.phone, '\D', '', 'g')
left join sms_inbound si on regexp_replace(si.from_phone, '\D', '', 'g') = regexp_replace(l.phone, '\D', '', 'g')
group by l.id;

create or replace view crm_leads_open as
select *
from crm_leads_activity
where last_outbound_at is not null
  and (last_inbound_at is null or last_inbound_at < last_outbound_at);
