alter table market_snapshots
  add column if not exists bybit_mark_price numeric,
  add column if not exists bybit_funding_rate numeric,
  add column if not exists bybit_next_funding_time timestamptz,
  add column if not exists bybit_open_interest numeric,
  add column if not exists bybit_long_account_ratio numeric,
  add column if not exists bybit_short_account_ratio numeric,
  add column if not exists bybit_long_short_ratio numeric;
