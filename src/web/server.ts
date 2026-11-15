/**
 * envdrift dashboard — local web UI over the analyzer + fixer.
 *
 * Zero runtime deps: node:http + a single-file HTML page (no build step).
 * Endpoints:
 *   GET  /api/scan?root=<abs or relative path>   → DriftReport JSON
 *   POST /api/plan  {root}                       → FixPlan JSON
 *   POST /api/apply {root}                       → {verification, after}
 *   GET  /api/file?root=&path=&start=&end=       → raw lines for highlighting
 *
 * The server only serves localhost and only touches paths under the
 * requested root (or cwd). No auth by design — it binds 127.0.0.1.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../analyzer.js';
import { buildPlan, applyPlan, verifyPlanResult, renderPreviewText } from '../fixer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ScanCacheEntry {
  report: unknown;
  at: number;
}
const scanCache = new Map<string, ScanCacheEntry>();
const CACHE_MS = 4000;

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function safeRoot(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  // basic sanity: must exist and be a directory
  try {
    if (!statSync(abs).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return abs;
}

function relTo(root: string, p: string): string {
  return relative(root, p).split('\\').join('/');
}

export function startServer(port: number, host = '127.0.0.1'): Promise<string> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // dist/web/server.js → ../../src/web/index.html (html ships from source, no build step)
        const html = readFileSync(resolve(__dirname, '..', '..', 'src', 'web', 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/scan') {
        const root = safeRoot(url.searchParams.get('root'));
        if (!root) return json(res, 400, { error: 'root must be an existing directory' });
        const cached = scanCache.get(root);
        if (cached && Date.now() - cached.at < CACHE_MS) return json(res, 200, cached.report);
        const report = await analyze({ root });
        // annotate with absolute root so the client can request file lines
        (report as unknown as { _root: string })._root = root;
        scanCache.set(root, { report, at: Date.now() });
        return json(res, 200, report);
      }

      if (req.method === 'POST' && (url.pathname === '/api/plan' || url.pathname === '/api/apply')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed: { root?: string };
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          return json(res, 400, { error: 'invalid JSON body' });
        }
        const root = safeRoot(parsed.root ?? null);
        if (!root) return json(res, 400, { error: 'root must be an existing directory' });
        const report = await analyze({ root });
        const plan = buildPlan(report, root, await import('node:fs'), await import('node:path'));
        (report as unknown as { _root: string })._root = root;

        if (url.pathname === '/api/plan') {
          const fs = await import('node:fs');
          const path = await import('node:path');
          const preview = renderPreviewText(plan, root, fs, path);
          return json(res, 200, { plan, preview });
        }

        // apply
        const fs = await import('node:fs');
        const path = await import('node:path');
        applyPlan(plan, root, fs, path);
        const verification = verifyPlanResult(plan, root, fs, path);
        const after = await analyze({ root });
        scanCache.delete(root); // bust cache after mutation
        return json(res, 200, { verification, after, applied: plan });
      }

      if (req.method === 'GET' && url.pathname === '/api/file') {
        const root = safeRoot(url.searchParams.get('root'));
        const relPath = url.searchParams.get('path');
        if (!root || !relPath) return json(res, 400, { error: 'root and path are required' });
        const abs = resolve(root, relPath);
        const within = relative(root, abs);
        if (within.startsWith('..') || isAbsolute(within)) {
          return json(res, 403, { error: 'path escapes project root' });
        }
        if (!existsSync(abs)) return json(res, 404, { error: 'file not found' });
        const content = readFileSync(abs, 'utf8');
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, Number(url.searchParams.get('start') ?? 1));
        const end = Math.min(lines.length, Number(url.searchParams.get('end') ?? lines.length));
        return json(res, 200, { file: relPath, lines: lines.slice(start - 1, end).map((text, i) => ({ n: start + i, text })) });
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((ok) => {
    server.listen(port, host, () => ok(`http://${host}:${port}`));
  });
}

// direct execution: `node dist/web/server.js [root] [port]`
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const port = Number(process.argv[3] ?? 3737);
  startServer(port).then((url) => {
    console.log(`envdrift dashboard → ${url}  (scanning ${root})`);
  });
}
