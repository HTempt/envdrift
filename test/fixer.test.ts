import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { buildPlan, renderPreview, applyPlan, verifyPlanResult, planForFile } from '../src/fixer.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'envdrift-fix-'));
});

function write(rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname0(abs), { recursive: true });
  writeFileSync(abs, content);
}
function dirname0(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? '.' : p.slice(0, i);
}

describe('planForFile', () => {
  it('deletes dead lines and tombstones their doc comment', () => {
    write('.env.example', '# old docs\nLEGACY_FLAG=true\nKEEP_ME=1\n');
    const plan = planForFile(
      '.env.example', resolve(dir, '.env.example'),
      [{ name: 'LEGACY_FLAG', line: 2, kind: 'dead' }],
      fs, path,
    );
    expect(plan.deleteLines).toEqual([2]);
    expect(plan.replaceLines.get(1)).toBe('# removed by envdrift: LEGACY_FLAG');
    expect(plan.replaceLines.has(2)).toBe(false);
  });

  it('neutralizes leak values without deleting the line', () => {
    write('.env.example', 'API_KEY=sk-abcdef1234567890abcdef\n');
    const plan = planForFile(
      '.env.example', resolve(dir, '.env.example'),
      [{ name: 'API_KEY', line: 1, kind: 'leak' }],
      fs, path,
    );
    expect(plan.deleteLines).toEqual([]);
    expect(plan.replaceLines.get(1)).toBe('API_KEY=<REMOVED_BY_ENVDRIFT>');
  });
});

describe('fix flow end-to-end', () => {
  it('preview → apply → re-analyze is clean, file still parses', async () => {
    write('.env.example', [
      '# Database',
      'DATABASE_URL=postgres://admin:s3cr3t@db:5432/app',
      'DB_POOL=10',
      '# Legacy',
      'OLD_FLAG=true',
      'UNUSED_SECRET=abcdef12345',
      '',
    ].join('\n'));
    write('app.js', 'console.log(process.env.DATABASE_URL, process.env.DB_POOL);');

    const report = await analyze({ root: dir, checkLocalEnv: false });
    expect(report.leaks.length).toBeGreaterThan(0);
    expect(report.dead.length).toBeGreaterThan(0);

    const plan = buildPlan(report, dir, fs, path);
    const preview = renderPreview(plan, dir, fs, path);
    expect(preview).toContain('- OLD_FLAG=true');
    expect(preview).toContain('REMOVED_BY_ENVDRIFT');

    applyPlan(plan, dir, fs, path);

    const after = readFileSync(join(dir, '.env.example'), 'utf8');
    expect(after).toContain('DATABASE_URL=<REMOVED_BY_ENVDRIFT>');
    // UNUSED_SECRET is dead AND leak-flagged → delete-wins, whole line gone
    expect(after).not.toContain('UNUSED_SECRET');
    expect(after).not.toContain('abcdef12345');
    expect(after).not.toContain('OLD_FLAG=true');
    expect(after).not.toContain('s3cr3t');
    expect(after).toContain('# removed by envdrift: OLD_FLAG');
    expect(after).toContain('DB_POOL=10'); // untouched

    const verify = verifyPlanResult(plan, dir, fs, path);
    expect(verify.every((v) => v.ok)).toBe(true);

    const report2 = await analyze({ root: dir, checkLocalEnv: false });
    expect(report2.leaks).toHaveLength(0);
    expect(report2.dead).toHaveLength(0);
  });

  it('dead+leak double-flagged var is deleted, not neutralized', async () => {
    write('.env.example', 'GHOST_KEY=real-secret-value\n');
    const report = await analyze({ root: dir, checkLocalEnv: false });
    const plan = buildPlan(report, dir, fs, path);
    // GHOST_KEY is dead AND leak-flagged — delete wins, nothing left to keep
    applyPlan(plan, dir, fs, path);
    const after = readFileSync(join(dir, '.env.example'), 'utf8');
    expect(after).not.toContain('GHOST_KEY');
    expect(after).not.toContain('real-secret-value');
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
