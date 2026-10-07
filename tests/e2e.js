// End-to-end test of the primary workflow against a mocked claude runtime.
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs'), path = require('path'), http = require('http');
const APP = fs.readFileSync(process.argv[2], 'utf8');
const OUT = process.argv[3];
const blobs = new Map();

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/_upload/')) { const id = req.url.split('/')[2]; const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => { blobs.set(id, Buffer.concat(ch)); res.end('ok'); }); return; }
  if (req.url.startsWith('/_blob/')) { const b = blobs.get(req.url.split('/')[2]); if (!b) { res.statusCode = 404; return res.end(); } res.setHeader('content-type', 'image/jpeg'); return res.end(b); }
  res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + APP + '</body></html>');
}).listen(0);

const MOCK = `(() => {
  const store = {}; const subs = new Set(); let n = 0;
  const colOf = p => p.split('/').slice(0, -1).join('/');
  const notify = () => setTimeout(() => subs.forEach(s => s()), 5);
  function snapDoc(path) { const d = store[path]; return { id: path.split('/').pop(), exists: !!d, data: () => d && JSON.parse(JSON.stringify(d)), metadata: {} }; }
  function query(col, filters = [], ord = null, lim = 1000) {
    const q = {
      where: (f, op, v) => query(col, [...filters, [f, op, v]], ord, lim), orderBy: (f, d = 'asc') => query(col, filters, [f, d], lim), limit: l => query(col, filters, ord, l),
      async get() { return run(); },
      onSnapshot(next) { const s = () => next(run()); subs.add(s); setTimeout(s, 10); return () => subs.delete(s); },
    };
    function run() { let docs = Object.keys(store).filter(p => colOf(p) === col).map(snapDoc);
      if (ord) docs.sort((a, b) => { const x = a.data()[ord[0]], y = b.data()[ord[0]]; if (x === y) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : 1) * (ord[1] === 'desc' ? -1 : 1); });
      docs = docs.slice(0, lim); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} }; }
    return q;
  }
  function docRef(path) { return { id: path.split('/').pop(), path,
    async get() { return snapDoc(path); },
    async set(d) { store[path] = JSON.parse(JSON.stringify(d)); window.__writes = (window.__writes || 0) + 1; notify(); },
    async update(d) { if (!store[path]) throw { code: 'invalid_argument', message: 'missing ' + path }; Object.assign(store[path], JSON.parse(JSON.stringify(d))); notify(); },
    async delete() { delete store[path]; notify(); } }; }
  const db = { doc: docRef, collection: col => Object.assign(query(col), { path: col, doc: id => docRef(col + '/' + (id || ('m' + (++n) + Math.random().toString(36).slice(2, 8)))) }) };
  window.__store = store;
  const assets = { async upload(blob) { const id = (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2) + '00000000000000000000000000000000').slice(0, 32); await fetch('/_upload/' + id, { method: 'POST', body: blob }); return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: blob.type }; }, async delete() { return { deleted: true }; }, async list() { return { assets: [] }; } };
  const AI = ${JSON.stringify({
    images: [{ n: 1, kind: 'business_card', note: 'Business card of sales manager' }, { n: 2, kind: 'product', note: 'Bamboo cutlery set on display' }, { n: 3, kind: 'handwritten', note: 'Price note' }],
    supplier: { name: { v: 'Xiamen Greenleaf Bamboo Products Co., Ltd.', src: 'observed', ev: 'img 1, business card' }, country: { v: 'China', src: 'inference', ev: '+86 phone prefix, Xiamen address' }, address: { v: 'No. 88 Haicang Rd, Xiamen, Fujian', src: 'observed', ev: 'img 1' }, website: { v: 'www.greenleaf-bamboo.com', src: 'observed', ev: 'img 1' }, businessType: { v: 'manufacturer', src: 'claim', ev: 'img 1 card says "Factory"' } },
    contacts: [{ name: { v: 'Lily Chen', src: 'observed', ev: 'img 1' }, role: { v: 'Sales Manager', src: 'observed', ev: 'img 1' }, email: { v: 'lily@greenleaf-bamboo.com', src: 'observed', ev: 'img 1' }, phone: { v: '+86 592 555 0188', src: 'observed', ev: 'img 1' }, whatsapp: { v: null } }],
    products: [{ category: { v: 'Bamboo cutlery set', src: 'observed', ev: 'img 2' }, description: { v: '4-piece travel cutlery in cotton pouch', src: 'observed', ev: 'img 2' }, specs: { v: '19 cm', src: 'claim', ev: 'img 3' }, materials: { v: 'Moso bamboo', src: 'claim', ev: 'img 2 label' }, packaging: { v: 'Cotton pouch', src: 'observed', ev: 'img 2' }, certifications: { v: 'FSC, LFGB', src: 'claim', ev: 'img 2 sign logos' }, moq: { v: '3000 sets', src: 'claim', ev: 'img 3 handwritten' }, price: { v: '0.85', src: 'claim', ev: 'img 3' }, currency: { v: 'USD', src: 'claim', ev: 'img 3' }, incoterm: { v: null }, oem: { v: 'yes', src: 'claim', ev: 'img 2 sign: OEM welcome' }, score: 74, score_rationale: 'Popular eco item with OEM and clear price, certificates unproven.' }],
    before_you_leave: [{ item: 'Ask the Incoterm and port for the 0.85 USD price', why: 'Price has no Incoterm', priority: 'high' }, { item: 'Request FSC certificate copy', why: 'Only a logo was seen', priority: 'medium' }, { item: 'Get WhatsApp of Lily', why: 'No WhatsApp found', priority: 'low' }],
    summary: 'Bamboo kitchen and travel cutlery factory offering OEM.' })};
  const sample = Object.assign(async () => ({ text: 'x' }), {
    async json(prompt, opts) { window.__prompt = prompt; window.__imgCount = opts.images.length; await new Promise(r => setTimeout(r, 300)); opts.onText && opts.onText({ text: JSON.stringify(AI), delta: '' }); return JSON.parse(JSON.stringify(AI)); },
    async limits() { return { maxPromptBytes: 262144, images: { maxCount: 20, maxInputBytes: 20e6, mediaTypes: ['image/jpeg', 'image/png'] } }; } });
  const user = { async me() { return { id: 'u1', name: 'Francisco Alves' }; }, async id() { return 'u1'; }, async can() { return true; }, async isOwner() { return true; }, async canEdit() { return true; }, async profiles(ids) { return Object.fromEntries([].concat(ids).map(i => [i, { id: i, name: i === 'u1' ? 'Francisco Alves' : 'Colleague' }])); } };
  window.__downloads = [];
  const downloads = { async save({ filename, data }) { const txt = typeof data === 'string' ? data : '[blob ' + (data.size || 0) + ' bytes]'; window.__downloads.push({ filename, txt }); return { status: 'saved' }; } };
  const caps = { db, assets, sample, user, downloads };
  window.claude = { use: async name => (await new Promise(r => setTimeout(r, 20)), caps[name] || null) };
})();`;

(async () => {
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(MOCK);
  await page.goto(`http://localhost:${port}/`);

  await page.waitForSelector('text=No booth visits yet');
  await page.screenshot({ path: path.join(OUT, '1-empty.png') });
  const t0 = Date.now();

  // make 3 test photos
  const files = [];
  for (const [i, label] of ['BUSINESS CARD  Lily Chen', 'BAMBOO CUTLERY', 'USD 0.85 / MOQ 3000'].entries()) {
    const b64 = await page.evaluate(label => { const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d'); g.fillStyle = '#d9c9a3'; g.fillRect(0, 0, 1200, 800); g.fillStyle = '#222'; g.font = 'bold 70px sans-serif'; g.fillText(label, 60, 400); return c.toDataURL('image/jpeg').split(',')[1]; }, label);
    const f = path.join(OUT, `photo${i + 1}.jpg`); fs.writeFileSync(f, Buffer.from(b64, 'base64')); files.push(f);
  }
  await page.click('.fab');
  await page.waitForSelector('text=Take photo');
  await page.fill('#c-fair', 'Canton Fair Ph.2');
  await page.fill('#c-booth', '9.2 F31');
  await page.setInputFiles('#lib', files);
  await page.waitForFunction(() => document.querySelectorAll('.shot .n').length === 3, null, { timeout: 15000 });
  await page.fill('#c-notes', 'Liked the travel set, asked for EU price list');
  await page.screenshot({ path: path.join(OUT, '2-capture.png') });
  await page.click('[data-act="analyse"]');
  await page.waitForSelector('text=Before you leave the booth', { timeout: 15000 });
  console.log('images sent to AI:', await page.evaluate(() => window.__imgCount));
  await page.screenshot({ path: path.join(OUT, '3-review.png'), fullPage: true });

  // master tables must still be empty before confirmation
  const pre = await page.evaluate(() => Object.keys(window.__store).map(k => k.split('/')[0]).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {}));
  console.log('before confirm:', JSON.stringify(pre));
  if (pre.suppliers || pre.contacts || pre.products) throw new Error('AI data leaked into master tables before confirmation');

  // edit: fix the price, add whatsapp, change a source tag, tick a BYL item with an answer
  await page.fill('#f-products-0-price', '0.82');
  await page.fill('#f-contacts-0-whatsapp', '+86 138 0000 1111');
  await page.click('[data-path="contacts.0.whatsapp"]'); // cycles source tag
  await page.fill('#byl-0', 'FOB Xiamen');
  await page.click('[data-act="byl"][data-i="0"]');
  await page.click('[data-act="confirm"]');
  await page.waitForSelector('text=Captured by', { timeout: 10000 });
  console.log('workflow time (automated):', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  await page.screenshot({ path: path.join(OUT, '4-visit.png'), fullPage: true });

  const st = await page.evaluate(() => window.__store);
  const by = c => Object.entries(st).filter(([k]) => k.startsWith(c + '/')).map(([k, v]) => ({ id: k, ...v }));
  const sup = by('suppliers'), con = by('contacts'), prod = by('products'), vis = by('visits'), img = by('images');
  console.log('counts', { suppliers: sup.length, visits: vis.length, contacts: con.length, products: prod.length, images: img.length });
  console.log('supplier', sup[0].name, sup[0].country, sup[0].prov.country.src, sup[0].businessType);
  console.log('contact', con[0].name, con[0].whatsapp, 'wa src:', con[0].prov.whatsapp.src);
  console.log('product', prod[0].category, prod[0].price, prod[0].currency, 'price src:', prod[0].prov.price.src, 'score', prod[0].score, prod[0].scoreSrc);
  console.log('visit', vis[0].status, vis[0].fair, vis[0].booth, 'byl0', JSON.stringify(vis[0].beforeYouLeave[0]));
  console.log('image kinds in display order', img.sort((a,b)=>a.takenAt.localeCompare(b.takenAt)||a.seq-b.seq).map(i => i.kind).join(','));

  // second visit to same supplier -> match detection
  await page.click('[data-act="go"][data-to="visits"]');
  await page.click('.fab');
  await page.setInputFiles('#lib', files.slice(0, 1));
  await page.waitForFunction(() => document.querySelectorAll('.shot .n').length === 1);
  await page.click('[data-act="analyse"]');
  await page.waitForSelector('text=Saving to existing supplier');
  await page.click('[data-act="confirm"]');
  await page.waitForSelector('text=Captured by');
  const st2 = await page.evaluate(() => window.__store);
  console.log('suppliers after 2nd visit to same supplier:', Object.keys(st2).filter(k => k.startsWith('suppliers/')).length);

  // lists + export
  await page.click('[data-act="go"][data-to="suppliers"]');
  await page.screenshot({ path: path.join(OUT, '5-suppliers.png') });
  await page.click('[data-act="go"][data-to="products"]');
  await page.screenshot({ path: path.join(OUT, '6-products.png') });
  await page.click('[data-act="go"][data-to="export"]');
  await page.click('[data-act="exportone"][data-t="products"]');
  await page.click('[data-act="exportone"][data-t="visits"]');
  await page.waitForFunction(() => window.__downloads.length === 2);
  const dl = await page.evaluate(() => window.__downloads);
  console.log('downloads', dl.map(d => d.filename).join(', '));
  console.log('products.csv:\n' + dl[0].txt.split('\r\n').slice(0, 3).join('\n').slice(0, 900));
  await page.screenshot({ path: path.join(OUT, '7-export.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('[data-act="go"][data-to="visits"]');
  await page.screenshot({ path: path.join(OUT, '8-visits-dark.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log('horizontal overflow:', overflow);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close(); server.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
