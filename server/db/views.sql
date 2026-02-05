-- Optional helper views for inspecting drafts + full thread context

create or replace view drafts_overview as
select
  d.id as draft_id,
  d.account_id,
  a.name as account_name,
  d.conversation_id,
  d.message_id,
  d.ai_reply,
  d.model,
  d.tokens,
  d.cost_eur,
  d.status,
  d.created_at as draft_created_at,
  m.body as last_inbound_body,
  m.timestamp as last_inbound_time
from drafts d
left join accounts a on a.id = d.account_id
left join messages m
  on m.id = d.message_id;

create or replace view drafts_with_thread as
select
  d.id as draft_id,
  d.account_id,
  a.name as account_name,
  d.conversation_id,
  d.ai_reply,
  d.model,
  d.tokens,
  d.cost_eur,
  d.status,
  d.created_at as draft_created_at,
  jsonb_agg(
    jsonb_build_object(
      'direction', m.direction,
      'type', m.type,
      'body', m.body,
      'subject', m.subject,
      'timestamp', m.timestamp
    )
    order by m.timestamp asc
  ) as thread
from drafts d
left join accounts a on a.id = d.account_id
left join messages m on m.conversation_id = d.conversation_id
group by
  d.id,
  d.account_id,
  a.name,
  d.conversation_id,
  d.ai_reply,
  d.model,
  d.tokens,
  d.cost_eur,
  d.status,
  d.created_at;
