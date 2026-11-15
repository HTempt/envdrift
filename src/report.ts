/**
 * Report rendering: colored text for humans, JSON for machines/CI.
 */

import type { DriftReport } from './analyzer.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

function useColor(): boolean {
  return process.stdout.isTTY && !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0';
}

function c(code: string, s: string): string {
  return useColor() ? `${code}${s}${RESET}` : s;
}

export function renderText(r: DriftReport): string {
  const L: string[] = [];
  const head = (t: string) => L.push('', c(BOLD, t));

  L.push(c(BOLD, `envdrift · ${r.project}`));
  L.push(c(DIM, `scanned ${r.stats.filesScanned} files · ${r.stats.codeRefs} unique env refs · ${r.stats.exampleVars} vars in example`));

  if (r.missing.length) {
    head(`✗ missing from .env.example (${r.missing.length}) — will crash on a fresh clone`);
    for (const m of r.missing.slice(0, 20)) {
      const loc = m.refs[0]!;
      L.push(`  ${c(RED, m.name)}  ${c(DIM, `used in ${loc.file}:${loc.line} (${m.refs.length}×, ${m.langs.join('/')})`)}`);
    }
    if (r.missing.length > 20) L.push(c(DIM, `  … and ${r.missing.length - 20} more`));
  }

  if (r.leaks.length) {
    head(`⚠ possible leaked secrets in committed env files (${r.leaks.length})`);
    for (const l of r.leaks) {
      L.push(`  ${c(RED, l.name)}  ${c(DIM, `${l.file}:${l.line} — ${l.reason}`)}`);
    }
  }

  if (r.dead.length) {
    head(`~ declared but unused (${r.dead.length}) — candidate dead vars`);
    for (const d of r.dead.slice(0, 15)) {
      L.push(`  ${c(YELLOW, d.name)}  ${c(DIM, `${d.declaredIn}:${d.line}${d.comment ? ` — ${d.comment}` : ''}`)}`);
    }
    if (r.dead.length > 15) L.push(c(DIM, `  … and ${r.dead.length - 15} more`));
  }

  if (r.dynamic.length) {
    head(`? dynamic lookups not statically checkable (${r.dynamic.length})`);
    const uniq = [...new Map(r.dynamic.map((d) => [d.name + d.file + d.line, d])).values()];
    for (const d of uniq.slice(0, 8)) {
      L.push(`  ${c(CYAN, d.name)}  ${c(DIM, `${d.file}:${d.line}`)}`);
    }
    if (uniq.length > 8) L.push(c(DIM, `  … and ${uniq.length - 8} more`));
  }

  if (!r.missing.length && !r.dead.length && !r.leaks.length && !r.dynamic.length) {
    head(c(GREEN, '✓ no drift detected — code and .env.example are in sync'));
  }

  return L.join('\n');
}

/** exit code contract: 1 = missing or leak (CI should fail), 0 = clean/dead/dynamic only */
export function reportExitCode(r: DriftReport): number {
  return r.missing.length || r.leaks.length ? 1 : 0;
}

export function renderJson(r: DriftReport): string {
  return JSON.stringify(
    {
      ...r,
      summary: {
        missing: r.missing.length,
        dead: r.dead.length,
        leaks: r.leaks.length,
        dynamic: r.dynamic.length,
        exitCode: reportExitCode(r),
      },
    },
    null,
    2,
  );
}
