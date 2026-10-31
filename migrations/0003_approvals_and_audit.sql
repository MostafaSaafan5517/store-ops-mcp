-- Write tools: approvals carry the exact arguments they were prepared for, the audit log
-- records arguments and a plain summary, and each approval can produce at most one refund
-- and one audit row.

alter table store_ops.approvals
  add column args jsonb not null default '{}'::jsonb,
  add constraint approvals_tool_check check (
    tool in ('adjust_stock', 'cancel_order', 'issue_refund', 'add_order_note')
  );

alter table store_ops.audit_log
  add column args jsonb not null default '{}'::jsonb,
  add column summary text not null default '';

create unique index refunds_one_per_approval on store_ops.refunds (approval_id)
  where approval_id is not null;

create unique index audit_log_one_per_approval on store_ops.audit_log (approval_id)
  where approval_id is not null;

-- What an approval is for never changes after it is prepared. Status only moves forward:
-- pending -> approved | rejected | expired, approved -> executed | expired. The result is
-- written once, together with the move to executed.
create function store_ops.guard_approval_update() returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.store_id is distinct from old.store_id
     or new.user_id is distinct from old.user_id
     or new.tool is distinct from old.tool
     or new.args_hash is distinct from old.args_hash
     or new.args is distinct from old.args
     or new.summary is distinct from old.summary
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'approval %: only its status, result and decision times may change', old.id
      using errcode = 'insufficient_privilege';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('approved', 'rejected', 'expired'))
       or (old.status = 'approved' and new.status in ('executed', 'expired'))
     ) then
    raise exception 'approval %: status cannot change from % to %', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  if new.result is distinct from old.result
     and not (old.status = 'approved' and new.status = 'executed') then
    raise exception 'approval %: the result is written only when it executes', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger approvals_guard_update
before update on store_ops.approvals
for each row execute function store_ops.guard_approval_update();
