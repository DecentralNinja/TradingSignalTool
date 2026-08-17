-- Raw data pulled from Binance every 15 minutes
create table if not exists market_snapshots (
  id bigint generated always as identity primary key,
  symbol text not null,
  fetched_at timestamptz not null,
  mark_price numeric not null,
  funding_rate numeric not null,
  next_funding_time timestamptz,
  open_interest numeric not null,
  long_account_ratio numeric not null,
  short_account_ratio numeric not null,
  long_short_ratio numeric not null,
  taker_buy_vol numeric not null,
  taker_sell_vol numeric not null,
  taker_buy_sell_ratio numeric not null,
  top_trader_long_account_ratio numeric,
  top_trader_short_account_ratio numeric,
  top_trader_long_short_ratio numeric,
  basis numeric,
  basis_rate numeric,
  bybit_mark_price numeric,
  bybit_funding_rate numeric,
  bybit_next_funding_time timestamptz,
  bybit_open_interest numeric,
  bybit_long_account_ratio numeric,
  bybit_short_account_ratio numeric,
  bybit_long_short_ratio numeric,
  fear_greed_value numeric,
  fear_greed_classification text,
  cftc_report_date timestamptz,
  cftc_lev_funds_long numeric,
  cftc_lev_funds_short numeric,
  cftc_lev_funds_long_short_ratio numeric,
  created_at timestamptz not null default now(),
  unique (symbol, fetched_at)
);

create index if not exists market_snapshots_symbol_fetched_at_idx
  on market_snapshots (symbol, fetched_at desc);

-- Rule-based signal. timeframe distinguishes the 4-hour (structural) signal
-- from the 1-hour (momentum) one -- same table, same accuracy tracking.
create table if not exists signals (
  id bigint generated always as identity primary key,
  symbol text not null,
  timeframe text not null default '4h',
  evaluated_at timestamptz not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  signal text not null check (signal in ('bullish', 'bearish', 'neutral')),
  reason text,
  combo text,
  confidence text,
  volatility numeric,
  volatility_regime text,
  outcome_price numeric,
  outcome_evaluated_at timestamptz,
  outcome_correct boolean,
  take_profit_price numeric,
  stop_loss_price numeric,
  exit_by_hours numeric,
  take_profit_pct numeric,
  stop_loss_pct numeric,
  created_at timestamptz not null default now()
);

create index if not exists signals_symbol_timeframe_evaluated_at_idx
  on signals (symbol, timeframe, evaluated_at desc);

-- Estimated liquidation price clusters (modeled from OI + assumed leverage
-- distribution, not real liquidation events -- see fetcher/src/liquidationHeatmap.js).
-- Informational only: not yet folded into the scored signal, same as CFTC
-- data, pending backtested validation.
create table if not exists liquidation_clusters (
  id bigint generated always as identity primary key,
  symbol text not null,
  computed_at timestamptz not null,
  reference_price numeric not null,
  cluster_price numeric not null,
  dominant_side text not null check (dominant_side in ('long', 'short')),
  windows_confirmed_in integer not null,
  created_at timestamptz not null default now()
);

create index if not exists liquidation_clusters_symbol_computed_at_idx
  on liquidation_clusters (symbol, computed_at desc);

-- Fetcher writes with the service_role key (bypasses RLS).
-- Frontend reads with the anon key, so allow public read-only access.
alter table market_snapshots enable row level security;
alter table signals enable row level security;
alter table liquidation_clusters enable row level security;

create policy "Public read access" on market_snapshots
  for select using (true);

create policy "Public read access" on signals
  for select using (true);

create policy "Public read access" on liquidation_clusters
  for select using (true);
