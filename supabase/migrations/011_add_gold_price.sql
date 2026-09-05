alter table market_snapshots
  add column if not exists gold_price numeric;
