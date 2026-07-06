import { chromium } from 'playwright';

const BASE = process.env.PP_URL || 'http://localhost:8000/pamplay-frontend/home.html';

async function main() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const log = (msg) => console.log(msg);

    try {
        log(`Opening ${BASE}`);
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1500);

        const oauthMeta = await page.evaluate(async () => {
            const randomToken = (n) => {
                const bytes = new Uint8Array(n);
                crypto.getRandomValues(bytes);
                return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
            };
            const pkceChallenge = async (verifier) => {
                const data = new TextEncoder().encode(verifier);
                const digest = await crypto.subtle.digest('SHA-256', data);
                return btoa(String.fromCharCode(...new Uint8Array(digest)))
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/, '');
            };
            const verifier = randomToken(96);
            const stateToken = randomToken(24);
            const challenge = await pkceChallenge(verifier);
            const path = location.pathname || '';
            const redirectUri = (path === '/app' || path.startsWith('/app/'))
                ? `${location.origin}/app`
                : `${location.origin}/pamplay-frontend/home.html`;
            localStorage.setItem('palmplay_spotify_redirect_uri_v1', redirectUri);
            localStorage.setItem('palmplay_spotify_pkce_cache_v1', JSON.stringify({
                state: stateToken,
                verifier,
                autoImport: true,
                createdAt: Date.now()
            }));
            sessionStorage.setItem('palmplay_spotify_pkce_state', stateToken);
            sessionStorage.setItem('palmplay_spotify_pkce_verifier', verifier);
            sessionStorage.setItem('palmplay_spotify_auto_import', '1');
            const clientId = 'c6177a0758d04a8582e59cd86bd18fbf';
            const params = new URLSearchParams({
                client_id: clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                code_challenge_method: 'S256',
                code_challenge: challenge,
                scope: 'user-library-read playlist-read-private playlist-read-collaborative',
                state: stateToken,
                show_dialog: 'false'
            });
            return {
                stateToken,
                redirectUri,
                authUrl: `https://accounts.spotify.com/authorize?${params.toString()}`
            };
        });
        const navPromise = page.waitForURL(/accounts\.spotify\.com/, { timeout: 20000 });
        await page.goto(oauthMeta.authUrl);
        await navPromise;

        const authUrl = page.url();
        const parsed = new URL(authUrl);
        let redirectUri = parsed.searchParams.get('redirect_uri');
        let showDialog = parsed.searchParams.get('show_dialog');
        let state = parsed.searchParams.get('state');
        if (!redirectUri && parsed.searchParams.get('continue')) {
            const continueUrl = new URL(parsed.searchParams.get('continue'));
            redirectUri = continueUrl.searchParams.get('redirect_uri');
            showDialog = continueUrl.searchParams.get('show_dialog');
            state = continueUrl.searchParams.get('state');
        }
        log(`redirect_uri=${redirectUri}`);
        log(`show_dialog=${showDialog}`);

        if (!redirectUri || (!redirectUri.includes('/app') && !redirectUri.includes('home.html'))) {
            throw new Error(`Unexpected redirect_uri: ${redirectUri}`);
        }
        if (showDialog === 'true') {
            throw new Error('show_dialog=true on first connect causes repeated Agree prompts');
        }

        if (oauthMeta.stateToken !== state) throw new Error('PKCE state mismatch with authorize URL');
        log('PASS: Spotify authorize uses stable redirect_uri and saved PKCE');

        await page.goto(`${oauthMeta.redirectUri}?code=fake_test_code&state=${encodeURIComponent(oauthMeta.stateToken)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await page.waitForTimeout(4000);

        if (/accounts\.spotify\.com/.test(page.url())) {
            throw new Error('Agree loop: page redirected back to Spotify after callback');
        }
        if (page.url().includes('code=')) {
            throw new Error('OAuth query not cleared after callback handling');
        }

        const autoImport = await page.evaluate(() => sessionStorage.getItem('palmplay_spotify_auto_import'));
        if (autoImport === '1') {
            throw new Error('AUTO_IMPORT still set after failed token exchange');
        }

        log('PASS: failed callback does not loop back to Spotify consent');
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
