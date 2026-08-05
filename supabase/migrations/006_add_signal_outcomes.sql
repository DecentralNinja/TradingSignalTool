alter table signals
  add column if not exists outcome_price numeric,
  add column if not exists outcome_evaluated_at timestamptz,
  add column if not exists outcome_correct boolean;
