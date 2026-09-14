alter table signals
  add column if not exists position_size_label text,
  add column if not exists position_size_pct numeric;
