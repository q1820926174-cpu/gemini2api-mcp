import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const root = fileURLToPath(new URL('.', import.meta.url));
try {
  for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = /^(GEMINI_API_BASE_URL|GEMINI_API_KEY)=(.*)$/.exec(line);
    if (match) process.env[match[1]] = match[2];
  }
} catch {
  // No local .env — credentials may come from the real environment instead.
}

const baseUrl = process.env.GEMINI_API_BASE_URL?.replace(/\/+$/, '');
const apiKey = process.env.GEMINI_API_KEY;
const maxBytes = 20 * 1024 * 1024;
const mimeTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.rtf': 'application/rtf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function loadFile(path, imageOnly) {
  const absolute = resolve(path);
  const info = statSync(absolute);
  if (!info.isFile()) throw new Error(`附件不是普通文件：${path}`);
  if (info.size === 0) throw new Error(`附件为空：${path}`);
  if (info.size > maxBytes) throw new Error(`附件超过单次请求 20 MiB 限制：${basename(path)}`);
  const mime = mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream';
  if (imageOnly && !mime.startsWith('image/')) throw new Error(`图片格式不支持：${basename(path)}`);
  return { name: basename(path), mime, data: readFileSync(absolute) };
}

async function chat({ prompt, model, system, images = [], attachments = [], max_tokens }) {
  if (!baseUrl || !apiKey) throw new Error('MCP 凭证未配置，请检查本地 .env 文件。');
  const paths = [...images.map(path => [path, true]), ...attachments.map(path => [path, false])];
  if (paths.length > 8) throw new Error('单次最多上传 8 个文件。');
  const declaredBytes = paths.reduce((total, [path]) => total + statSync(resolve(path)).size, 0);
  if (declaredBytes > maxBytes) throw new Error('所有附件合计不能超过 20 MiB。');
  const files = paths.map(([path, imageOnly]) => loadFile(path, imageOnly));
  const totalBytes = files.reduce((total, file) => total + file.data.length, 0);
  if (totalBytes > maxBytes) throw new Error('所有附件合计不能超过 20 MiB。');

  const content = [{ type: 'text', text: prompt }];
  for (const file of files) {
    content.push({ type: 'text', text: `[附件：${file.name}]` });
    content.push({ type: 'image_url', image_url: { url: `data:${file.mime};base64,${file.data.toString('base64')}` } });
  }
  const messages = [];
  if (system?.trim()) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, ...(max_tokens ? { max_tokens } : {}) }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.message || response.statusText;
    throw new Error(`Gemini API HTTP ${response.status}: ${String(message).slice(0, 1000)}`);
  }
  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('Gemini API 返回了空答案。');
  return answer;
}

const server = new McpServer({ name: 'gemini2api', version: '1.0.0' });
server.registerTool('gemini_chat', {
  title: 'Gemini 单轮对话',
  description: '向 Gemini 发起一次独立对话。可附加本机图片、PDF、文本或 Office 文件的绝对路径；不保留上下文。默认使用 gemini-flash。',
  inputSchema: z.object({
    prompt: z.string().min(1).max(100_000).describe('本轮要问 Gemini 的内容'),
    model: z.string().default('gemini-flash').describe('模型名，例如 gemini-flash 或 gemini-pro'),
    system: z.string().max(20_000).optional().describe('可选的本轮系统指令'),
    images: z.array(z.string()).max(8).optional().describe('图片文件的本机路径'),
    attachments: z.array(z.string()).max(8).optional().describe('PDF、文本、表格、演示文稿等附件的本机路径'),
    max_tokens: z.number().int().min(1).max(32768).optional().describe('可选的最大回答 token 数'),
  }),
}, async (args) => {
  try {
    return { content: [{ type: 'text', text: await chat(args) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
});

void serveStdio(() => server);
