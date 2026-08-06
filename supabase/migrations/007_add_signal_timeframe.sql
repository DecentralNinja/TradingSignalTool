alter table signals
  add column if not exists timeframe text not null default '4h';

-- Existing rows all belong to the original 4-hour signal.
update signals set timeframe = '4h' where timeframe is null;

drop index if exists signals_symbol_evaluated_at_idx;
create index if not exists signals_symbol_timeframe_evaluated_at_idx
  on signals (symbol, timeframe, evaluated_at desc);
