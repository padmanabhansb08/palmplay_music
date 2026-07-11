const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    // 1. Launch browser with camera permissions enabled
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--use-fake-ui-for-media-stream', // Auto-accept camera permissions
            '--use-fake-device-for-media-stream',
            '--no-sandbox'
        ]
    });
    
    const page = await browser.newPage();
    
    const consoleLogs = [];
    
    page.on('console', msg => {
        const type = msg.type();
        if (type === 'error' || type === 'warning') {
            consoleLogs.push(`[${type.toUpperCase()}] ${msg.text()}`);
        }
    });
    
    page.on('pageerror', err => {
        consoleLogs.push(`[UNCAUGHT EXCEPTION] ${err.message}`);
    });
    
    console.log("Navigating to URL...");
    await page.goto('https://palmplay-music.vercel.app/pamplay-frontend/home.html', { waitUntil: 'networkidle2' });
    
    console.log("Waiting for 3 seconds...");
    await new Promise(r => setTimeout(r, 3000));
    
    consoleLogs.length = 0; // Start recording errors only after this point (step 3)

    console.log("Looking for gesture-toggle button...");
    try {
        await page.evaluate(() => {
            const el = document.getElementById('gesture-toggle');
            if (el) {
                el.click();
            } else {
                console.error("No element with ID 'gesture-toggle' found");
            }
        });
    } catch (e) {
        console.log("Error clicking button: " + e.message);
    }
    
    console.log("Waiting 6 seconds for camera...");
    await new Promise(r => setTimeout(r, 6000));
    
    console.log("Taking screenshot...");
    await page.screenshot({ path: 'screenshot_v2.png' });
    
    await browser.close();
    
    const report = {
        postClickConsoleErrors: consoleLogs,
    };
    
    fs.writeFileSync('report_v2.json', JSON.stringify(report, null, 2));
    console.log("DONE");
})();
