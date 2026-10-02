import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const logDirectory = join(homedir(), 'Library', 'Logs', 'Gemini2API');
const logFile = join(logDirectory, 'credential-check.log');
const stateFile = join(directory, '.scheduler-state.json');
const messages = {
  UPDATED: '凭证已同步，并已核对云端持久化结果。',
  GOOGLE_LOGIN_REQUIRED: '请在 Chrome 中重新登录 Google Gemini。',
  VERIFIED_SSH_UNAVAILABLE: '服务器身份校验或 SSH 连接失败，请检查服务器连接与已知主机密钥。',
  VERIFIED_SSH_TIMEOUT: '服务器连接超时，请检查网络或服务器。',
  ADMIN_KEY_UNAVAILABLE: '无法读取原部署管理密钥，请检查本任务的本地记录。',
  ADMIN_KEY_REJECTED: '管理密钥被拒绝，需要更新已知密钥；已停止尝试。',
  PREVIOUS_UPDATE_UNRESOLVED: '上次凭证更新尚未确认，已阻止重复写入，需要人工检查。',
  BROWSER_BRIDGE_UNAVAILABLE: '无法连接浏览器桥接，请检查 Chrome 和 WebBridge 扩展。',
  BROWSER_ACTION_FAILED: '浏览器操作失败，请检查 Chrome 和 WebBridge 扩展。',
  LOCAL_COOKIE_MISSING_OR_AMBIGUOUS: '无法唯一读取 Gemini 凭证，请检查 Chrome 中的登录会话。',
  LOCAL_COOKIE_SOURCE_UNAVAILABLE: '无法读取 Gemini 凭证，请检查 Chrome 中的登录会话。',
  PERSISTENCE_NOT_VERIFIED: '无法确认凭证已保存，已停止重复写入，需要检查管理页面。',
};
const statuses = new Set([...Object.keys(messages), 'SAME', 'ALREADY_RUNNING', 'DIFFERENT', 'DEFERRED_BUSY',
  'CHECK_FAILED', 'CHECK_RUN_FAILED', 'LOCAL_COOKIE_INVALID', 'CLOUD_FINGERPRINT_UNAVAILABLE',
  'SSH_HELPER_UNAVAILABLE', 'SSH_HELPER_EXITED', 'SSH_HELPER_INVALID', 'BROWSER_STATE_TIMEOUT',
  'BROWSER_ORIGIN_MISMATCH', 'CLOUD_STATUS_UNAVAILABLE', 'CLOUD_ACCOUNT_AMBIGUOUS',
  'COOKIE_INPUT_NOT_MASKED', 'COOKIE_UPDATE_FAILED', 'TARGET_CONFIG_MISMATCH',
  'LOCAL_STATE_UNREADABLE', 'HEALTH_FAILED', 'LOCAL_STATE_WRITE_FAILED']);

export function parseResult(stdout) {
  try {
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    if (!statuses.has(result.status) || typeof result.notify !== 'boolean'
      || typeof result.cookie_submission_attempted !== 'boolean' || result.model_requests !== 0) throw Error();
    return { status: result.status,
      health_http: Number.isInteger(result.health_http) && result.health_http >= 100 && result.health_http <= 599
        ? result.health_http : null,
      cookie_submission_attempted: result.cookie_submission_attempted, model_requests: 0, notify: result.notify };
  } catch {
    return { status: 'CHECK_RUN_FAILED', health_http: null,
      cookie_submission_attempted: null, model_requests: null, notify: true };
  }
}

export function shouldNotify(result, previousStatus) {
  return result.notify && !['SAME', 'ALREADY_RUNNING', 'DEFERRED_BUSY'].includes(result.status)
    && (result.status === 'UPDATED' || result.status !== previousStatus);
}

function check() {
  const child = spawnSync(process.execPath, ['check.mjs'], {
    cwd: directory, encoding: 'utf8', timeout: 250_000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseResult(child.stdout ?? '');
}

export function main() {
  let result = check();
  if (result.status === 'BROWSER_BRIDGE_UNAVAILABLE' && !result.cookie_submission_attempted) {
    const started = spawnSync(join(homedir(), '.kimi-webbridge', 'bin', 'kimi-webbridge'), ['start'],
      { timeout: 20_000, stdio: 'ignore' });
    if (started.status === 0) result = check();
  }
  let previous = {};
  try { previous = JSON.parse(readFileSync(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') previous = { status: 'SCHEDULER_STATE_UNREADABLE' }; }
  let notificationRequested = false;
  let notificationAccepted = false;
  if (shouldNotify(result, previous.status)) {
    notificationRequested = true;
    const message = messages[result.status] ?? `凭证检查未完成（${result.status}），请查看本机 Gemini2API 检查日志。`;
    const notification = spawnSync('/usr/bin/osascript', ['-e',
      'on run argv\ndisplay notification (item 1 of argv) with title "Gemini2API"\nend run', message],
      { timeout: 10_000, stdio: 'ignore' });
    notificationAccepted = notification.status === 0;
  }
  // Whitelist output: never persist subprocess stderr, credentials, or raw API responses.
  const record = { checkedAt: new Date().toISOString(), ...result,
    notification_requested: notificationRequested, notification_accepted: notificationAccepted };
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  try { if (statSync(logFile).size >= 256 * 1024) renameSync(logFile, logFile + '.1'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  appendFileSync(logFile, JSON.stringify(record) + '\n', { mode: 0o600 });
  writeFileSync(stateFile + '.tmp', JSON.stringify(record) + '\n', { mode: 0o600 });
  renameSync(stateFile + '.tmp', stateFile);
  return ['SAME', 'UPDATED', 'ALREADY_RUNNING', 'DEFERRED_BUSY'].includes(result.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(); }
  catch { process.exitCode = 1; }
}
