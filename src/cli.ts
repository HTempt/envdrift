#!/usr/bin/env node
import { analyze } from './analyzer.js';
import { renderText, renderJson, reportExitCode, setReportRoot } from './report.js';
import { buildPlan, renderPreview, applyPlan, verifyPlanResult } from './fixer.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Args {
  root: string;
  json: boolean;
  allow: string[];
  envFiles?: string[];
  noLocal: boolean;
  fix: boolean;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: '.', json: false, allow: [], noLocal: false, fix: false, dryRun: false, yes: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--json': args.json = true; break;
      case '--allow': args.allow.push(...(argv[++i] ?? '').split(',').filter(Boolean)); break;
      case '--env-file': args.envFiles = (argv[++i] ?? '').split(','); break;
      case '--no-local': args.noLocal = true; break;
      case '--fix': args.fix = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--yes': case '-y': args.yes = true; break;
      case '-h': case '--help': args.help = true; break;
      case '-v': case '--version': args.version = true; break;
      default:
        if (!a.startsWith('-')) args.root = a;
        else console.error(`unknown option: ${a}`);
    }
  }
  return args;
}

const HELP = `
envdrift — detect environment variable drift between your code and .env.example

Usage: envdrift [path] [options]

Options:
  --json              machine-readable JSON output (for CI / AI agents)
  --allow NAME,NAME2  always ignore these variable names
  --env-file FILES    comma-separated declaration files (default: .env.example,.env.sample,.env.template,.env.defaults)
  --no-local          don't consider local .env when deciding what is missing
  --fix               build a cleanup plan, preview it, ask for confirmation, then apply
  --dry-run           with --fix: show the preview and exit without prompting or writing
  --yes               with --fix: apply without interactive confirmation (for scripts)
  -h, --help          show this help
  -v, --version       show version

Exit codes: 0 = clean (or dead/dynamic only) · 1 = missing vars or leaked secrets

Examples:
  envdrift                     # scan current directory
  envdrift ./packages/api      # scan a subproject
  envdrift --json              # pipe into jq or feed to an AI agent
  envdrift --fix               # highlight problems, preview cleanup, confirm, apply
  envdrift --fix --dry-run     # only show what would change
`.trim();

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
    return `envdrift ${pkg.version}`;
  } catch {
    return 'envdrift';
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  if (args.version) { console.log(version()); return 0; }

  const absRoot = resolve(args.root);
  setReportRoot(absRoot);

  const report = await analyze({
    root: args.root,
    allow: args.allow,
    envFiles: args.envFiles,
    checkLocalEnv: !args.noLocal,
  });

  if (args.json && !args.fix) {
    console.log(renderJson(report));
    return reportExitCode(report);
  }

  console.log(renderText(report));

  if (!args.fix) return reportExitCode(report);

  // ---- fix flow ----
  if (args.json) {
    // machine consumers get the plan as JSON instead of the interactive preview
    const plan = buildPlan(report, absRoot, await import('node:fs'), await import('node:path'));
    console.log('\n' + JSON.stringify(plan, null, 2));
    return 0;
  }

  const fs = await import('node:fs');
  const path = await import('node:path');
  const plan = buildPlan(report, absRoot, fs, path);

  if (!plan.files.length) {
    console.log('\nnothing to clean — no dead vars or leaks in committed env files');
    return reportExitCode(report);
  }

  console.log('\n' + renderPreview(plan, absRoot, fs, path));

  if (args.dryRun) {
    console.log('\ndry-run: no files were modified');
    return 0;
  }

  if (!args.yes) {
    const ok = await confirm('\napply this cleanup? [Y/n] ');
    if (!ok) {
      console.log('aborted — nothing was written');
      return reportExitCode(report);
    }
  }

  applyPlan(plan, absRoot, fs, path);

  const verification = verifyPlanResult(plan, absRoot, fs, path);
  const bad = verification.filter((v) => !v.ok);
  for (const v of verification) {
    console.log(`${v.ok ? '✓' : '✗'} ${v.file}${v.ok ? ' — cleaned, still parses' : ` — ${v.problems.join('; ')}`}`);
  }

  // re-analyze: missing vars may remain (they are not auto-fixed), leaks/dead should be gone
  const after = await analyze({
    root: args.root,
    allow: args.allow,
    envFiles: args.envFiles,
    checkLocalEnv: !args.noLocal,
  });
  console.log(`\nafter cleanup: ${after.dead.length} dead, ${after.leaks.length} leaks (before: ${report.dead.length} dead, ${report.leaks.length} leaks)`);

  return bad.length ? 2 : reportExitCode(after);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('envdrift failed:', err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
