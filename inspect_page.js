const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  const consoleMessages = [];
  const networkErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleMessages.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
    }
  });

  page.on('response', response => {
    if (response.status() >= 400) {
      networkErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto('https://palmplay-music.vercel.app/app', { waitUntil: 'networkidle0' });
  
  // wait at least 3 seconds additional
  await new Promise(r => setTimeout(r, 3000));

  let gestureButtonPresent = false;
  try {
    const hasButton = await page.evaluate(() => {
      // Trying to find anything related to gesture or button
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.some(b => b.textContent.toLowerCase().includes('gesture') || b.id.toLowerCase().includes('gesture') || b.className.toLowerCase().includes('gesture'));
    });
    gestureButtonPresent = hasButton;
  } catch (e) {
    consoleMessages.push(`[SCRIPT ERROR] Failed to check for gesture button: ${e.message}`);
  }

  await page.screenshot({ path: 'C:\\Users\\aml\\.gemini\\antigravity\\brain\\17e35bd6-51e2-4473-b47d-3dbdb6048f2e\\screenshot.png' });

  const report = {
    consoleErrorsAndWarnings: consoleMessages,
    networkErrors: networkErrors,
    gestureButtonPresent: gestureButtonPresent,
    screenshotSavedTo: 'C:\\Users\\aml\\.gemini\\antigravity\\brain\\17e35bd6-51e2-4473-b47d-3dbdb6048f2e\\screenshot.png'
  };

  fs.writeFileSync('C:\\Users\\aml\\.gemini\\antigravity\\brain\\17e35bd6-51e2-4473-b47d-3dbdb6048f2e\\report.json', JSON.stringify(report, null, 2));

  await browser.close();
})();
