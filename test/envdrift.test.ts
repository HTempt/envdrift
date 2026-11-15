import { describe, it, expect } from 'vitest';
import { parseEnvFile } from '../src/envfile.js';
import { scanContent } from '../src/scanner.js';
import { analyze } from '../src/analyzer.js';
import { renderText, renderJson, reportExitCode } from '../src/report.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'demo-app');

describe('parseEnvFile', () => {
  it('parses basic key=value with comments', () => {
    const r = parseEnvFile('# app config\nFOO=bar\n\nBAZ=qux # inline\n');
    expect(r.entries).toEqual([
      expect.objectContaining({ key: 'FOO', value: 'bar', comment: 'app config' }),
      expect.objectContaining({ key: 'BAZ', value: 'qux', comment: 'inline' }),
    ]);
    expect(r.syntaxErrors).toHaveLength(0);
  });

  it('strips quotes and export prefix', () => {
    const r = parseEnvFile('export A="hello world"\nB=\'single\'\n');
    expect(r.entries[0]).toMatchObject({ key: 'A', value: 'hello world', interpolated: true });
    expect(r.entries[1]).toMatchObject({ key: 'B', value: 'single' });
  });

  it('detects duplicates keeping first', () => {
    const r = parseEnvFile('A=1\nA=2\n');
    expect(r.entries).toHaveLength(1);
    expect(r.duplicates).toEqual(['A']);
  });

  it('records syntax errors', () => {
    const r = parseEnvFile('good=1\nthis is not an env line\n');
    expect(r.syntaxErrors).toEqual([{ line: 2, text: 'this is not an env line' }]);
  });

  it('handles CRLF', () => {
    const r = parseEnvFile('A=1\r\nB=2\r\n');
    expect(r.entries.map((e) => e.key)).toEqual(['A', 'B']);
  });
});

describe('scanContent', () => {
  it('finds JS process.env references with line numbers', () => {
    const refs = scanContent('const a = process.env.FOO;\nconst b = process.env["BAR"];', 'x.ts');
    expect(refs).toContainEqual(expect.objectContaining({ name: 'FOO', line: 1, dynamic: false }));
    expect(refs).toContainEqual(expect.objectContaining({ name: 'BAR', line: 2, dynamic: false }));
  });

  it('finds Python os.environ/os.getenv', () => {
    const refs = scanContent('os.environ["A"]\nos.getenv("B")\nos.environ.get("C")', 'm.py');
    expect(refs.map((r) => r.name).sort()).toEqual(['A', 'B', 'C']);
  });

  it('finds Go os.Getenv', () => {
    expect(scanContent('os.Getenv("GO_VAR")', 'm.go').map((r) => r.name)).toEqual(['GO_VAR']);
  });

  it('flags dynamic lookups', () => {
    const refs = scanContent('const k = "X";\nprocess.env[k];', 'x.js');
    expect(refs.some((r) => r.dynamic && r.name === '<dynamic:k>')).toBe(true);
  });

  it('ignores unrelated extensions', () => {
    expect(scanContent('process.env.FOO', 'readme.txt')).toEqual([]);
  });
});

describe('analyze (fixture demo-app)', () => {
  it('detects missing, dead, local-only and dynamic vars', async () => {
    const report = await analyze({ root: fixtureDir });
    const names = (arr: { name: string }[]) => arr.map((x) => x.name);

    // referenced in code but absent from .env.example
    expect(names(report.missing)).toEqual(
      expect.arrayContaining(['QUEUE_REDIS_URL', 'SMTP_PASSWORD', 'SMTP_HOST', 'REGIONAL_API_URL']),
    );

    // declared but never statically referenced
    // (STRIPE_API_KEY is only accessed dynamically via process.env[key], so it counts as dead)
    expect(names(report.dead)).toEqual(expect.arrayContaining(['STRIPE_API_KEY']));
    expect(names(report.dead)).not.toContain('LEGACY_API_ENDPOINT'); // used in worker.py

    // secrets in example with real-looking values
    expect(report.leaks.some((l) => l.name === 'DATABASE_URL')).toBe(true);
    // placeholder values must NOT be flagged
    expect(report.leaks.some((l) => l.name === 'JWT_SECRET')).toBe(false);
    expect(report.leaks.some((l) => l.name === 'STRIPE_API_KEY')).toBe(false);

    // dynamic lookup recorded
    expect(report.dynamic.length).toBeGreaterThan(0);

    expect(report.stats.filesScanned).toBeGreaterThanOrEqual(4);
  });

  it('respects --allow', async () => {
    const report = await analyze({ root: fixtureDir, allow: ['SMTP_HOST'] });
    expect(report.missing.some((m) => m.name === 'SMTP_HOST')).toBe(false);
  });
});

describe('report', () => {
  it('exit code is 1 when missing exist, 0 when clean', async () => {
    const bad = await analyze({ root: fixtureDir });
    expect(reportExitCode(bad)).toBe(1);
  });

  it('text report contains sections', async () => {
    const report = await analyze({ root: fixtureDir });
    const text = renderText(report);
    expect(text).toContain('missing from .env.example');
    expect(text).toContain('QUEUE_REDIS_URL');
  });

  it('json report parses and has summary', async () => {
    const report = await analyze({ root: fixtureDir });
    const parsed = JSON.parse(renderJson(report));
    expect(parsed.summary.missing).toBe(report.missing.length);
    expect(parsed.project).toBe('demo-app');
  });
});
