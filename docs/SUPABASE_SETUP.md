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

## 3. Captcha (Turnstile) — fix `sitekey-secret-mismatch`

If Supabase shows **“captcha protection: request disallowed (sitekey-secret-mismatch)”**, the **Site Key** and **Secret Key** in your project do not belong to the same Cloudflare Turnstile widget.

### Option A — Disable captcha (fastest for testing)

1. Supabase → **Authentication** → **Attack Protection** (or **Bot and Abuse Protection**).
2. Turn **off** “Enable Captcha protection”.
3. Try sign-up / login again.

### Option B — Use Turnstile correctly (recommended for production)

1. [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Turnstile** → Add site.
2. Copy **Site Key** and **Secret Key** from the **same** widget.
3. Supabase → **Authentication** → **Attack Protection**:
   - Enable Captcha → provider **Turnstile**
   - Paste the **Secret Key** only (not the Site Key).
4. PalmPlay env (`.env` + Vercel):

```env
TURNSTILE_SITE_KEY=your_turnstile_site_key
```

5. Run `npm run config` and redeploy.

The login/signup pages show the Turnstile widget when `TURNSTILE_SITE_KEY` is set and send the token to Supabase.

**Common mistake:** putting the Site Key into Supabase’s secret field, or mixing keys from two different Turnstile sites.

## 4. Deploy

Push to `main`; Vercel runs `npm run build`, which regenerates config from env vars.

## 5. Verify

1. Open `/app/signup` → complete captcha (if shown) → create an account.
2. Log in on another browser/device with the same account.
3. Like a song or add to a playlist → data should appear after refresh on the second device.

Without Supabase env vars, the app falls back to the previous **local-only** login (localStorage).
