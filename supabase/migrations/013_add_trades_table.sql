-- Real (paper, then eventually live) trades taken from the dashboard's
-- Take Trade / Close Trade buttons, executed against Bitget's UTA API.
-- One row per trade attempt, linked back to the signal that triggered it.
create table if not exists trades (
  id bigint generated always as identity primary key,
  signal_id bigint references signals (id),
  symbol text not null default 'BTCUSDT',
  direction text not null check (direction in ('long', 'short')),
  status text not null default 'open' check (
    status in ('open', 'closed_won', 'closed_lost', 'closed_manual', 'failed')
  ),
  is_demo boolean not null default true,
  position_size_pct numeric,
  margin_usd numeric,
  qty numeric,
  entry_price numeric,
  stop_loss_price numeric,
  take_profit_price numeric,
  exit_price numeric,
  pnl_pct numeric,
  pnl_usd numeric,
  bitget_order_id text,
  error_message text,
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists trades_signal_id_idx on trades (signal_id);
create index if not exists trades_status_idx on trades (status);

-- Bridge server writes with the service_role key (bypasses RLS).
-- Only the authenticated owner (logged in via Supabase Auth) may read trades --
-- unlike signals/market_snapshots, this table can contain live trading data.
alter table trades enable row level security;

create policy "Authenticated read access" on trades
  for select using (auth.role() = 'authenticated');
