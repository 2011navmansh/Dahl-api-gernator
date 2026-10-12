/* ============================================================
   API EXTRACTOR v3 (merged) — inference.dahl.global (Dahl)
   One-click signup -> username/api/fingerprint capture ->
   100.0M token allocate -> apis.txt (APPEND, kabhi delete nahi) ->
   deep clear -> repeat

   Educational purpose only. User hi khud test karega (start.bat).

   FIX SET A (v2 — click/capture robustness):
   - apis.txt kabhi truncate nahi; numbering aakhri acc se continue
   - CREATE ACCOUNT 3x retry + real mouse click (JS fallback)
   - API key background-safe order: download file -> network sniff ->
     clipboard (sirf jab focused); bringToFront HATA (restore karta tha)
   - continueOnError + screenshots

   FIX SET B (documented: "BUG FIXES (v2)" section in info.txt):
   - minimize: retry loop + IsIconic verify + stable check + DUSRA
     minimize call (insurance) after first page load
   - overwriteOutput=true pe HAMESHA timestamped backup pehle
   - deep clear: cookies + browser cache + Storage.clearDataForOrigin
     + localStorage/sessionStorage (har account ke baad)
   - ensureSignedOut(): har account se pehle signed-out verify,
     signed-in mile toh 3 baar deep clear + reload
   - duplicate username guard: prefill apis.txt me hai toh Regenerate
   - HTTP 4xx/5xx BODY logging ("NET: HTTP ...") + dialog text on
     fail ("DIALOG: ...") -> agli baar exact server error dikhega
   - partial capture bhi likha jata hai (MISSING marker), khali throw nahi
   - maxConsecutiveFailures=3, betweenAccountDelayMs=4000
   ============================================================ */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------- config ----------------
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const OUTPUT_PATH = path.join(__dirname, CONFIG.outputFile || 'apis.txt');
const DEBUG_DIR = path.join(__dirname, 'debug');
const STEP_DELAY = CONFIG.stepDelayMs ?? 700;
const BETWEEN_ACC_DELAY = CONFIG.betweenAccountDelayMs ?? 4000;
const MAX_CONSEC_FAILS = CONFIG.maxConsecutiveFailures ?? 3;
const TIMEOUT = (CONFIG.timeoutMs ?? 40) * 1000;

const sniffedKeys = [];   // network se mile hue api keys (fallback)
const httpErrors = [];    // 4xx/5xx (URL + body snippet) — error hints
let browserPid = null;
let minimizeCalls = 0;

// ---------------- helpers ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString();
const log = (m) => console.log(`[${ts()}] ${m}`);

// purani file se next acc number (numbering kabhi duplicate/gap nahi)
function nextAccNumber() {
  let max = 0;
  try {
    const txt = fs.readFileSync(OUTPUT_PATH, 'utf8');
    for (const m of txt.matchAll(/^acc(\d+)\s*$/gm)) max = Math.max(max, parseInt(m[1], 10));
  } catch (e) { /* file nahi hai */ }
  return max + 1;
}

function usernameExists(name) {
  if (!name) return false;
  try {
    return fs.readFileSync(OUTPUT_PATH, 'utf8').includes(`username=${name}`);
  } catch (e) {
    return false;
  }
}

function errHint() {
  if (!httpErrors.length) return '';
  return ` | HTTP errors: ${httpErrors.slice(-2).join(' ; ')}`;
}

async function waitForText(page, text, timeout = TIMEOUT) {
  await page.waitForFunction(
    (t) => (document.body?.innerText || '').includes(t),
    { timeout },
    text
  );
}

async function waitTextOptional(page, text, timeout = 15000) {
  try {
    await waitForText(page, text, timeout);
    return true;
  } catch (e) {
    return false;
  }
}

async function isVisible(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!(el && el.offsetParent !== null && el.getClientRects().length);
  }, sel);
}

// text se element dhoondh ke ASLI mouse click (JS click fallback)
async function clickByText(page, text, opts = {}) {
  const { exact = true, selector = 'button, a, [role="button"]', insideText = null, ci = true } = opts;
  const handle = await page.evaluateHandle((a) => {
    const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
    let scope = document;
    if (a.insideText) {
      const dlgs = [...document.querySelectorAll('[role="dialog"]')];
      const d = dlgs.find((x) => norm(x.innerText).includes(a.insideText));
      if (!d) return null;
      scope = d;
    }
    const els = [...scope.querySelectorAll(a.selector)];
    return (
      els.find((e) => {
        const t = norm(e.innerText);
        if (!t) return false;
        if (a.exact) return a.ci ? t.toLowerCase() === a.text.toLowerCase() : t === a.text;
        return a.ci ? t.toLowerCase().includes(a.text.toLowerCase()) : t.includes(a.text);
      }) || null
    );
  }, { text, exact, selector, insideText, ci });

  const el = handle.asElement();
  if (!el) {
    await handle.dispose().catch(() => {});
    throw new Error(`click("${text}") fail: not-found`);
  }
  try {
    await el.click({ delay: 60 });
  } catch (e) {
    try {
      await el.evaluate((n) => n.click());
    } catch (e2) { /* dono fail */ }
  }
  await handle.dispose().catch(() => {});
}

async function screenshot(page, name) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const p = path.join(DEBUG_DIR, name);
    await page.screenshot({ path: p, fullPage: true });
    log(`Screenshot save: ${p}`);
  } catch (e) { /* ignore */ }
}

// fail hone pe site ka exact dialog text console me (debug ke liye)
async function logDialogText(page) {
  try {
    const t = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return d ? (d.innerText || '').replace(/\n+/g, ' | ').slice(0, 500) : '(dialog nahi mila)';
    });
    log(`DIALOG: ${t}`);
  } catch (e) { /* ignore */ }
}

// ---------------- clipboard / download / sniff ----------------
async function readClipboard(page) {
  for (let i = 0; i < 4; i++) {
    try {
      const v = await page.evaluate(() => navigator.clipboard.readText());
      if (v && v.trim()) return v.trim();
    } catch (e) { /* retry */ }
    await sleep(350);
  }
  return '';
}

// sirf tab jab window focused ho (unfocused clipboard fail hota hai)
async function copyFromDialog(page, index) {
  const buttons = await page.$$('[role="dialog"] button[aria-label="Copy"]');
  if (buttons.length <= index) return '';
  await buttons[index].click();
  await sleep(350);
  return readClipboard(page);
}

// "DOWNLOAD AS .TXT" — background/minimized me bhi chalta hai
async function apiKeyFromDownload(page) {
  const dir = path.join(__dirname, 'tmp_download');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const client = await page.createCDPSession();
    try {
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    } catch (e) {
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }).catch(() => {});
    }
    await clickByText(page, 'DOWNLOAD AS .TXT', { exact: false, insideText: 'Save your fingerprint' });
    log('DOWNLOAD AS .TXT click (file fallback)...');

    const deadline = Date.now() + 15000;
    let file = null;
    while (Date.now() < deadline) {
      const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      if (files.length) { file = files[0]; break; }
      await sleep(300);
    }
    if (!file) return '';

    // file ka size stable hone tak wait (adhoori read na ho)
    let last = -1;
    for (let i = 0; i < 10; i++) {
      const sz = fs.statSync(path.join(dir, file)).size;
      if (sz === last && sz > 0) break;
      last = sz;
      await sleep(400);
    }

    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    const m = content.match(/dahl_[A-Za-z0-9._-]{6,}/);
    return m ? m[0] : '';
  } catch (e) {
    log(`download fallback warn: ${e.message}`);
    return '';
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

// sniff keys + HTTP 4xx/5xx body logging (console: "NET: HTTP ...")
function attachSniffer(page) {
  const host = new URL(CONFIG.url).host;
  page.on('response', async (res) => {
    try {
      const u = res.url();
      const st = res.status();
      if (st >= 400 && u.includes(host)) {
        let snippet = '';
        try {
          const ct = res.headers()['content-type'] || '';
          if (/json|text/.test(ct)) snippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
        } catch (e) { /* body nahi mili */ }
        const entry = `${st} ${res.request().method()} ${new URL(u).pathname} ${snippet}`.trim();
        httpErrors.push(entry);
        log(`NET: HTTP ${entry}`);
      }
      const ct = res.headers()['content-type'] || '';
      if (!/json|text/.test(ct)) return;
      const body = await res.text();
      const m = body.match(/dahl_[A-Za-z0-9]{8,}/g);
      if (m) for (const k of m) if (!sniffedKeys.includes(k)) sniffedKeys.push(k);
    } catch (e) { /* ignore */ }
  });
}

// ---------------- DEEP CLEAR (cookies + cache + storage) ----------------
async function deepClear(page) {
  try {
    const client = await page.createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    try {
      const origin = new URL(CONFIG.url).origin;
      await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    } catch (e) { /* origin invalid ho sakti hai */ }
  } catch (e) {
    log(`deep clear warn: ${e.message}`);
  }
  try {
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
}

// har account se pehle signed-out confirm — signed-in mile toh 3x clear
async function ensureSignedOut(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const state = await page.evaluate(() => ({
      signedIn: document.documentElement.getAttribute('data-signed-in') === '1',
      hasGuestLink: !!document.querySelector('a[data-auth="guest"]'),
    }));
    if (!state.signedIn && state.hasGuestLink) return; // guest state OK
    log(`Signed-in state mila (attempt ${attempt}) → deep clear...`);
    await deepClear(page);
  }
  await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const still = await page.evaluate(() => document.documentElement.getAttribute('data-signed-in') === '1');
  if (still) throw new Error('Signed-out confirm nahi ho paya (session clear fail)' + errHint());
}

// ---------------- window minimize (Windows) ----------------
function minimizeWindow() {
  if (!CONFIG.startMinimized || process.platform !== 'win32') return;
  if (minimizeCalls >= 2) return; // max 2 baar: launch + insurance
  if (!browserPid) { log('minimize: browser pid nahi mila'); return; }
  minimizeCalls++;
  try {
    const ps = path.join(__dirname, 'minimize.ps1');
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-ProcessId', String(browserPid)],
      { windowsHide: true }
    );
    child.on('exit', (code) => {
      if (code === 0) log(`Minimize OK (#${minimizeCalls}) — taskbar click = full maximized.`);
      else log(`minimize warn #${minimizeCalls} (code ${code}) — window maximized ho sakti hai`);
    });
    child.on('error', (e) => log(`minimize error: ${e.message}`));
  } catch (e) {
    log(`minimize skip: ${e.message}`);
  }
}

// ---------------- apis.txt (sirf APPEND; overwrite=true pe pehle backup) ----------------
function prepareOutputFile() {
  if (CONFIG.overwriteOutput && fs.existsSync(OUTPUT_PATH) && fs.statSync(OUTPUT_PATH).size > 0) {
    const backup = path.join(__dirname, `apis.backup-${Date.now()}.txt`);
    fs.copyFileSync(OUTPUT_PATH, backup);
    log(`overwriteOutput=true → purana data BACKUP me: ${backup}`);
    fs.writeFileSync(OUTPUT_PATH, '', 'utf8');
  }
}

function writeAccountBlock(n, data) {
  const block =
    `acc${n}\n` +
    `username=${data.username || 'MISSING'}\n` +
    `api=${data.api || 'MISSING'}\n` +
    `fingerprint=${data.fingerprint || 'MISSING'}\n`;
  let prefix = '';
  try {
    if (fs.existsSync(OUTPUT_PATH) && fs.statSync(OUTPUT_PATH).size > 0) prefix = '\n';
  } catch (e) { /* ignore */ }
  fs.appendFileSync(OUTPUT_PATH, prefix + block, 'utf8');
  const missing = [!data.api && 'api', !data.fingerprint && 'fingerprint'].filter(Boolean);
  if (missing.length) log(`apis.txt me acc${n} save (partial: ${missing.join(', ')} = MISSING).`);
  else log(`apis.txt me acc${n} save ho gaya.`);
}

// ============================================================
// PHASE A: signup + capture (throw sirf tab jab kuch bhi na mila)
// ============================================================
async function captureSignup(page) {
  minimizeWindow(); // insurance call (first page load ke baad)

  // 1. signed-out confirm + goto
  await ensureSignedOut(page);

  await waitForText(page, 'SIGN IN');
  await sleep(STEP_DELAY);

  // 2. SIGN IN click
  await clickByText(page, 'SIGN IN', { selector: 'a' });
  log('SIGN IN click kiya.');

  // popup wait: Welcome back ya Create your account
  const popupUp = await page
    .waitForFunction(() => {
      const t = document.body?.innerText || '';
      return t.includes('Welcome back') || t.includes('Create your account');
    }, { timeout: TIMEOUT })
    .then(() => true)
    .catch(() => false);
  if (!popupUp) {
    await logDialogText(page);
    throw new Error('Sign-in popup nahi khula' + errHint());
  }
  await sleep(1000); // island hydration

  // 3. Create form available? nahi toh welcome popup se "Create account"
  if (!(await isVisible(page, '#signup-username'))) {
    if (await isVisible(page, '#signin-fingerprint')) {
      await clickByText(page, 'Create account', { selector: 'button', insideText: 'Welcome back' });
      log('"Create account" click (welcome popup se).');
    }
    await page.waitForSelector('#signup-username', { visible: true, timeout: TIMEOUT });
  }

  let username = (await page.$eval('#signup-username', (el) => el.value)).trim();
  if (!username) throw new Error('username input khali hai');

  // duplicate username guard: purani file me hai toh Regenerate (3x)
  if (usernameExists(username)) {
    for (let r = 1; r <= 3; r++) {
      log(`Username "${username}" pehle se file me hai → Regenerate (${r}/3)...`);
      const clicked = await page.evaluate(() => {
        const b =
          document.querySelector('[role="dialog"] button[aria-label="Regenerate"]') ||
          document.querySelector('button[aria-label="Regenerate"]');
        if (!b) return false;
        b.click();
        return true;
      });
      if (!clicked) break;
      await sleep(700);
      username = (await page.$eval('#signup-username', (el) => el.value)).trim();
      if (!usernameExists(username)) break;
    }
    if (usernameExists(username)) log('WARN: duplicate username ke baavjood aage badh rahe hain.');
  }
  log(`Username: ${username}`);
  await sleep(STEP_DELAY);

  // submit disabled ho toh input event de kar enable karo
  await page.evaluate(() => {
    const i = document.querySelector('#signup-username');
    const form = i && i.closest('form');
    const btn = form && form.querySelector('button[type="submit"]');
    if (btn && btn.disabled && i) {
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // 4. CREATE ACCOUNT — 3 attempts, har ek 15s wait
  let fpShown = false;
  for (let a = 1; a <= 3 && !fpShown; a++) {
    await sleep(1200); // hydration
    try {
      await clickByText(page, 'CREATE ACCOUNT', { selector: 'button', insideText: 'Create your account' });
      log(`CREATE ACCOUNT click (attempt ${a}/3).`);
    } catch (e) {
      log(`CREATE ACCOUNT click warn: ${e.message}`);
    }
    fpShown = await waitTextOptional(page, 'Save your fingerprint', 15000);
    if (!fpShown) log(`Fingerprint popup nahi aaya (attempt ${a}/3)...`);
  }
  if (!fpShown) {
    await logDialogText(page); // site ka exact error console me
    throw new Error('CREATE ACCOUNT ke baad fingerprint popup nahi aaya' + errHint());
  }

  // 5. capture: fingerprint (DOM) + api key (download -> sniff -> clipboard)
  await sleep(800);
  let fingerprint = await page.evaluate(() => {
    const codes = [...document.querySelectorAll('[role="dialog"] code')];
    for (const c of codes) {
      const t = (c.textContent || '').trim();
      if (/^[a-f0-9]{32}$/i.test(t)) return t;
    }
    return '';
  });

  let apiKey = '';
  log('API key capture: download fallback...');
  apiKey = await apiKeyFromDownload(page);

  if (!apiKey && sniffedKeys.length) {
    apiKey = sniffedKeys[sniffedKeys.length - 1];
    log('API key network response se mili (sniff).');
  }

  if (!apiKey) {
    const focused = await page.evaluate(() => document.hasFocus()).catch(() => false);
    if (focused) {
      const copies = [];
      for (let i = 0; i < 2; i++) {
        const v = await copyFromDialog(page, i);
        if (v) copies.push(v);
      }
      apiKey = copies.find((v) => /^dahl_/.test(v)) || '';
      const fpFromClip = copies.find((v) => /^[a-f0-9]{32}$/i.test(v));
      if (!fingerprint && fpFromClip) fingerprint = fpFromClip;
    }
  }

  if (!fingerprint && !apiKey) {
    await logDialogText(page);
    throw new Error('Fingerprint aur API key dono capture nahi hue' + errHint());
  }
  if (!fingerprint) log('WARN: fingerprint nahi mila (partial save hoga).');
  if (!apiKey) log('WARN: api key nahi mili (partial save hoga).');

  log(`Fingerprint: ${fingerprint || '(missing)'}`);
  log(`API key: ${apiKey || '(missing)'}`);

  return { username, api: apiKey, fingerprint };
}

// ============================================================
// PHASE B: checkbox → continue → allocate → logo (data already save)
// ============================================================
async function completeAndAllocate(page) {
  // checkbox tick
  await page.evaluate(() => {
    const cb =
      document.querySelector('[role="dialog"] input.auth-checkbox') ||
      document.querySelector('input.auth-checkbox') ||
      document.querySelector('[role="dialog"] input[type="checkbox"]');
    if (!cb) throw new Error('checkbox nahi mila');
    if (!cb.checked) cb.click();
  });
  log('Checkbox tick kiya.');
  await sleep(STEP_DELAY);

  // CONTINUE (enabled ka wait)
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => (x.innerText || '').trim().toUpperCase() === 'CONTINUE'
      );
      return b && !b.disabled;
    },
    { timeout: TIMEOUT }
  );
  await clickByText(page, 'CONTINUE', { selector: 'button', insideText: 'Save your fingerprint' });
  log('CONTINUE click kiya.');

  await page.waitForFunction(
    () => location.pathname.includes('account') || (document.body?.innerText || '').includes('API keys'),
    { timeout: TIMEOUT }
  );
  await waitForText(page, 'API keys');
  log('Account page aa gaya.');
  await sleep(STEP_DELAY);

  // card ka ALLOCATE (popup khulne se pehle page pe unique)
  await page.evaluate(() => window.scrollBy(0, 600));
  await sleep(400);
  const cardClicked = await page.evaluate(() => {
    const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
    const el = [...document.querySelectorAll('button')].find((b) => norm(b.innerText).toLowerCase() === 'allocate');
    if (!el) return 'not-found';
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'ok';
  });
  if (cardClicked !== 'ok') throw new Error(`ALLOCATE card button fail: ${cardClicked}`);
  log('ALLOCATE button click kiya.');

  const popupUp = await waitTextOptional(page, 'Allocate to key', 15000);
  if (!popupUp) {
    await logDialogText(page);
    throw new Error('Allocate popup nahi khula' + errHint());
  }
  await sleep(STEP_DELAY);

  // MAX click → input "100.0M"
  await clickByText(page, 'MAX', { selector: 'button', insideText: 'Allocate to key' });
  log('MAX click kiya.');
  await sleep(STEP_DELAY);

  // popup ka ALLOCATE (overlay wala)
  const popClicked = await page.evaluate(() => {
    const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
    const cands = [...document.querySelectorAll('button')].filter(
      (b) => norm(b.innerText).toLowerCase() === 'allocate'
    );
    if (!cands.length) return 'not-found';
    const inOverlay = cands.filter((b) => b.closest('[class*="fixed"]'));
    const el = inOverlay.length ? inOverlay[inOverlay.length - 1] : cands[cands.length - 1];
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'ok';
  });
  if (popClicked !== 'ok') throw new Error(`ALLOCATE popup button fail: ${popClicked}`);
  log('Popup ALLOCATE click kiya.');

  // success check: 100M/100M
  const allocated = await page
    .waitForFunction(
      () => {
        const t = document.body?.innerText || '';
        return /100(\.0)?M\s*\/\s*100(\.0)?M/.test(t) || /On keys:\s*100/.test(t);
      },
      { timeout: TIMEOUT }
    )
    .then(() => true)
    .catch(() => false);
  if (!allocated) throw new Error('Token allocate nahi hua (100M/100M nahi dikha)' + errHint());
  log('Tokens allocate ho gaye (100M/100M).');

  // Dahl logo → home
  await sleep(STEP_DELAY);
  await page.evaluate(() => {
    const svg = document.querySelector('svg[aria-label="Dahl"]');
    const a = svg && svg.closest('a');
    const t = a || svg;
    if (t) t.click();
  });
  await sleep(STEP_DELAY);
}

// ============================================================
// ek account = phase A + write (partial bhi) + phase B + deep clear
// ============================================================
async function runAccount(page, n) {
  log(`========== Account ${n} ==========`);
  let data;
  try {
    data = await captureSignup(page);
  } catch (e) {
    await screenshot(page, `error-acc${n}.png`);
    throw e; // kuch likha nahi — caller same number se aage badhega
  }

  writeAccountBlock(n, data); // ab data safe hai — delete nahi hoga

  try {
    await completeAndAllocate(page);
  } catch (e) {
    log(`WARN: acc${n} ka continue/allocate step fail: ${e.message}`);
    log(`(acc${n} ka data apis.txt me save hai — koi data nahi gaya)`);
    await screenshot(page, `error-acc${n}-alloc.png`);
  }

  await deepClear(page);
  log('Deep clear: cookies + cache + storage done.');
}

// ---------------- main ----------------
(async () => {
  let browser = null;
  let page = null;
  const total = CONFIG.accounts ?? 1;

  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    prepareOutputFile(); // overwrite=true ho toh pehle timestamped backup

    const startNo = nextAccNumber();
    log(`apis.txt numbering: acc${startNo} se continue (purana data safe).`);
    log(`Naye accounts is run me: ${total} | beech me ${BETWEEN_ACC_DELAY}ms pause`);

    log('Browser launch (headed, maximize → minimize kiya jayega)...');
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });

    browserPid = browser.process()?.pid;
    minimizeWindow(); // call #1: launch ke turant baad

    page = await browser.newPage();
    attachSniffer(page);

    try {
      const origin = new URL(CONFIG.url).origin;
      await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write']);
    } catch (e) {
      log(`clipboard permission warn: ${e.message}`);
    }

    let accNo = startNo;
    let ok = 0;
    let failed = 0;
    let consecFails = 0;

    for (let i = 1; i <= total; i++) {
      try {
        await runAccount(page, accNo);
        ok++;
        accNo++;
        consecFails = 0;
      } catch (err) {
        failed++;
        consecFails++;
        log(`acc${accNo} FAIL (${consecFails}/${MAX_CONSEC_FAILS}): ${err.message}`);
        if (!CONFIG.continueOnError) throw err;
        if (consecFails >= MAX_CONSEC_FAILS) {
          throw new Error(`${consecFails} lagatar failures — run band. Aakhri error: ${err.message}`);
        }
        log('Next account try karte hain (numbering same rahegi).');
        await deepClear(page).catch(() => {});
        await sleep(2000);
      }
      if (i < total) await sleep(BETWEEN_ACC_DELAY);
    }

    log(`================================`);
    log(`DONE: ${ok} success, ${failed} fail → ${OUTPUT_PATH}`);
  } catch (err) {
    console.error(`[${ts()}] ERROR: ${err.message}`);
    await screenshot(page, 'error.png');
    process.exitCode = 1;
  } finally {
    if (browser) {
      if (CONFIG.keepOpenAtEnd) log('keepOpenAtEnd=true — browser khula chhod diya.');
      else await browser.close().catch(() => {});
    }
  }
})();
