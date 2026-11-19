const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const srcDir = path.join(rootDir, 'pamplay-frontend');
const distDir = path.join(rootDir, 'dist');

console.log('Cleaning dist directory...');
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

console.log('Copying index.html and pamplay-frontend to dist...');
fs.cpSync(path.join(rootDir, 'index.html'), path.join(distDir, 'index.html'));
// Branded 404 page (Vercel serves /404.html for unknown URLs instead of a bare "404" text)
fs.cpSync(path.join(rootDir, '404.html'), path.join(distDir, '404.html'));
fs.cpSync(srcDir, path.join(distDir, 'pamplay-frontend'), { recursive: true });

// Production pages are served at /app (no trailing slash). Without a static
// <base>, the browser's preload scanner resolves "style.css", "app.js", … against
// "/" and downloads every asset twice (once as a 404) before the inline
// base-href script runs. A static <base> carrying data-pp-base makes that
// script a no-op and fixes resolution from the very first byte.
console.log('Injecting static <base href="/app/"> into pages...');
const pagesDir = path.join(distDir, 'pamplay-frontend');
for (const file of fs.readdirSync(pagesDir).filter((f) => f.endsWith('.html'))) {
    const p = path.join(pagesDir, file);
    const html = fs.readFileSync(p, 'utf8');
    if (html.includes('<base ')) continue;
    const out = html.replace(/<head>/i, '<head>\n    <base href="/app/" data-pp-base="1">');
    if (out === html) {
        console.error(`  ! no <head> in ${file}; skipped`);
        continue;
    }
    fs.writeFileSync(p, out);
    console.log(`  ${file}`);
}

console.log('Minifying JS...');
try {
    const jsTarget = path.join(distDir, 'pamplay-frontend', 'app.js');
    execSync(`npx terser "${jsTarget}" -o "${jsTarget}" -c -m`, { stdio: 'inherit' });
    console.log('JS minified successfully.');
} catch (e) {
    console.error('Failed to minify JS:', e.message);
    process.exit(1);
}

console.log('Minifying CSS...');
try {
    const cssTarget = path.join(distDir, 'pamplay-frontend', 'style.css');
    execSync(`npx clean-css-cli -o "${cssTarget}" "${cssTarget}"`, { stdio: 'inherit' });
    console.log('CSS minified successfully.');
} catch (e) {
    console.error('Failed to minify CSS:', e.message);
    process.exit(1);
}

console.log('Build completed successfully!');
