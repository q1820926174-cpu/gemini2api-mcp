import { readFileSync } from 'node:fs';

let envLoaded = true;
try {
  for (const line of readFileSync(new URL('.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const match = /^(GEMINI_API_BASE_URL)=(.*)$/.exec(line);
    if (match) process.env[match[1]] = match[2];
  }
} catch {
  envLoaded = false;
}

const baseUrl = process.env.GEMINI_API_BASE_URL?.replace(/\/+$/, '');
if (!envLoaded || !baseUrl) {
  console.error('Gemini2API 本地配置缺失；请检查 MCP 目录中的 .env。');
  process.exit(1);
}

let origin;
try {
  origin = new URL(baseUrl).origin;
} catch {
  console.error('Gemini2API 地址配置无效。');
  process.exit(1);
}

async function checkHealth() {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) });
    const data = await response.json().catch(() => null);
    return { ok: response.ok && data?.status === 'ok', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

const health = await checkHealth();
console.log(`Health: ${health.ok ? 'OK' : 'FAIL'} (${health.detail})`);
console.log('Credential comparison: NOT RUN (local Gemini Cookie source is not configured).');
if (!health.ok) {
  console.log(`Web 管理页：${origin}/`);
}
process.exitCode = 1;
