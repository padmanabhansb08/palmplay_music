import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8000/pamplay-frontend/home.html';

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    try {
        console.log(`Opening ${BASE}`);
        await page.goto(BASE, { waitUntil: 'networkidle' });
        await page.waitForSelector('.home-section-grid .card', { timeout: 15000 });

        const cards = page.locator('.home-section-grid .card');
        const cardCount = await cards.count();
        
        await cards.nth(0).click();
        await page.waitForTimeout(2000);
        let src1 = await page.evaluate(() => document.getElementById('palmplay-audio')?.src);
        
        await cards.nth(1).click();
        await page.waitForTimeout(2000);
        let src2 = await page.evaluate(() => document.getElementById('palmplay-audio')?.src);
        
        console.log("Src 1:", src1);
        console.log("Src 2:", src2);
        
    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
}

main();
