// Process + HTTP helpers. All docker calls use argv arrays (never a shell string from agent input).
import { spawn } from 'node:child_process';
import http from 'node:http';

export function run(cmd, args, { input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e), timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr, timedOut });
    });
    if (input != null) p.stdin.end(input);
    else p.stdin.end();
  });
}

export const docker = (args, opts) => run('docker', args, opts);

// GET with an explicit Host header (WordPress builds URLs from it).
export function httpGet({ host, port, path, hostHeader, timeoutMs = 25000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request(
      { host, port, path, method: 'GET', headers: { Host: hostHeader, 'User-Agent': 'PressBox-Gate/0.1' } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size < 2_000_000) chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            ms: Date.now() - started,
          }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, timedOut: true, body: '', ms: Date.now() - started });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, body: '', ms: Date.now() - started }));
    req.end();
  });
}

export const hostOf = (url) => new URL(url).host;

export function textExcerpt(html, max = 1200) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const isCriticalPage = (body) => /critical error|Fatal error|Parse error|Maximum execution time/i.test(body || '');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
