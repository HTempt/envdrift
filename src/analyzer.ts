/**
 * Drift analysis: compare code references against .env(.example) declarations.
 *
 * Categories:
 * - missing   : referenced in code, absent from .env.example (and .env)
 * - dead      : declared in .env.example but never referenced in code
 * - leak      : .env.example holds a value that looks like a real secret
 * - duplicate : declared in several env files with conflicting values
 */

import { parseEnvFile, envMap, type EnvEntry } from './envfile.js';
import { scanDirectory, type EnvRef } from './scanner.js';

export interface MissingVar {
  name: string;
  refs: { file: string; line: number }[];
  /** languages that reference it */
  langs: string[];
}

export interface DeadVar {
  name: string;
  declaredIn: string;
  line: number;
  comment?: string;
}

export interface LeakVar {
  name: string;
  file: string;
  line: number;
  reason: string;
}

export interface DriftReport {
  project: string;
  missing: MissingVar[];
  dead: DeadVar[];
  leaks: LeakVar[];
  dynamic: { name: string; file: string; line: number }[];
  stats: {
    filesScanned: number;
    codeRefs: number;
    exampleVars: number;
    localOnlyVars: number;
  };
}

export interface AnalyzeOptions {
  root: string;
  /** env files to treat as declaration source, resolved against root */
  envFiles?: string[];
  /** extra names to always treat as intentional (e.g. NODE_ENV) */
  allow?: string[];
  /** check .env (local, not committed) too when reporting "missing" */
  checkLocalEnv?: boolean;
}

const BASENAMES = ['.env.example', '.env.sample', '.env.template', '.env.defaults'];

const SECRET_HINTS: { kind: 'name' | 'value'; re: RegExp; reason: string }[] = [
  { kind: 'name', re: /^(?:.*[-_])?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET)(?:[-_].*)?$/i, reason: 'name suggests secret' },
  { kind: 'value', re: /sk-[A-Za-z0-9_-]{16,}/, reason: 'OpenAI-style key' },
  { kind: 'value', re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, reason: 'GitHub token' },
  { kind: 'value', re: /AKIA[0-9A-Z]{16}/, reason: 'AWS access key id' },
  { kind: 'value', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'PEM private key' },
  { kind: 'value', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, reason: 'JWT' },
  { kind: 'value', re: /postgres(?:ql)?:\/\/[^@\s]+:[^@\s]+@|mysql:\/\/[^@\s]+:[^@\s]+@|mongodb(?:\+srv)?:\/\/[^@\s]+:[^@\s]+@/, reason: 'database URL with credentials' },
];

function langOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
    py: 'python', go: 'go', java: 'java', kt: 'kotlin', rs: 'rust',
    rb: 'ruby', php: 'php', cs: 'csharp', vue: 'vue', svelte: 'svelte', astro: 'astro',
    yaml: 'yaml', yml: 'yaml',
  };
  return map[ext] ?? ext;
}

export async function analyze(opts: AnalyzeOptions): Promise<DriftReport> {
  const { root } = opts;
  const fs = await import('node:fs');
  const path = await import('node:path');

  // 1. locate env declaration files
  const envFiles = opts.envFiles ?? BASENAMES;
  const found: { file: string; abs: string; entries: EnvEntry[]; duplicates: string[] }[] = [];
  for (const base of envFiles) {
    const abs = path.resolve(root, base);
    if (!fs.existsSync(abs)) continue;
    const parsed = parseEnvFile(fs.readFileSync(abs, 'utf8'));
    found.push({ file: base, abs, entries: parsed.entries, duplicates: parsed.duplicates });
  }

  const exampleMap = new Map<string, EnvEntry>();
  const deadCandidates: DeadVar[] = [];
  for (const f of found) {
    for (const e of f.entries) {
      if (!exampleMap.has(e.key)) {
        exampleMap.set(e.key, e);
        deadCandidates.push({ name: e.key, declaredIn: f.file, line: e.line, comment: e.comment });
      }
    }
  }

  // 2. local .env (uncommitted) — vars present locally but not in example
  let localOnly: EnvEntry[] = [];
  const localAbs = path.resolve(root, '.env');
  let localEntries: EnvEntry[] = [];
  if (opts.checkLocalEnv !== false && fs.existsSync(localAbs)) {
    const parsed = parseEnvFile(fs.readFileSync(localAbs, 'utf8'));
    localEntries = parsed.entries;
    localOnly = parsed.entries.filter((e) => !exampleMap.has(e.key));
  }

  // 3. scan code
  const absRoot = path.resolve(root);
  const scan = scanDirectory(absRoot);
  const rel = (p: string) => path.relative(absRoot, p).split('\\').join('/');

  // 4. classify (built-in allowlist always applies; user --allow only adds)
  const allow = new Set([...DEFAULT_ALLOW, ...(opts.allow ?? [])]);
  const refAgg = new Map<string, { file: string; line: number }[]>();
  const langsAgg = new Map<string, Set<string>>();
  const dynamicRefs: { name: string; file: string; line: number }[] = [];
  const staticNames = new Set<string>();

  for (const r of scan.refs) {
    if (r.dynamic) {
      dynamicRefs.push({ name: r.name, file: rel(r.file), line: r.line });
      continue;
    }
    staticNames.add(r.name);
    if (!refAgg.has(r.name)) refAgg.set(r.name, []);
    refAgg.get(r.name)!.push({ file: rel(r.file), line: r.line });
    const lang = langOf(r.file);
    if (!langsAgg.has(r.name)) langsAgg.set(r.name, new Set());
    langsAgg.get(r.name)!.add(lang);
  }

  const missing: MissingVar[] = [];
  for (const [name, refs] of refAgg) {
    if (exampleMap.has(name)) continue;
    if (allow.has(name)) continue;
    const local = localEntries.find((e) => e.key === name);
    missing.push({
      name,
      refs: refs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
      langs: [...(langsAgg.get(name) ?? [])],
      ...(local ? { declaredLocalOnly: true } : {}),
    } as MissingVar & { declaredLocalOnly?: boolean });
  }
  missing.sort((a, b) => b.refs.length - a.refs.length);

  const referenced = staticNames;
  const dead = deadCandidates.filter((d) => !referenced.has(d.name) && !allow.has(d.name));

  const leaks: LeakVar[] = [];
  for (const f of found) {
    for (const e of f.entries) {
      if (e.value === '') continue;
      for (const hint of SECRET_HINTS) {
        const target = hint.kind === 'name' ? e.key : e.value;
        if (hint.re.test(target) && !isPlaceholder(e.value)) {
          leaks.push({ name: e.key, file: f.file, line: e.line, reason: `${hint.reason} — non-placeholder value committed` });
          break;
        }
      }
    }
  }

  return {
    project: path.basename(path.resolve(root)),
    missing,
    dead,
    leaks,
    dynamic: dynamicRefs,
    stats: {
      filesScanned: scan.filesScanned,
      codeRefs: staticNames.size,
      exampleVars: exampleMap.size,
      localOnlyVars: localOnly.length,
    },
  };
}

const DEFAULT_ALLOW = new Set([
  'NODE_ENV', 'PORT', 'NODE_OPTIONS', 'DEBUG', 'PATH', 'HOME', 'SHELL', 'LANG', 'TZ',
  'HOSTNAME', 'npm_lifecycle_event', 'npm_package_name', 'npm_package_version',
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'GOFLAGS', 'RUST_LOG', 'RUST_BACKTRACE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'CI', 'GITHUB_ACTIONS', 'FORCE_COLOR', 'NO_COLOR',
]);

/** a value that is clearly not a real credential */
function isPlaceholder(v: string): boolean {
  const s = v.trim();
  return (
    s === '' ||
    /^\$\{.*\}$/.test(s) ||
    /^(?:your|my|xxx|changeme|change[_-]?me|replace[_-]?me|example|sample|dummy|test|placeholder|todo|fixme|<[^>]*>)[\s\S]{0,80}$/i.test(s) ||
    /^\*+$/.test(s) ||
    s.length < 6
  );
}

export { parseEnvFile, envMap };
export type { EnvEntry };
export type { EnvRef };
