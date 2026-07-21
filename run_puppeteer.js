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
    
    // Arrays to collect logs
    const consoleLogs = [];
    const failedRequests = [];
    
    // 3. Open browser console and collect ALL errors and warnings
    page.on('console', msg => {
        const type = msg.type();
        if (type === 'error' || type === 'warning') {
            consoleLogs.push(`[${type.toUpperCase()}] ${msg.text()}`);
        }
    });
    
    page.on('pageerror', err => {
        consoleLogs.push(`[UNCAUGHT EXCEPTION] ${err.message}`);
    });
    
    // 4. Check Network tab for any failed requests
    page.on('response', response => {
        const status = response.status();
        if (status >= 400) {
            failedRequests.push(`[${status}] ${response.url()}`);
        }
    });
    
    // 1. Navigate to URL
    console.log("Navigating to URL...");
    await page.goto('https://palmplay-music.vercel.app/home.html', { waitUntil: 'networkidle2' });
    
    // 2. Wait at least 3 seconds
    console.log("Waiting for 3 seconds...");
    await new Promise(r => setTimeout(r, 3000));
    
    // Save initial logs
    const initialLogs = [...consoleLogs];
    consoleLogs.length = 0; // Clear for next step
    
    // 5. Click "Gestures: OFF" button
    console.log("Looking for Gestures button...");
    try {
        const buttons = await page.$$('button');
        let clicked = false;
        for (const btn of buttons) {
            const text = await page.evaluate(el => el.textContent, btn);
            if (text && text.includes('Gestures: OFF')) {
                console.log("Found Gestures: OFF button. Clicking...");
                await btn.click();
                clicked = true;
                break;
            }
        }
        if (!clicked) {
            console.log("Could not find button with 'Gestures: OFF'");
        }
    } catch (e) {
        console.log("Error clicking button: " + e.message);
    }
    
    // Wait 3 seconds
    console.log("Waiting 3 seconds after click...");
    await new Promise(r => setTimeout(r, 3000));
    
    // 6. Check camera permission
    // We used --use-fake-ui-for-media-stream, so it automatically accepts.
    
    // 7. Collect new console errors
    const postClickLogs = [...consoleLogs];
    
    // 8. Take a screenshot
    console.log("Taking screenshot...");
    await page.screenshot({ path: 'screenshot.png' });
    
    await browser.close();
    
    const report = {
        initialConsoleErrors: initialLogs,
        failedRequests: failedRequests,
        postClickConsoleErrors: postClickLogs,
        cameraPermission: "Auto-accepted via --use-fake-ui-for-media-stream"
    };
    
    fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
    console.log("DONE");
})();
