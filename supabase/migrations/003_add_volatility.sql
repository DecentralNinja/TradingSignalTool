alter table signals
  add column if not exists volatility numeric,
  add column if not exists volatility_regime text;
