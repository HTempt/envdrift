/**
 * Scan source code for environment variable references across languages.
 *
 * Strategy: language-specific regexes on each file, keeping line numbers.
 * Static string literals are treated as definite references. For dynamic
 * access (`process.env[name]`, `os.environ.get(name)`), we record the call
 * site so the CLI can report it as "dynamic (not statically checkable)".
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

export interface EnvRef {
  name: string;
  file: string;
  line: number;
  /** static literal reference vs dynamic lookup */
  dynamic: boolean;
}

export interface ScanResult {
  refs: EnvRef[];
  /** files inspected (count by extension) */
  filesScanned: number;
}

const DEFAULT_IGNORES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'venv',
  '.venv',
  '__pycache__',
  'target',
  'vendor',
  '.cache',
  'coverage',
]);

const TEXT_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.java', '.kt', '.rs', '.rb', '.php', '.cs',
  '.vue', '.svelte', '.astro',
  '.yaml', '.yml', '.toml', '.json',
]);

/** JS/TS: process.env.NAME, import.meta.env.NAME, process.env['NAME'], Deno.env.get("NAME") */
const JS_PATTERNS: RegExp[] = [
  /(?:process|import\.meta)\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /(?:process|import\.meta)\.env\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g,
  /\b(?:Deno|Bun)\.env\.get\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g,
  /\bgetEnv\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g,
];

/** dynamic (non-literal) lookups we can't resolve statically */
const JS_DYNAMIC: RegExp[] = [
  /(?:process|import\.meta)\.env\[\s*(?!['"`])\s*([A-Za-z_$][\w$.]*)\s*\]/g,
  /\bDeno\.env\.get\(\s*(?!['"`])([A-Za-z_$][\w$.]*)\s*\)/g,
];

/** Python: os.environ["X"], os.environ.get('X'), os.getenv("X"), environ["X"] */
const PY_PATTERNS: RegExp[] = [
  /\bos\.environ\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g,
  /\bos\.environ\.get\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g,
  /\bos\.getenv\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g,
  /\benviron\.get\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g,
];

/** Go: os.Getenv("X"), os.LookupEnv("X"), env.Get fallback via viper */
const GO_PATTERNS: RegExp[] = [
  /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
];

/** Java/Kotlin: System.getenv("X"), System.getProperty("X") */
const JVM_PATTERNS: RegExp[] = [
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
  /System\.getProperty\(\s*"([A-Za-z_][A-Za-z0-9_.-]*)"\s*\)/g,
];

/**
 * Spring Framework / Spring Boot:
 * - @Value("${prop.name}") / @Value("${prop.name:default}") on fields and constructor params
 * - environment.getProperty("prop.name") / env.getRequiredProperty("prop.name")
 * - @ConfigurationProperties binding reads config files, not placeholders — covered via .properties/.yml refs
 */
const SPRING_PATTERNS: RegExp[] = [
  /@Value\(\s*(["'])\$\{([A-Za-z0-9_.-]+?)(?::([^}"']*))?\}\1\s*\)/g,
  /(?:environment|env)\.get(?:Required)?Property\(\s*"([A-Za-z0-9_.-]+?)"/g,
];

/** Rust: std::env::var("X"), env::var("X") */
const RS_PATTERNS: RegExp[] = [
  /\benv::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
  /\benv::set_var\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
];

/** Ruby: ENV['X'], ENV.fetch('X'), ENV["X"] */
const RB_PATTERNS: RegExp[] = [
  /\bENV(?:\.fetch)?\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g,
  /\bENV\.fetch\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g,
];

/** PHP: getenv('X'), $_ENV['X'], $_SERVER['X'] (env-ish subset only when from getenv context) */
const PHP_PATTERNS: RegExp[] = [
  /\bgetenv\(\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g,
  /\$_ENV\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g,
];

/** C#: Environment.GetEnvironmentVariable("X") */
const CS_PATTERNS: RegExp[] = [
  /Environment\.GetEnvironmentVariable\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
];

/** config files: docker-compose `environment:` entries, k8s manifest `name: X` under env, GH Actions `env: X` */
const YAML_ENV_BLOCK: RegExp[] = [
  // docker-compose: KEY: value inside environment: block — too ambiguous; capture only explicit list style
  /^\s*-\s*([A-Z][A-Z0-9_]*)=(?!=)/g,
  // GitHub Actions / k8s: `- name: VAR_NAME` with valueKey following — capture the name when followed by value on next line
];

/**
 * Java .properties / application.yml are parsed by the analyzer as Spring
 * declarations, not scanned as generic usage here — keys are declarations,
 * `${VAR}` placeholders inside values are the actual usage.
 */

const EXT_LANG: Record<string, RegExp[][]> = {
  '.js': [JS_PATTERNS, JS_DYNAMIC],
  '.jsx': [JS_PATTERNS, JS_DYNAMIC],
  '.mjs': [JS_PATTERNS, JS_DYNAMIC],
  '.cjs': [JS_PATTERNS, JS_DYNAMIC],
  '.ts': [JS_PATTERNS, JS_DYNAMIC],
  '.tsx': [JS_PATTERNS, JS_DYNAMIC],
  '.mts': [JS_PATTERNS, JS_DYNAMIC],
  '.cts': [JS_PATTERNS, JS_DYNAMIC],
  '.vue': [JS_PATTERNS],
  '.svelte': [JS_PATTERNS],
  '.astro': [JS_PATTERNS],
  '.py': [PY_PATTERNS],
  '.go': [GO_PATTERNS],
  '.java': [[...JVM_PATTERNS, ...SPRING_PATTERNS], []],
  '.kt': [[...JVM_PATTERNS, ...SPRING_PATTERNS], []],
  '.rs': [RS_PATTERNS],
  '.rb': [RB_PATTERNS],
  '.php': [PHP_PATTERNS],
  '.cs': [CS_PATTERNS],
  '.yaml': [YAML_ENV_BLOCK],
  '.yml': [YAML_ENV_BLOCK],
};

function isIgnoredDir(name: string): boolean {
  return DEFAULT_IGNORES.has(name) || name === '.venv' || name.startsWith('.env');
}

function* walk(dir: string): Generator<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.env')) continue; // don't scan .env files as source
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!isIgnoredDir(ent.name)) yield* walk(full);
    } else if (ent.isFile() && TEXT_EXTS.has(extname(ent.name))) {
      yield full;
    }
  }
}

export function scanDirectory(root: string): ScanResult {
  const refs: EnvRef[] = [];
  let filesScanned = 0;
  for (const file of walk(root)) {
    filesScanned++;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    refs.push(...scanContent(content, file));
  }
  return { refs, filesScanned };
}

export interface SpringScan {
  /** property keys declared in application.properties / application.yml */
  declared: { name: string; file: string; line: number }[];
  /** ${VAR} / ${VAR:default} placeholders consumed inside property values */
  consumed: EnvRef[];
}

/** true when the file is a Spring config file (application.properties / application*.yml) */
export function isSpringConfigFile(filePath: string): boolean {
  return /(^|[\\/])application(-.+)?\.(properties|ya?ml)$/i.test(filePath);
}

/**
 * Parse a Spring config file: `key=value` (properties) or flat YAML `key: value`
 * pairs. Declared keys are returned with positions; `${VAR}` placeholders inside
 * values (e.g. spring.datasource.password=${DB_PASSWORD}) are returned as usages.
 */
export function scanSpringConfig(content: string, filePath: string): SpringScan {
  const declared: { name: string; file: string; line: number }[] = [];
  const consumed: EnvRef[] = [];
  const lines = content.split(/\r?\n/);
  let yamlIndent: number | null = null;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const isProps = filePath.toLowerCase().endsWith('.properties');
    const line = raw.trim();

    if (line === '' || line.startsWith('#')) return;

    if (isProps) {
      const m = /^([A-Za-z][A-Za-z0-9_.\-\[\]]*)\s*[=:](.*)$/.exec(line);
      if (!m) return;
      declared.push({ name: m[1]!, file: filePath, line: lineNo });
      consumePlaceholders(m[2] ?? '', filePath, lineNo, consumed);
      return;
    }

    // yaml: track whether we are inside a top-level `spring:` block is unnecessary —
    // dotted/spring keys are matched structurally: `key: value` with 0 indentation.
    const indent = raw.length - raw.trimStart().length;
    const m = /^([A-Za-z][A-Za-z0-9_.\-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    if (indent === 0) yamlIndent = 0;
    if (m[2] === '' || m[2] === '|' || m[2] === '>') return; // section header
    declared.push({ name: m[1]!, file: filePath, line: lineNo });
    consumePlaceholders(m[2]!, filePath, lineNo, consumed);
  });

  return { declared, consumed };
}

function consumePlaceholders(value: string, file: string, line: number, out: EnvRef[]): void {
  const re = /\$\{([A-Za-z_][A-Za-z0-9_.-]*)(?::[^}]*)?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    out.push({ name: m[1]!, file, line, dynamic: false });
  }
}

export function scanContent(content: string, filePath: string): EnvRef[] {
  const ext = extname(filePath).toLowerCase();
  const groups = EXT_LANG[ext];
  if (!groups) return [];
  const refs: EnvRef[] = [];
  const lines = content.split(/\r?\n/);

  const [statics = [], dynamics = []] = groups;

  for (const re of statics) {
    re.lastIndex = 0;
    for (const m of matchAll(re, content)) {
      const name = m[2] ?? m[1];
      if (!name) continue;
      refs.push({ name, file: filePath, line: lineOf(content, m.index), dynamic: false });
    }
  }
  for (const re of dynamics) {
    re.lastIndex = 0;
    for (const m of matchAll(re, content)) {
      const name = m[1];
      if (!name) continue;
      refs.push({ name: `<dynamic:${name}>`, file: filePath, line: lineOf(content, m.index), dynamic: true });
    }
  }

  // a lookup can match several patterns (e.g. os.environ.get) — keep one ref per site
  const seenSite = new Set<string>();
  return refs.filter((r) => {
    const id = `${r.dynamic ? 'd' : 's'}|${r.name}|${r.line}`;
    if (seenSite.has(id)) return false;
    seenSite.add(id);
    return true;
  });
}

function matchAll(re: RegExp, s: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}
