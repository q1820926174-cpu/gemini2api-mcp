import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const stateFile = new URL('.credential-check-state.json', import.meta.url);
const session = 'gemini2api-credential-sync';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class CheckError extends Error {}
const fail = code => { throw new CheckError(code); };

let envAvailable = true;
let envText = '';
try { envText = await readFile(new URL('.env', import.meta.url), 'utf8'); }
catch { envAvailable = false; }
if (envAvailable) for (const line of envText.split(/\r?\n/)) {
  const match = /^(GEMINI2API_MANAGE_TARGET|GEMINI2API_ADMIN_KEY|GEMINI2API_SSH_HOST|GEMINI2API_SSH_PORT|GEMINI2API_SSH_USER|GEMINI2API_SSH_PASSWORD|GEMINI2API_SSH_KEY|GEMINI2API_SERVICE_PORT)=(.*)$/.exec(line);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
}
const target = process.env.GEMINI2API_MANAGE_TARGET?.replace(/\/+$/, '');

export function fingerprint(pair) {
  if (!Array.isArray(pair) || pair.length !== 2 || pair.some(v =>
    typeof v !== 'string' || !v || /[\s;]/.test(v))) fail('LOCAL_COOKIE_INVALID');
  return createHash('sha256').update(JSON.stringify(pair)).digest('hex');
}

export function selectCookies(cookies, now = Date.now() / 1000) {
  return ['__Secure-1PSID', '__Secure-1PSIDTS'].map(name => {
    const matches = cookies.filter(c => c.name === name && c.domain === '.google.com'
      && c.secure && (c.expires <= 0 || c.expires > now));
    const values = [...new Set(matches.map(c => c.value))];
    if (values.length !== 1) fail('LOCAL_COOKIE_MISSING_OR_AMBIGUOUS');
    return values[0];
  });
}

export function decide(local, cloud, attempted) {
  if (![cloud?.cookie_fingerprint, cloud?.persisted_cookie_fingerprint]
    .every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) return 'CLOUD_FINGERPRINT_UNAVAILABLE';
  if (local === cloud.cookie_fingerprint && local === cloud.persisted_cookie_fingerprint) return 'SAME';
  if (attempted) return 'PREVIOUS_UPDATE_UNRESOLVED';
  if (!Number.isInteger(cloud.active_requests) || cloud.active_requests < 0) return 'CLOUD_STATUS_UNAVAILABLE';
  return cloud.active_requests > 0 || cloud.status === 'refreshing' ? 'DEFERRED_BUSY' : 'DIFFERENT';
}

async function saveState(state) {
  const temporary = new URL('.credential-check-state.json.tmp', import.meta.url);
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
  await rename(temporary, stateFile);
}

function adminKey() {
  const key = process.env.GEMINI2API_ADMIN_KEY;
  if (!key) fail('ADMIN_KEY_UNAVAILABLE');
  return key;
}

async function bridge(action, args = {}) {
  const response = await fetch('http://127.0.0.1:10086/command', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, args, session }), signal: AbortSignal.timeout(30_000),
  }).catch(() => fail('BROWSER_BRIDGE_UNAVAILABLE'));
  const result = await response.json();
  if (!result.ok || result.data?.success === false) fail('BROWSER_ACTION_FAILED');
  return result.data;
}

async function evaluate(code) { return (await bridge('evaluate', { code })).value; }
async function navigate(url) {
  await bridge('navigate', { url, newTab: false, group_title: 'Gemini2API 凭证同步' });
}
async function waitFor(code, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(code)) return;
    await delay(500);
  }
  fail('BROWSER_STATE_TIMEOUT');
}
async function assertOrigin(origin) {
  if (!(await evaluate(`location.origin === ${JSON.stringify(origin)}`))) fail('BROWSER_ORIGIN_MISMATCH');
}

async function localCookies() {
  await navigate('https://gemini.google.com/app');
  await waitFor(`location.origin === 'https://gemini.google.com' && !!document.querySelector('[contenteditable="true"][role="textbox"]') && !!document.querySelector('a[href*="accounts.google.com/SignOutOptions"]')`)
    .catch(() => fail('GOOGLE_LOGIN_REQUIRED'));
  const result = await bridge('cdp', { method: 'Network.getCookies', params: { urls: ['https://gemini.google.com'] } });
  if (!Array.isArray(result.cookies)) fail('LOCAL_COOKIE_SOURCE_UNAVAILABLE');
  return selectCookies(result.cookies);
}

function startTunnel() {
  const child = spawn('python3', ['ssh_tunnel.py'], { cwd: directory, stdio: ['pipe', 'pipe', 'ignore'] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CheckError('VERIFIED_SSH_TIMEOUT')), 35_000);
    let output = '';
    child.once('error', () => { clearTimeout(timer); reject(new CheckError('SSH_HELPER_UNAVAILABLE')); });
    child.once('exit', () => { clearTimeout(timer); reject(new CheckError('SSH_HELPER_EXITED')); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try {
        const result = JSON.parse(output.split('\n')[0]);
        if (['ALREADY_RUNNING', 'VERIFIED_SSH_UNAVAILABLE'].includes(result.error)) resolve(result);
        else if (Number.isInteger(result.port) && result.port > 0 && result.port < 65536) resolve(result);
        else reject(new CheckError('SSH_HELPER_INVALID'));
      } catch { reject(new CheckError('SSH_HELPER_INVALID')); }
    });
  });
  return { ready, close() { child.stdin.end(); child.kill(); } };
}

async function readCloud(origin, key) {
  const response = await fetch(origin + '/admin/accounts', {
    headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) fail('ADMIN_KEY_REJECTED');
  if (!response.ok) fail('CLOUD_STATUS_UNAVAILABLE');
  const result = await response.json();
  // One known account; ambiguity must never update the wrong Google account.
  if (result.accounts?.length !== 1 || result.accounts[0].id !== 'account-0') fail('CLOUD_ACCOUNT_AMBIGUOUS');
  return result.accounts[0];
}

async function updateThroughPage(origin, key, pair, beforeSubmit) {
  // A fresh tunnel origin has no login session. Avoid the dashboard's delayed redirect.
  await navigate(origin + '/login.html');
  await waitFor(`!!document.querySelector('#apiKey') && !!document.querySelector('#loginButton')`);
  await assertOrigin(origin);
  await bridge('fill', { selector: '#apiKey', value: key });
  await bridge('click', { selector: '#loginButton' });
  await waitFor(`!!document.querySelector('.nav-item[data-section="accounts"]') || !!document.querySelector('#errorMessage.show')`);
  if (await evaluate(`!!document.querySelector('#errorMessage.show')`)) fail('ADMIN_KEY_REJECTED');
  await assertOrigin(origin);
  await bridge('click', { selector: '.nav-item[data-section="accounts"]' });
  await waitFor(`!!document.querySelector('.acc-cookie-btn[data-account-id="account-0"]')`);
  await bridge('click', { selector: '.acc-cookie-btn[data-account-id="account-0"]' });
  await waitFor(`!!document.querySelector('#updateCookieModal.active')`);
  if (!(await evaluate(`['update-psid','update-psidts'].every(id => document.getElementById(id)?.type === 'password')`))) fail('COOKIE_INPUT_NOT_MASKED');
  try {
    await bridge('fill', { selector: '#update-psid', value: pair[0] });
    await bridge('fill', { selector: '#update-psidts', value: pair[1] });
    await assertOrigin(origin);
    await beforeSubmit();
    await bridge('click', { selector: '#confirmUpdateCookie' });
    await waitFor(`!document.querySelector('#updateCookieModal.active') || !!document.querySelector('.toast.error, .toast-error')`, 120_000);
    if (await evaluate(`!!document.querySelector('#updateCookieModal.active')`)) fail('COOKIE_UPDATE_FAILED');
  } finally {
    // Never read filled fields or return a snapshot containing credentials.
    if (await evaluate(`location.origin === ${JSON.stringify(origin)} && !!document.querySelector('#update-psid')`).catch(() => false)) {
      await bridge('fill', { selector: '#update-psid', value: '' }).catch(() => {});
      await bridge('fill', { selector: '#update-psidts', value: '' }).catch(() => {});
    }
  }
}

export async function main({ readOnly = false } = {}) {
  let tunnel, state = {}, wrote = false, health = null, status = 'CHECK_FAILED', managementOrigin;
  let ownsLock = false, stateLoaded = false, keyHash;
  try {
    const env = await readFile(new URL('.env', import.meta.url), 'utf8');
    const configured = /^GEMINI_API_BASE_URL=(.*)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (!target || !configured || new URL(configured).origin !== target) fail('TARGET_CONFIG_MISMATCH');
    tunnel = startTunnel();
    const connection = await tunnel.ready;
    if (connection.error === 'ALREADY_RUNNING') fail('ALREADY_RUNNING');
    ownsLock = true;
    try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') fail('LOCAL_STATE_UNREADABLE'); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) fail('LOCAL_STATE_UNREADABLE');
    stateLoaded = true;
    if (connection.error) fail(connection.error);
    const origin = `http://127.0.0.1:${connection.port}`;
    const response = await fetch(origin + '/health', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    health = response.status;
    if (health !== 200 || (await response.json()).status !== 'ok') fail('HEALTH_FAILED');
    const key = adminKey();
    keyHash = createHash('sha256').update(key).digest('hex');
    if (state.rejectedAdminKey === keyHash) fail('ADMIN_KEY_REJECTED');
    const cloud = await readCloud(origin, key);
    const pair = await localCookies();
    const local = fingerprint(pair);
    status = decide(local, cloud, state.attempt);
    if (status === 'SAME') delete state.attempt;
    else if (status === 'DIFFERENT' && !readOnly) {
      managementOrigin = origin;
      await updateThroughPage(origin, key, pair, async () => {
        const current = decide(local, await readCloud(origin, key), state.attempt);
        if (current !== 'DIFFERENT') fail(current);
        state.attempt = { fingerprint: local, startedAt: new Date().toISOString() };
        await saveState(state);
        wrote = true;
      });
      const after = await readCloud(origin, key);
      if (decide(local, after, false) !== 'SAME' || after.cookie_storage !== 'accounts_file') fail('PERSISTENCE_NOT_VERIFIED');
      delete state.attempt;
      status = 'UPDATED';
    }
  } catch (error) {
    status = error instanceof CheckError ? error.message : 'CHECK_FAILED';
    if (status === 'ADMIN_KEY_REJECTED' && keyHash) state.rejectedAdminKey = keyHash;
  }
  if (managementOrigin) {
    // The ephemeral tunnel origin must not retain a management token after this run.
    await evaluate(`(() => { if (location.origin !== ${JSON.stringify(managementOrigin)}) return false; localStorage.removeItem('gemini2api_token'); return true; })()`)
      .catch(() => false);
    if (await evaluate(`location.origin === ${JSON.stringify(managementOrigin)} && !!document.querySelector('#apiKey')`).catch(() => false)) {
      await bridge('fill', { selector: '#apiKey', value: '' }).catch(() => {});
    }
  }
  const success = ['SAME', 'UPDATED', 'ALREADY_RUNNING', 'DEFERRED_BUSY'].includes(status);
  const notify = status === 'UPDATED' || (!success && status !== state.lastStatus);
  if (ownsLock && stateLoaded) {
    state.lastStatus = status;
    state.checkedAt = new Date().toISOString();
    try { await saveState(state); }
    catch { status = 'LOCAL_STATE_WRITE_FAILED'; }
  }
  tunnel?.close();
  console.log(JSON.stringify({ status, health_http: health, cookie_submission_attempted: wrote,
    model_requests: 0, notify: status === 'LOCAL_STATE_WRITE_FAILED' || notify }));
  return success && status !== 'LOCAL_STATE_WRITE_FAILED' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const watchdog = setTimeout(() => process.exit(1), 240_000);
  try { process.exitCode = await main({ readOnly: process.argv.includes('--read-only') }); }
  finally { clearTimeout(watchdog); }
}
