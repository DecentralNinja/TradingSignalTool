alter table signals
  add column if not exists combo text,
  add column if not exists confidence text;
