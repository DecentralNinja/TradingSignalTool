-- Concrete take-profit/stop-loss price levels per signal, sized off the
-- historical average win/loss for that exact proven combo (see
-- fetcher/src/signal.js's suggestTradeLevels). Null for experimental
-- signals or timeframes where a proven combo has no TRADE_LEVELS entry yet.
-- take_profit_pct/stop_loss_pct are the raw (unleveraged) average win/loss
-- move -- stored separately from the price so the dashboard can compute
-- ROI% at any leverage without needing the entry price (which isn't stored
-- on this table at all).
alter table signals
  add column if not exists take_profit_price numeric,
  add column if not exists stop_loss_price numeric,
  add column if not exists exit_by_hours numeric,
  add column if not exists take_profit_pct numeric,
  add column if not exists stop_loss_pct numeric;
