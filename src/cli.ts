#!/usr/bin/env node
import { analyze } from './analyzer.js';
import { renderText, renderJson, reportExitCode } from './report.js';

interface Args {
  root: string;
  json: boolean;
  allow: string[];
  envFiles?: string[];
  noLocal: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: '.', json: false, allow: [], noLocal: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--json': args.json = true; break;
      case '--allow': args.allow.push(...(argv[++i] ?? '').split(',').filter(Boolean)); break;
      case '--env-file': args.envFiles = (argv[++i] ?? '').split(','); break;
      case '--no-local': args.noLocal = true; break;
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
  -h, --help          show this help
  -v, --version       show version

Exit codes: 0 = clean (or dead/dynamic only) · 1 = missing vars or leaked secrets

Examples:
  envdrift                    # scan current directory
  envdrift ./packages/api     # scan a subproject
  envdrift --json             # pipe into jq or feed to an AI agent
`.trim();

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  if (args.version) { console.log('envdrift 0.1.0'); return 0; }

  const report = await analyze({
    root: args.root,
    allow: args.allow,
    envFiles: args.envFiles,
    checkLocalEnv: !args.noLocal,
  });

  if (args.json) {
    console.log(renderJson(report));
  } else {
    console.log(renderText(report));
  }
  return reportExitCode(report);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('envdrift failed:', err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
