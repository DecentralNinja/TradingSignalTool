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

alter table liquidation_clusters enable row level security;

create policy "Public read access" on liquidation_clusters
  for select using (true);
