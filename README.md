# Trading Signal Tool

A crypto derivatives signal dashboard. Starts with BTC, rule-based logic, and Binance's free public API.

## Structure

- `frontend/` — React + Sass dashboard (Vite)
- `fetcher/` — Node.js script that pulls Binance data on a schedule (run via GitHub Actions), writes to Supabase

## Development

```
cd frontend && npm run dev
```
