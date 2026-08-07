alter table market_snapshots
  add column if not exists cftc_report_date timestamptz,
  add column if not exists cftc_lev_funds_long numeric,
  add column if not exists cftc_lev_funds_short numeric,
  add column if not exists cftc_lev_funds_long_short_ratio numeric;
