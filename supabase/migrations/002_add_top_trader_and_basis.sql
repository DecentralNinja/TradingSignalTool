alter table market_snapshots
  add column if not exists top_trader_long_account_ratio numeric,
  add column if not exists top_trader_short_account_ratio numeric,
  add column if not exists top_trader_long_short_ratio numeric,
  add column if not exists basis numeric,
  add column if not exists basis_rate numeric;
