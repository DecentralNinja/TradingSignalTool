alter table market_snapshots
  add column if not exists fear_greed_value numeric,
  add column if not exists fear_greed_classification text;
