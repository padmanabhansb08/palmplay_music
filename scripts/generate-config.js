/**
 * Reads .env and writes browser config files.
 * Public: pamplay-frontend/env-config.js (safe to commit)
 * Private: pamplay-frontend/catalog-config.js (gitignored — catalog API URL)
 * Run: node scripts/generate-config.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = fs.existsSync(path.join(root, '.env'))
    ? path.join(root, '.env')
    : path.join(root, '.env.example');

const publicOut = path.join(root, 'pamplay-frontend', 'env-config.js');
const catalogOut = path.join(root, 'pamplay-frontend', 'catalog-config.js');
const supabaseOut = path.join(root, 'pamplay-frontend', 'supabase-config.js');

const publicDefaults = {
    AUDIUS_API_HOST: 'https://discoveryprovider.audius.co',
    AUDIUS_DISCOVERY_URL: 'https://api.audius.co',
    AUDIUS_APP_NAME: 'PalmPlay',
    DEFAULT_ART_URL: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=300&h=300&fit=crop',
    CATALOG_REQUESTS_PER_MINUTE: '30',
    CATALOG_MAX_CONCURRENT: '4',
    CATALOG_FALLBACK_MINUTES: '15',
};

const catalogDefaults = {
    MUSIC_CATALOG_API_BASE: '',
};

const supabaseDefaults = {
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
};

const parsed = { ...publicDefaults, ...catalogDefaults, ...supabaseDefaults };
const raw = fs.readFileSync(envPath, 'utf8');

for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }
    value = value.trim();
    if (key === 'JIOSAAVN_API_BASE') {
        parsed.MUSIC_CATALOG_API_BASE = value;
    } else if (key in publicDefaults) {
        parsed[key] = value;
    } else if (key in catalogDefaults) {
        parsed[key] = value;
    } else if (key in supabaseDefaults) {
        parsed[key] = value;
    }
}

const publicConfig = {};
for (const key of Object.keys(publicDefaults)) {
    publicConfig[key] = parsed[key];
}

// Vercel / CI: overlay from process.env when .env is absent
for (const key of Object.keys(publicDefaults)) {
    if (process.env[key]) parsed[key] = String(process.env[key]).trim();
}
if (process.env.MUSIC_CATALOG_API_BASE) parsed.MUSIC_CATALOG_API_BASE = String(process.env.MUSIC_CATALOG_API_BASE).trim();
if (process.env.JIOSAAVN_API_BASE) parsed.MUSIC_CATALOG_API_BASE = String(process.env.JIOSAAVN_API_BASE).trim();
if (process.env.SUPABASE_URL) parsed.SUPABASE_URL = String(process.env.SUPABASE_URL).trim();
if (process.env.SUPABASE_ANON_KEY) parsed.SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY).trim();

const catalogBase = (parsed.MUSIC_CATALOG_API_BASE || '').trim().replace(/\/$/, '');

const publicJs = `// Auto-generated from ${path.basename(envPath)} — do not edit by hand
// Regenerate: node scripts/generate-config.js
window.PALMPLAY_ENV = ${JSON.stringify(publicConfig, null, 4)};
`;

const catalogJs = `// Auto-generated private catalog config (gitignored)
// Regenerate: node scripts/generate-config.js
window.PALMPLAY_CATALOG = ${JSON.stringify({ apiBase: catalogBase }, null, 4)};
`;

const supabaseJs = `// Auto-generated Supabase config (gitignored)
// Regenerate: node scripts/generate-config.js
window.PALMPLAY_SUPABASE = ${JSON.stringify({
    url: (parsed.SUPABASE_URL || '').trim(),
    anonKey: (parsed.SUPABASE_ANON_KEY || '').trim(),
}, null, 4)};
`;

fs.writeFileSync(publicOut, publicJs, 'utf8');
fs.writeFileSync(catalogOut, catalogJs, 'utf8');
fs.writeFileSync(supabaseOut, supabaseJs, 'utf8');
console.log('Wrote', publicOut);
console.log('Wrote', catalogOut);
console.log('Wrote', supabaseOut);
