/**
 * Fixer: turn a drift report into an actionable cleanup plan, render a
 * side-by-side preview, and (with user consent) write it back.
 *
 * Scope (v0.3):
 * - dead vars   → remove the line; when the dead var has a doc comment, keep
 *                 the comment as a tombstone `# removed by envdrift: KEY`
 * - leaked vars → replace the secret value with a placeholder, never delete
 *                 the line (the var is presumably still needed)
 *
 * In Spring mode, dead keys of application.properties/yml are removable the
 * same way (whole-line delete, preserving comments above).
 */

import type { DriftReport } from './analyzer.js';
import { parseEnvFile } from './envfile.js';

export interface FilePlan {
  /** absolute-ish path as reported by the analyzer (project-relative) */
  file: string;
  /** 1-based line numbers to delete entirely */
  deleteLines: number[];
  /** line -> replacement text (leak neutralization) */
  replaceLines: Map<number, string>;
}

export interface FixPlan {
  files: FilePlan[];
  /** total lines removed */
  removedLines: number;
  /** total values neutralized */
  neutralized: number;
}

const TOMBSTONE = '# removed by envdrift';

interface RawLine {
  text: string;
  /** key this line defines (when it is a KEY=... line) */
  key?: string;
  /** comment text if the line is a comment */
  comment?: string;
}

function readLines(abs: string, fs: typeof import('node:fs')): RawLine[] {
  const content = fs.readFileSync(abs, 'utf8');
  return content.split(/\r?\n/).map((text) => {
    const t = text.trim();
    if (t.startsWith('#')) return { text, comment: t.replace(/^#+\s*/, '') };
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.\-\[\]]*)\s*=/.exec(text);
    if (m) return { text, key: m[1]! };
    return { text };
  });
}

/** build cleanup plan for one env-style file from report findings */
export function planForFile(
  file: string,
  abs: string,
  findings: { name: string; line: number; kind: 'dead' | 'leak' }[],
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
): FilePlan {
  const lines = readLines(abs, fs);
  const deleteLines: number[] = [];
  const replaceLines = new Map<number, string>();

  for (const f of findings) {
    if (f.kind === 'dead') {
      deleteLines.push(f.line);
      // if the line above is a comment that documents this var, tombstone it instead of deleting
      const above = lines[f.line - 2]; // 1-based → index
      if (above?.comment) {
        replaceLines.set(f.line - 1, `${TOMBSTONE}: ${f.name}`);
      }
    } else {
      // leak: neutralize value, keep the line
      const raw = lines[f.line - 1]?.text ?? '';
      const m = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.\-\[\]]*\s*=\s*)(.*)$/.exec(raw);
      if (m) {
        replaceLines.set(f.line, `${m[1]}<REMOVED_BY_ENVDRIFT>`);
      } else {
        // yaml-style `key: value` (spring files)
        const ym = /^(\s*-?\s*[A-Za-z0-9_.-]+\s*:\s*)(.*)$/.exec(raw);
        if (ym) replaceLines.set(f.line, `${ym[1]}<REMOVED_BY_ENVDRIFT>`);
      }
      if (!replaceLines.has(f.line)) deleteLines.push(f.line);
    }
  }

  // A var that is BOTH dead and leaked has no reason to keep a placeholder line —
  // delete wins. Leak-replace only applies to vars still referenced by code.
  for (const n of [...replaceLines.keys()]) {
    if (deleteLines.includes(n)) replaceLines.delete(n);
  }

  void path;
  return { file, deleteLines: [...new Set(deleteLines)].sort((a, b) => a - b), replaceLines };
}

export function buildPlan(report: DriftReport, root: string, fs: typeof import('node:fs'), path: typeof import('node:path')): FixPlan {
  const plans: FilePlan[] = [];
  let removedLines = 0;
  let neutralized = 0;

  const byFile = new Map<string, { name: string; line: number; kind: 'dead' | 'leak' }[]>();
  for (const d of report.dead) {
    const key = `${d.declaredIn}`;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push({ name: d.name, line: d.line, kind: 'dead' });
  }
  for (const l of report.leaks) {
    if (!byFile.has(l.file)) byFile.set(l.file, []);
    byFile.get(l.file)!.push({ name: l.name, line: l.line, kind: 'leak' });
  }

  for (const [file, findings] of byFile) {
    const abs = path.resolve(root, file);
    if (!fs.existsSync(abs)) continue;
    const plan = planForFile(file, abs, findings, fs, path);
    if (plan.deleteLines.length || plan.replaceLines.size) {
      removedLines += plan.deleteLines.length;
      neutralized += plan.replaceLines.size;
      plans.push(plan);
    }
  }

  return { files: plans, removedLines, neutralized };
}

/* ------------------------------ preview render ------------------------------ */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

function useColor(): boolean {
  return process.stdout.isTTY && !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0';
}
function c(code: string, s: string): string {
  return useColor() ? `${code}${s}${RESET}` : s;
}

export function renderPreview(plan: FixPlan, root: string, fs: typeof import('node:fs'), path: typeof import('node:path')): string {
  const L: string[] = [];
  L.push(c(BOLD, `cleanup plan — ${plan.removedLines} line(s) to remove, ${plan.neutralized} value(s) to neutralize`));
  L.push(c(DIM, 'review the preview; nothing is written until you confirm'));

  for (const fp of plan.files) {
    const abs = path.resolve(root, fp.file);
    let lines: string[];
    try {
      lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    L.push('');
    L.push(c(BOLD, `  ${fp.file}`));

    const actions = new Map<number, 'del' | 'repl'>();
    for (const n of fp.deleteLines) actions.set(n, 'del');
    for (const n of fp.replaceLines.keys()) actions.set(n, 'repl');

    const maxTouch = Math.max(...actions.keys());
    for (let i = 1; i <= lines.length; i++) {
      const act = actions.get(i);
      if (!act && i > maxTouch) break; // stop printing after last touched line
      const raw = lines[i - 1] ?? '';
      const gutter = c(DIM, `${String(i).padStart(3)} `);
      if (act === 'del') {
        L.push(`${gutter}${c(RED, `- ${raw}`)}`);
      } else if (act === 'repl') {
        L.push(`${gutter}${c(RED, `- ${raw}`)}`);
        const next = fp.replaceLines.get(i)!;
        L.push(`${gutter}${c(GREEN, `+ ${next}`)}`);
      } else {
        // context: show the line dimmed only when directly between touched lines
        L.push(`${gutter}${c(DIM, `  ${raw}`)}`);
      }
    }
    if (fp.replaceLines.size) {
      L.push(c(YELLOW, '  ℹ leaked values are neutralized in place (not deleted) — rotate the secret too!'));
    }
  }
  return L.join('\n');
}

/** plain-text preview without ANSI colors — for web UI transport and tests */
export function renderPreviewText(plan: FixPlan, root: string, fs: typeof import('node:fs'), path: typeof import('node:path')): string {
  const L: string[] = [];
  L.push(`cleanup plan — ${plan.removedLines} line(s) to remove, ${plan.neutralized} value(s) to neutralize`);
  for (const fp of plan.files) {
    const abs = path.resolve(root, fp.file);
    let lines: string[];
    try {
      lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    L.push('', fp.file);
    const actions = new Map<number, 'del' | 'repl'>();
    for (const n of fp.deleteLines) actions.set(n, 'del');
    for (const n of fp.replaceLines.keys()) actions.set(n, 'repl');
    const maxTouch = Math.max(...actions.keys());
    for (let i = 1; i <= lines.length; i++) {
      const act = actions.get(i);
      if (!act && i > maxTouch) break;
      const raw = lines[i - 1] ?? '';
      if (act === 'del') L.push(`${String(i).padStart(4)} - ${raw}`);
      else if (act === 'repl') {
        L.push(`${String(i).padStart(4)} - ${raw}`);
        L.push(`${String(i).padStart(4)} + ${fp.replaceLines.get(i)}`);
      } else L.push(`${String(i).padStart(4)}   ${raw}`);
    }
  }
  return L.join('\n');
}

/* ------------------------------ apply ------------------------------ */

export function applyPlan(plan: FixPlan, root: string, fs: typeof import('node:fs'), path: typeof import('node:path')): void {
  for (const fp of plan.files) {
    const abs = path.resolve(root, fp.file);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);

    const actions = new Map<number, 'del' | 'repl'>();
    for (const n of fp.deleteLines) actions.set(n, 'del');
    for (const [n, rep] of fp.replaceLines) actions.set(n, 'repl');

    const out: string[] = [];
    for (let i = 1; i <= lines.length; i++) {
      const act = actions.get(i);
      if (act === 'del') continue;
      if (act === 'repl') out.push(fp.replaceLines.get(i)!);
      else out.push(lines[i - 1] ?? '');
    }
    fs.writeFileSync(abs, out.join('\n'), 'utf8');
  }
}

/** rebuild a file after cleaning and re-parse it to guarantee validity */
export function verifyPlanResult(plan: FixPlan, root: string, fs: typeof import('node:fs'), path: typeof import('node:path')): { file: string; ok: boolean; problems: string[] }[] {
  const results: { file: string; ok: boolean; problems: string[] }[] = [];
  for (const fp of plan.files) {
    const abs = path.resolve(root, fp.file);
    const problems: string[] = [];
    try {
      const content = fs.readFileSync(abs, 'utf8');
      const parsed = parseEnvFile(content);
      if (parsed.syntaxErrors.length) {
        problems.push(...parsed.syntaxErrors.map((e) => `syntax error at line ${e.line}: ${e.text}`));
      }
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    results.push({ file: fp.file, ok: problems.length === 0, problems });
  }
  return results;
}
