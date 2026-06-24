const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
const { startTestServer } = require('../helpers/testServer');

const PORT = 3505;
let server;
let browser;

before(async () => {
  server = await startTestServer(PORT);
  browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
});

after(async () => {
  await browser.close();
  await server.stop();
});

async function newPage() {
  const context = await browser.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
  const page = await context.newPage();
  await page.goto(server.baseUrl);
  return { context, page };
}

test('full mobile flow: consent, match, mute, chat — no console errors', async () => {
  const consoleErrors = [];
  const peer1 = await newPage();
  const peer2 = await newPage();
  peer1.page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`peer1: ${m.text()}`);
  });
  peer2.page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`peer2: ${m.text()}`);
  });

  try {
    await peer1.page.click('#consentCheckbox');
    await peer2.page.click('#consentCheckbox');
    await peer1.page.click('#startBtn');
    await peer2.page.click('#startBtn');

    await peer1.page.waitForSelector('#status:has-text("Connected")', { timeout: 10000 });
    await peer2.page.waitForSelector('#status:has-text("Connected")', { timeout: 10000 });

    // Mute toggles the local track's enabled state, not just a CSS class.
    await peer1.page.click('#muteBtn');
    const isMuted = await peer1.page.evaluate(() => document.getElementById('muteBtn').classList.contains('is-muted'));
    assert.equal(isMuted, true);

    // Chat round-trips through the real relay, not just appended locally.
    await peer1.page.click('#chatToggleBtn');
    await peer1.page.fill('#chatInput', 'integration test message');
    await peer1.page.click('.send-btn');
    await peer2.page.waitForFunction(
      () => document.getElementById('chatLog').textContent.includes('integration test message'),
      { timeout: 5000 }
    );

    assert.deepEqual(consoleErrors, [], `expected no console errors, got: ${consoleErrors.join(' | ')}`);
  } finally {
    await peer1.context.close();
    await peer2.context.close();
  }
});
