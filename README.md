# SUKI DASHBOARD PRO

Dashboard für die **SUKI** (Neel 47 Trimaran) — SvelteKit + Supabase + Cloudflare Pages.

## Stack

| | |
|---|---|
| Frontend | SvelteKit 2 + Svelte 5 + TypeScript |
| Datenbank | Supabase (PostgreSQL + Auth) |
| Hosting | Cloudflare Pages |
| Cerbo Bridge | Python `server.py` → Supabase REST |

## Lokale Entwicklung

```bash
npm install
npm run dev
```

`.env` (bereits vorhanden):
```
PUBLIC_SUPABASE_URL=https://mtcmxrmykvthybwrlnvz.supabase.co
PUBLIC_SUPABASE_ANON_KEY=...
```

## Deploy

Push auf `main` → GitHub Actions baut und deployed automatisch auf Cloudflare Pages.

GitHub Secrets benötigt:
- `PUBLIC_SUPABASE_URL`
- `PUBLIC_SUPABASE_ANON_KEY`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SUPABASE_SERVICE_KEY` (für DB-Pruning)

## Struktur

```
src/
├── lib/
│   ├── supabase.ts          # Supabase Client
│   ├── types.ts             # TypeScript Typen
│   ├── stores/              # telemetry, auth, anchor
│   ├── utils/               # units, geo
│   └── components/          # cards, layout, ui
└── routes/
    ├── (auth)/login/        # Login
    ├── (auth)/change-password/
    └── (app)/               # vessel, anchor, settings
```
