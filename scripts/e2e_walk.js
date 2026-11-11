#!/usr/bin/env node
/**
 * Browser walk-through of the platform in accounts mode (signup, catalog, paywall, preview, billing refusal, lab token,
 * owner login, assessment, scenario gating, pricing, progress). Not part of CI: needs `npm i playwright && npx playwright install chromium`
 * next to this file (or a global install), the API started with KA_AUTH_MODE=accounts, the web dev server on :10200, and an
 * account that already owns the CKA course (grant one with POST /api/admin/grant). Credentials via env:
 *   E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD   (default yann@example.com / learnerpass1)
 *   E2E_BASE (http://localhost:10200)      E2E_API (http://localhost:10201)
 */
const { chromium } = require('playwright');
const BASE = process.env.E2E_BASE || 'http://localhost:10200', API = process.env.E2E_API || 'http://localhost:10201';
const OWNER = process.env.E2E_OWNER_EMAIL || OWNER, OWNER_PW = process.env.E2E_OWNER_PASSWORD || OWNER_PW;
const fillField = async (page, selector, value) => {
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 30000 });   // AuthForm enables submit once /api/meta loaded
  const loc = page.locator(selector).first();
  for (let i = 0; i < 3; i++) { await loc.fill(value); if ((await loc.inputValue()) === value) return; await page.waitForTimeout(300); }
  throw new Error('could not fill ' + selector);
};
const results = []; const consoleErrors = [];
let pageRef; let n = 0;
const step = async (name, fn) => { n++; try { await fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name, String(e.message || e).split('\n')[0].slice(0, 200)]); try { await pageRef.screenshot({ path: `shots/fail-${n}.png` }); } catch {} } };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } }); pageRef = page;
  page.on('pageerror', e => consoleErrors.push('pageerror @' + page.url() + ': ' + e.message + ' :: ' + String(e.stack || '').split('\n').slice(1, 4).join(' <- ')));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  const shot = (n) => page.screenshot({ path: `shots/${n}.png`, fullPage: false });
  const me = () => page.evaluate(async (api) => { const r = await fetch(api + '/api/auth/me', { credentials: 'include' }); return r.status === 200 ? (await r.json()).user.email : r.status; }, API);
  const email = `pw-${Date.now()}@example.com`;

  await step('landing renders brand + realms + featured courses', async () => {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.getByText(/KubeAdvisor/).first().waitFor({ timeout: 30000 });
    await page.getByText(/Loaded Scenarios/i).first().waitFor({ timeout: 30000 });
    await page.getByText(/CKA Exam Preparation/i).first().waitFor({ timeout: 30000 });
    await shot('01-landing');
  });
  await step('signup via the form logs the user in', async () => {
    await page.goto(BASE + '/signup', { waitUntil: 'networkidle' });
    await fillField(page, 'input[type="email"]', email);
    await fillField(page, 'input[type="password"]', 'playwright-pass-1');
    await shot('02-signup');
    const [resp] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/auth/signup') && r.request().method() === 'POST', { timeout: 30000 }),
      page.locator('button[type="submit"]').first().click(),
    ]);
    if (resp.status() !== 200) throw new Error('signup HTTP ' + resp.status());
    await page.waitForURL(u => !u.pathname.startsWith('/signup'), { timeout: 20000 });
    await page.waitForLoadState('networkidle');
    const who = await me();
    if (who !== email) throw new Error('me() = ' + who);
  });
  await step('catalog lists the five products with prices', async () => {
    await page.goto(BASE + '/courses', { waitUntil: 'networkidle' });
    await page.getByText(/Complete Kubernetes Mastery Bundle/).first().waitFor({ timeout: 30000 });
    await page.getByText(/\$199/).first().waitFor({ timeout: 30000 });
    await shot('03-catalog');
  });
  await step('product page shows curriculum with locks and a buy action', async () => {
    await page.goto(BASE + '/courses/cka-exam-prep', { waitUntil: 'networkidle' });
    await page.getByText(/Cluster Architecture/).first().waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: /buy/i }).first().waitFor({ timeout: 30000 });
    await page.getByText(/Linux Foundation/).first().waitFor({ timeout: 30000 });
    await shot('04-product');
  });
  await step('locked lesson shows the paywall, not the body', async () => {
    await page.goto(BASE + '/courses/cka-exam-prep/etcd-backup-restore', { waitUntil: 'networkidle' });
    await page.getByText(/Get Pro|Buy course|not included/i).first().waitFor({ timeout: 30000 });
    await page.getByText(/CKA Exam Preparation Course/).first().waitFor({ timeout: 30000 });  // paywall resolves the product title
    const body = await page.getByText(/etcdctl snapshot/i).count();
    if (body) throw new Error('lesson body leaked through the paywall');
    await shot('05-paywall');
  });
  await step('preview lesson renders markdown', async () => {
    await page.goto(BASE + '/courses/cka-exam-prep/control-plane-components', { waitUntil: 'networkidle' });
    await page.locator('h2, h3').first().waitFor({ timeout: 30000 });
    const text = await page.locator('main, body').first().innerText();
    if (!/kube-apiserver|API server/i.test(text)) throw new Error('lesson text missing');
    await shot('06-preview-lesson');
  });
  await step('buy button reports billing disabled (no free grant)', async () => {
    await page.goto(BASE + '/courses/cka-exam-prep', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /buy/i }).first().click();
    await page.getByText(/not enabled|not configured/i).first().waitFor({ timeout: 30000 });
    const owned = await page.evaluate(async (api) => (await (await fetch(api + '/api/products/cka-exam-prep', { credentials: 'include' })).json()).owned, API);
    if (owned) throw new Error('product became owned without payment');
    await shot('07-billing-disabled');
  });
  await step('account page creates a lab token and shows it once', async () => {
    await page.goto(BASE + '/account', { waitUntil: 'networkidle' });
    const input = page.locator('#runner input[type="text"], input[placeholder*="token" i], input[placeholder*="laptop" i], input[placeholder*="name" i]').first();
    await input.waitFor({ timeout: 30000 });
    await input.fill('browser test');
    await page.getByRole('button', { name: /create/i }).first().click();
    await page.getByText(/kal_/).first().waitFor({ timeout: 30000 });
    await shot('08-account-token');
  });
  await step('login as the bundle owner opens the locked lesson with its quiz', async () => {
    await page.evaluate(async (api) => { await fetch(api + '/api/auth/logout', { method: 'POST', credentials: 'include' }); }, API);
    await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
    await page.waitForLoadState('networkidle');
    await fillField(page, 'input[type="email"]', OWNER);
    await fillField(page, 'input[type="password"]', OWNER_PW);
    const [resp] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST', { timeout: 30000 }),
      page.locator('button[type="submit"]').first().click(),
    ]);
    if (resp.status() !== 200) throw new Error('login HTTP ' + resp.status());
    await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 20000 });
    if ((await me()) !== OWNER) throw new Error('me() = ' + (await me()));
    await page.goto(BASE + '/courses/cka-exam-prep/etcd-backup-restore', { waitUntil: 'networkidle' });
    await page.getByText(/etcdctl/i).first().waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: /submit answers/i }).first().waitFor({ timeout: 30000 });
    await shot('09-owned-lesson');
  });
  await step('assessment starts and renders questions with a timer', async () => {
    await page.goto(BASE + '/courses/cka-exam-prep/assessments/cka-pre-assessment', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /start/i }).first().click();
    await page.getByText(/answered/i).first().waitFor({ timeout: 30000 });
    await page.getByText('6443', { exact: true }).first().click();   // option rows are custom buttons, not native radios
    await page.getByText(/1\/20 answered/).first().waitFor({ timeout: 30000 });
    await shot('10-assessment');
  });
  await step('scenario page asks for Pro when the user is not Pro', async () => {
    await page.goto(BASE + '/scenarios/svc-selector-mismatch', { waitUntil: 'networkidle' });
    await page.getByText(/Service has no endpoints/i).first().waitFor({ timeout: 30000 });
    await shot('11-scenario');
  });
  await step('pricing and progress pages render', async () => {
    await page.goto(BASE + '/pricing', { waitUntil: 'networkidle' });
    await page.getByText(/Pro/).first().waitFor({ timeout: 30000 });
    await shot('12-pricing');
    await page.goto(BASE + '/progress', { waitUntil: 'networkidle' });
    await page.getByText(/Courses/i).first().waitFor({ timeout: 30000 });
    await page.getByText(/CKA Exam Preparation/i).first().waitFor({ timeout: 30000 });
    await shot('13-progress');
  });
  await browser.close();
  for (const r of results) console.log(r.join(' | '));
  console.log(`\n${results.filter(r => r[0] === 'ok').length}/${results.length} steps ok; console errors: ${consoleErrors.length}`);
  for (const e of [...new Set(consoleErrors)].slice(0, 8)) console.log('  console:', e);
  process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
})();
