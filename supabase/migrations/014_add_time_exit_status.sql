-- Trades still open at their signal's exit_by_hours are now closed at market
-- by the bridge (the TP/SL levels assume that holding window; past it the
-- backtest showed small winners drifting into full stop-losses).
alter table trades drop constraint if exists trades_status_check;
alter table trades add constraint trades_status_check check (
  status in ('open', 'closed_won', 'closed_lost', 'closed_manual', 'closed_time_exit', 'failed')
);
