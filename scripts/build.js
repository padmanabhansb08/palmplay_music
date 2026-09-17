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
fs.cpSync(srcDir, path.join(distDir, 'pamplay-frontend'), { recursive: true });

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
