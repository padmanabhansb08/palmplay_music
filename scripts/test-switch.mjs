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
        console.log(`Track cards found: ${cardCount}`);

        if (cardCount === 0) {
            throw new Error('No playable cards on home');
        }

        // Click first track
        console.log("Clicking first track...");
        await cards.nth(0).click();
        await page.waitForTimeout(2000);
        
        // Wait for audio src
        const getAudioSrc = async () => {
            return await page.evaluate(() => {
                const a = document.getElementById('palmplay-audio');
                return a ? a.src : null;
            });
        };
        
        let src1 = await getAudioSrc();
        let name1 = await page.locator('.track-name').first().textContent();
        console.log(`Track 1 Name: ${name1}`);
        console.log(`Track 1 Src: ${src1}`);
        
        // Click second track
        console.log("Clicking second track...");
        await cards.nth(1).click();
        await page.waitForTimeout(2000);
        
        let src2 = await getAudioSrc();
        let name2 = await page.locator('.track-name').first().textContent();
        console.log(`Track 2 Name: ${name2}`);
        console.log(`Track 2 Src: ${src2}`);
        
        if (src1 === src2) {
            console.error("FAIL: Audio src did not change!");
        } else {
            console.log("PASS: Audio src changed successfully.");
        }
    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
}

main();
