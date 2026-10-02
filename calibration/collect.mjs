#!/usr/bin/env node
// Calibration collector: asks the configured Gemini endpoint about an image N
// times, filters upstream error stubs, saves every real answer as JSON.
//
// Usage: node collect.mjs <image.png> <out.json> [times] [prompt] [model]
// Env:   GEMINI_API_BASE_URL, GEMINI_API_KEY   (see ../.env.example)
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.GEMINI_API_BASE_URL?.replace(/\/+$/, '');
const KEY = process.env.GEMINI_API_KEY;

const [,, imgPath, outPath, timesArg, promptArg, modelArg] = process.argv;
const TIMES = parseInt(timesArg || '1', 10);
const PROMPT = promptArg || 'Give the approximate pixel position (x,y) of the center of each labeled object in this image. State the pixel coordinate system (image dimensions) you use.';
const MODEL = modelArg || 'gemini-flash';

if (!BASE || !KEY || !imgPath || !outPath) {
  console.error('usage: node collect.mjs <image> <out.json> [times] [prompt] [model]; export GEMINI_API_BASE_URL/GEMINI_API_KEY first');
  process.exit(2);
}

const b64 = readFileSync(imgPath).toString('base64');
const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
  ]}],
  max_tokens: 1500,
});

const answers = [];
for (let i = 1; i <= TIMES; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(170000),
    });
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || '';
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (content && content.length > 20 && !/encountering an error|encountered an error|something went wrong|try your request again|please try again|hard time/i.test(content)) {
      answers.push({ attempt: i, seconds: dt, content });
      console.error(`[ok ${i}/${TIMES}] ${dt}s ${content.length}ch`);
    } else {
      console.error(`[bad ${i}/${TIMES}] ${dt}s content=<<${content.slice(0, 80)}>> finish=${json?.choices?.[0]?.finish_reason}`);
    }
  } catch (e) {
    console.error(`[err ${i}/${TIMES}] ${e.message}`);
  }
  if (i < TIMES) await new Promise(r => setTimeout(r, 2000));
}
writeFileSync(outPath, JSON.stringify(answers, null, 1));
console.error(`saved ${answers.length}/${TIMES} -> ${outPath}`);
