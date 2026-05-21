# Supabase auth & cloud sync (Gap 1)

PalmPlay uses Supabase for **real sign-in** and syncing **playlists** and **liked songs** across devices. Local music files (uploaded MP3s) stay in the browser only (Dexie blobs are not uploaded).

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → New project.
2. **Authentication → Providers → Email**: enable Email; for quick testing you can disable “Confirm email”.
3. **SQL Editor**: paste and run `supabase/schema.sql` from this repo.

## 2. Environment variables

Add to `.env` (local) and **Vercel → Project → Settings → Environment Variables**:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=your_anon_public_key
```

Then regenerate config:

```bash
npm run config
```

This writes gitignored `pamplay-frontend/supabase-config.js` (loaded by the app).

## 3. Deploy

Push to `main`; Vercel runs `npm run build`, which regenerates config from env vars.

## 4. Verify

1. Open `/app/signup` → create an account.
2. Log in on another browser/device with the same account.
3. Like a song or add to a playlist → data should appear after refresh on the second device.

Without Supabase env vars, the app falls back to the previous **local-only** login (localStorage).
