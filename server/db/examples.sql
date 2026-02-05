-- Example queries to review AI drafts + full conversation context

-- 1) Latest drafts (overview)
select *
from drafts_overview
order by draft_created_at desc
limit 20;

-- 2) Full thread for a specific draft
-- Replace <draft_id> with an actual draft_id from the query above.
select *
from drafts_with_thread
where draft_id = '<draft_id>';

-- 3) Latest drafts per subaccount
select
  account_name,
  draft_id,
  ai_reply,
  draft_created_at
from drafts_overview
order by account_name, draft_created_at desc;

-- 4) All messages for a conversation (chronological)
-- Replace <conversation_id> with a real conversation_id.
select direction, type, body, timestamp
from messages
where conversation_id = '<conversation_id>'
order by timestamp asc;
