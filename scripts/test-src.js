const { chromium } = require('playwright');
const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..')));

const server = app.listen(8081, async () => {
    console.log('Server running on port 8081');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    try {
        console.log(`Opening page...`);
        await page.goto('http://127.0.0.1:8081/pamplay-frontend/home.html', { waitUntil: 'networkidle' });
        await page.waitForSelector('.home-section-grid .card', { timeout: 15000 });

        const cards = page.locator('.home-section-grid .card');
        const count = await cards.count();
        console.log(`Found ${count} cards`);

        console.log('Clicking card 0...');
        await cards.nth(0).click();
        await page.waitForTimeout(2000);
        let src1 = await page.evaluate(() => window.audio?.src || document.getElementById('palmplay-audio')?.src);
        
        console.log('Clicking card 1...');
        await cards.nth(1).click();
        await page.waitForTimeout(2000);
        let src2 = await page.evaluate(() => window.audio?.src || document.getElementById('palmplay-audio')?.src);
        
        console.log("Src 1:", src1);
        console.log("Src 2:", src2);
        
        if (src1 === src2) {
            console.error("FAILURE: Src did not change!");
        } else {
            console.log("SUCCESS: Src changed correctly.");
        }
    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
        server.close();
    }
});
