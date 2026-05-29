import { chromium } from 'playwright';

const BASE = process.env.PP_URL || 'https://palmplay-music.vercel.app/app';

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const log = (msg) => console.log(msg);
    const consoleLogs = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
        }
    });

    try {
        log(`Opening ${BASE}`);
        await page.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
        await page.waitForSelector('.home-section-grid .card, .card-grid .card, .card', { timeout: 45000 });

        const appScript = await page.locator('script[src*="app.js"]').first().getAttribute('src');
        log(`app.js: ${appScript || 'missing'}`);

        const cards = page.locator('.home-section-grid .card, .card-grid .card, .card');
        const cardCount = await cards.count();
        log(`Track cards found: ${cardCount}`);

        if (cardCount === 0) {
            await page.screenshot({ path: 'scripts/smoke-no-cards.png', fullPage: true });
            throw new Error('No playable cards on home');
        }

        await cards.first().click({ timeout: 10000 });
        await page.waitForTimeout(2000);
        const playBtn = page.locator('.play-pause-btn').first();
        await playBtn.click({ force: true, timeout: 5000 });
        await page.waitForTimeout(2500);

        const playIcon = page.locator('.play-pause-btn i').first();
        let icon1 = await playIcon.getAttribute('class');
        if ((icon1 || '').includes('spinner')) {
            await page.waitForTimeout(4000);
            icon1 = await playIcon.getAttribute('class');
        }
        const time1 = await page.locator('#time-current, .progress-time').first().textContent();
        log(`After first play icon: ${icon1}`);
        log(`Time after first play: ${time1}`);

        await page.locator('.fa-step-forward').first().click({ force: true, timeout: 10000 });
        await page.waitForTimeout(4000);
        let icon2 = await playIcon.getAttribute('class');
        if ((icon2 || '').includes('spinner')) {
            await page.waitForTimeout(4000);
            icon2 = await playIcon.getAttribute('class');
        }

        const time2 = await page.locator('#time-current, .progress-time').first().textContent();
        const trackName = await page.locator('.track-name').first().textContent();
        log(`After next icon: ${icon2}`);
        log(`Time after next: ${time2}`);
        log(`Track title: ${trackName}`);

        const stuckLoading = (icon2 || '').includes('spinner');
        const hasProgress = time2 && time2.trim() !== '0:00';

        await page.screenshot({ path: 'scripts/smoke-after-next.png', fullPage: false });

        if (stuckLoading) {
            throw new Error('Play button still shows loading spinner after next');
        }
        if (!hasProgress && (icon2 || '').includes('pause')) {
            log('WARN: playing but time still 0:00 (metadata may be slow)');
        }

        log('PASS: next track switch did not leave spinner stuck');
        if (consoleLogs.length) {
            log('Browser console issues:');
            consoleLogs.slice(0, 8).forEach((line) => log(`  ${line}`));
        }
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
});
