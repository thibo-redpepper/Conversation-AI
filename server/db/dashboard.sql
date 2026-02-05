-- Supabase dashboard helper views

create or replace view dashboard_kpis as
select
  a.id as account_id,
  a.name as account_name,
  count(distinct c.id) as conversations_total,
  count(m.id) as messages_total,
  count(*) filter (where m.direction ilike 'in%') as inbound_total,
  count(*) filter (where m.direction ilike 'out%') as outbound_total,
  count(d.id) as drafts_total,
  max(m.timestamp) as last_message_at,
  max(d.created_at) as last_draft_at
from accounts a
left join conversations c on c.account_id = a.id
left join messages m on m.conversation_id = c.id
left join drafts d on d.conversation_id = c.id
group by a.id, a.name;

create or replace view dashboard_daily_volume as
select
  a.name as account_name,
  date_trunc('day', m.timestamp) as day,
  count(*) filter (where m.direction ilike 'in%') as inbound_count,
  count(*) filter (where m.direction ilike 'out%') as outbound_count
from messages m
join accounts a on a.id = m.account_id
group by a.name, date_trunc('day', m.timestamp)
order by day desc;

create or replace view dashboard_drafts_recent as
select
  d.id as draft_id,
  a.name as account_name,
  d.conversation_id,
  d.ai_reply,
  d.tokens,
  d.cost_eur,
  d.created_at as draft_created_at
from drafts d
left join accounts a on a.id = d.account_id
order by d.created_at desc;

create or replace view dashboard_lost_drafts_recent as
select
  ld.id as lost_id,
  a.name as account_name,
  ld.conversation_id,
  ld.message_id,
  ld.status,
  ld.reason,
  ld.confidence,
  ld.model,
  ld.tokens,
  ld.cost_eur,
  ld.created_at as lost_created_at,
  m.body as last_inbound_body,
  m.timestamp as last_inbound_time
from lost_drafts ld
left join accounts a on a.id = ld.account_id
left join messages m on m.id = ld.message_id
order by ld.created_at desc;
