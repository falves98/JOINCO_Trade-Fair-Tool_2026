// End-to-end test of the standalone server: login, capture, AI analysis (against a mock
// Anthropic endpoint), review, confirm, multi-user visibility, team admin, CSV export, auth.
// Usage: node tests/e2e_server.js <outdir>
const { chromium } = require(process.env.PW || '/opt/node-tools/node_modules/playwright');
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { spawn } = require('child_process');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'jsi-'));
fs.mkdirSync(OUT, { recursive: true });
const ROOT = path.join(__dirname, '..');

const AI = { images: [{ n: 1, kind: 'business_card', note: 'Card' }, { n: 2, kind: 'product', note: 'Glass tumbler' }],
  supplier: { name: { v: 'Guangzhou Clearview Glassware Co., Ltd.', src: 'observed', ev: 'img 1' }, country: { v: 'China', src: 'inference', ev: '+86' }, address: { v: null }, website: { v: 'www.clearview-glass.cn', src: 'observed', ev: 'img 1' }, businessType: { v: 'unknown' } },
  contacts: [{ name: { v: 'Evelyn Li', src: 'observed', ev: 'img 1' }, role: { v: 'Export Manager', src: 'observed', ev: 'img 1' }, email: { v: 'evelyn@clearview-glass.cn', src: 'observed', ev: 'img 1' }, phone: { v: '+86 20 8913 0000', src: 'observed', ev: 'img 1' }, whatsapp: { v: null } }],
  products: [{ category: { v: 'Hobnail glass tumbler', src: 'observed', ev: 'img 2' }, description: { v: 'Green textured tumbler', src: 'observed', ev: 'img 2' }, specs: { v: null }, materials: { v: 'Soda-lime glass', src: 'inference', ev: 'img 2' }, packaging: { v: null }, certifications: { v: null }, moq: { v: null }, price: { v: null }, currency: { v: null }, incoterm: { v: null }, oem: { v: 'unknown' }, score: 61, score_rationale: 'Trendy design, no commercial terms yet.' }],
  before_you_leave: [{ item: 'Ask FOB price at 2,000 pcs', why: 'No price', priority: 'high' }], summary: 'Glassware maker.' };

let lastReq = null;
const mock = http.createServer((req, res) => {
  const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => {
    lastReq = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(ch).toString() || '{}') };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: lastReq.body.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(AI) + '\n```' }], usage: { input_tokens: 1000, output_tokens: 500 } }));
  });
}).listen(0);

(async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jsi-data-'));
  const srv = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT: port, DATA_DIR: data, INSECURE_COOKIE: '1',
    ADMIN_EMAIL: 'francisco@joinco.test', ADMIN_PASSWORD: 'admin-pass-123', ADMIN_NAME: 'Francisco Alves',
    ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '' } });
  srv.stdout.on('data', d => process.stdout.write('[server] ' + d)); srv.stderr.on('data', d => process.stdout.write('[server!] ' + d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) process.exitCode = 1; };

  check((await fetch(base + '/api/db/visits')).status === 401, 'API rejects requests without login');
  check((await fetch(base + '/', { redirect: 'manual' })).status === 302, 'app page redirects to /login when signed out');
  check((await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ email: 'francisco@joinco.test', password: 'wrong' }) })).status === 401, 'wrong password rejected');

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/fonts|jszip|cdnjs|ERR_/.test(m.text())) errors.push(m.text()); });
  await page.goto(base + '/');
  await page.fill('#email', 'francisco@joinco.test'); await page.fill('#pw', 'admin-pass-123'); await page.click('#go');
  await page.waitForSelector('text=No booth visits yet');
  check(true, 'admin signs in and sees empty visits list');

  const files = [];
  for (const [i, label] of ['EVELYN LI  CFTC', 'GREEN TUMBLER'].entries()) {
    const b64 = await page.evaluate(l => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const g = c.getContext('2d'); g.fillStyle = '#cfd8c4'; g.fillRect(0, 0, 1600, 1200); g.fillStyle = '#111'; g.font = 'bold 90px sans-serif'; g.fillText(l, 80, 600); return c.toDataURL('image/jpeg').split(',')[1]; }, label);
    const f = path.join(OUT, `s${i}.jpg`); fs.writeFileSync(f, Buffer.from(b64, 'base64')); files.push(f);
  }
  const t0 = Date.now();
  await page.click('.fab'); await page.fill('#c-fair', 'Canton Fair Ph.2'); await page.setInputFiles('#lib', files);
  await page.waitForFunction(() => document.querySelectorAll('.shot .n').length === 2, null, { timeout: 15000 });
  check(await page.$('[data-act="analyse"]') != null, 'Analyse button is available (photo analysis supported)');
  await page.click('[data-act="analyse"]');
  await page.waitForSelector('text=Before you leave the booth', { timeout: 15000 });
  const b = lastReq.body; const imgs = b.messages[0].content.filter(c => c.type === 'image');
  check(lastReq.headers['x-api-key'] === 'test-key', 'API key sent from server only');
  check(b.model === 'claude-opus-5-5' && imgs.length === 2 && imgs[0].source.media_type === 'image/jpeg', `one Claude call with all ${imgs.length} photos (model ${b.model})`);
  check(b.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(lastReq.headers['anthropic-beta'] || ''), 'refusal fallback enabled');
  const html = await page.content(); check(!/test-key/.test(html), 'API key never reaches the browser');
  await page.fill('#f-products-0-price', '0.95'); await page.fill('#f-products-0-currency', 'USD');
  await page.click('[data-act="confirm"]'); await page.waitForSelector('text=Captured by');
  console.log(`  capture→analyse→confirm (automated): ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.screenshot({ path: path.join(OUT, 'server-visit.png'), fullPage: true });

  const api = async p => page.evaluate(async p => (await fetch(p)).json(), p);
  const [sup, con, pro, vis, img] = await Promise.all(['suppliers', 'contacts', 'products', 'visits', 'images'].map(c => api('/api/db/' + c)));
  check(sup.docs.length === 1 && con.docs.length === 1 && pro.docs.length === 1 && vis.docs.length === 1 && img.docs.length === 2, 'all five tables written after confirm');
  check(pro.docs[0].data.price === '0.95' && pro.docs[0].data.prov.price.src === 'buyer', 'buyer edit kept, source tag = buyer note');
  const blobOk = await page.evaluate(async id => (await fetch('/_blob/' + id)).headers.get('content-type'), img.docs[0].data.assetId);
  check(blobOk === 'image/jpeg', 'photos served from storage');

  // team admin: add a second buyer
  await page.click('[data-act="go"][data-to="export"]');
  await page.waitForSelector('#t-email');
  await page.fill('#t-name', 'Ana Buyer'); await page.fill('#t-email', 'ana@joinco.test'); await page.fill('#t-pw', 'ana-pass-123');
  await page.click('[data-act="teamadd"]'); await page.waitForSelector('text=Added Ana Buyer');
  check(true, 'admin adds a buyer from the Team section');
  const dl = page.waitForEvent('download'); await page.click('[data-act="exportone"][data-t="products"]'); const d = await dl;
  const csvPath = path.join(OUT, d.suggestedFilename()); await d.saveAs(csvPath);
  check(/Hobnail glass tumbler/.test(fs.readFileSync(csvPath, 'utf8')), 'CSV export downloads (' + d.suggestedFilename() + ')');

  // second buyer, separate browser session, sees shared data
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p2 = await ctx2.newPage();
  await p2.goto(base + '/login'); await p2.fill('#email', 'ana@joinco.test'); await p2.fill('#pw', 'ana-pass-123'); await p2.click('#go');
  await p2.waitForSelector('text=Guangzhou Clearview');
  check(true, 'second buyer sees the shared visit');
  check(!(await p2.$('#t-email')), 'non-admin has no team controls');
  const forb = await p2.evaluate(async () => (await fetch('/api/users')).status);
  check(forb === 403, 'non-admin cannot manage users');
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close(); srv.kill(); mock.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
