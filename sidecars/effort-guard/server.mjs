import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAppDataDir,
  getDataDir,
  getHudSnapshot,
  loadSettings,
  recordTurn,
  saveApiKey,
  saveSettings,
} from '../../lib/store.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = '127.0.0.1';
const PORT = (() => {
  const raw = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isNaN(parsed) ? 8001 : parsed;
})();

const MAX_BODY_BYTES = 8192;

let preloadCache = null;
function getPreloadJs() {
  if (preloadCache !== null) return preloadCache;
  try {
    const p = path.join(getAppDataDir(), 'lib', 'node_modules', 'sidecar_sdk', 'preload.js');
    preloadCache = fs.readFileSync(p, 'utf-8');
    return preloadCache;
  } catch {
    preloadCache = '// sidecar preload stub\n';
    return preloadCache;
  }
}

function injectQueryParams(html, token, convId) {
  if (!token && !convId) return html;
  const parts = [];
  if (token) parts.push(`token=${encodeURIComponent(token)}`);
  if (convId) parts.push(`conversationId=${encodeURIComponent(convId)}`);
  const qs = parts.join('&');
  return html.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (match, attr, quote, url) => {
    if (url.startsWith('//')) return match;
    const [base, ...hashParts] = url.split('#');
    const hash = hashParts.length ? `#${hashParts.join('#')}` : '';
    const sep = base.includes('?') ? '&' : '?';
    return `${attr}=${quote}${base}${sep}${qs}${hash}${quote}`;
  });
}

function isAllowedPostOrigin(origin) {
  if (!origin || origin === 'null') return true;
  if (/^vscode-webview:\/\//i.test(origin)) return true;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return true;
  return false;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(payload));
}

export function createEffortGuardServer(options = {}) {
  const dataDir = options.dataDir || getDataDir();

  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sidecar-Token');

    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsed = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const pathname = parsed.pathname || '/';
    const convId = parsed.searchParams.get('conversationId')?.trim() || '';

    if (method === 'GET' && pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(getPreloadJs());
      return;
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/ui.html')) {
      try {
        const uiPath = path.join(__dirname, 'ui.html');
        let html = fs.readFileSync(uiPath, 'utf-8');
        const token =
          parsed.searchParams.get('token')?.trim() ||
          (typeof req.headers['x-sidecar-token'] === 'string'
            ? req.headers['x-sidecar-token'].trim()
            : '');
        html = injectQueryParams(html, token, convId);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Failed to load ui.html: ${err.message}`);
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      const snapshot = getHudSnapshot(convId, dataDir);
      sendJson(res, 200, snapshot);
      return;
    }

    if (method === 'POST' && pathname === '/api/settings') {
      if (!isAllowedPostOrigin(req.headers.origin)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        saveSettings(body, dataDir);
        const snapshot = getHudSnapshot(convId, dataDir);
        sendJson(res, 200, snapshot);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/credentials') {
      if (!isAllowedPostOrigin(req.headers.origin)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        if (typeof body?.apiKey !== 'string') {
          sendJson(res, 400, { ok: false, error: 'apiKey must be a string' });
          return;
        }
        saveApiKey(body.apiKey, dataDir);
        const snapshot = getHudSnapshot(convId, dataDir);
        sendJson(res, 200, snapshot);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/test-fail-open') {
      if (!isAllowedPostOrigin(req.headers.origin)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
        return;
      }
      try {
        const settings = loadSettings(dataDir);
        const prev = getHudSnapshot(convId, dataDir);
        const targetConv = convId || prev.conversationId || 'default';
        const activeEffort = prev.currentTurn?.activeEffort || 'high';
        const timeoutMs = settings.timeoutMs || 2500;

        recordTurn(
          {
            conversationId: targetConv,
            prompt: prev.currentTurn?.prompt || 'Fail-open timeout verification check',
            activeEffort,
            activeModel: prev.currentTurn?.activeModel || null,
            judgeModel: settings.judgeModel,
            verdict: {
              level: activeEffort,
              effectiveLevel: activeEffort,
              confidence: 0,
              latencyMs: timeoutMs,
              reason: `Jev API exceeded ${(timeoutMs / 1000).toFixed(1)}s timeout. Failed open so your turn was never blocked.`,
              status: 'timeout',
              costUsd: 0,
              synthetic: true,
            },
          },
          dataDir
        );

        const snapshot = getHudSnapshot(targetConv, dataDir);
        sendJson(res, 200, snapshot);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const server = createEffortGuardServer();
  server.listen(PORT, HOST, () => {
    console.log(`[effort-guard-hud] listening on http://${HOST}:${PORT}`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
