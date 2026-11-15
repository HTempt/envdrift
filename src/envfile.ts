/**
 * Parse .env-style files into ordered key/value entries.
 *
 * Supported syntax (superset of dotenv):
 * - `KEY=value`, `export KEY=value`
 * - single/double quoted values (quotes stripped), `KEY=` (empty)
 * - comments (`# ...`) and inline comments outside quotes
 * - blank lines; CRLF and LF line endings
 * - `#` comments carry optional inline doc:  `# comment text` above or beside a key
 * - empty value counts as "declared but not set", useful for .env.example
 */

export interface EnvEntry {
  /** variable name */
  key: string;
  /** raw value (quotes stripped); empty string when `KEY=` */
  value: string;
  /** doc comment: nearest preceding comment line, or inline `# comment` after the value */
  comment?: string;
  /** 1-based line number */
  line: number;
  /** value came from a double-quoted string that may contain interpolations */
  interpolated?: boolean;
}

export interface ParseResult {
  entries: EnvEntry[];
  /** duplicate keys seen later in the file (dotenv ignores or warns) */
  duplicates: string[];
  /** lines that could not be understood */
  syntaxErrors: { line: number; text: string }[];
}

const KEY_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*/;

export function parseEnvFile(content: string): ParseResult {
  const lines = content.split(/\r?\n/);
  const entries: EnvEntry[] = [];
  const duplicates: string[] = [];
  const syntaxErrors: { line: number; text: string }[] = [];
  const seen = new Map<string, EnvEntry>();
  let pendingComment: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (trimmed === '') {
      // a blank line ends a comment block (only keep comment attached directly above a key)
      pendingComment = undefined;
      continue;
    }

    if (trimmed.startsWith('#')) {
      const text = trimmed.replace(/^#+\s*/, '').trim();
      if (text) {
        // remember last non-empty comment as potential doc for the next key
        pendingComment = text;
      }
      continue;
    }

    const m = KEY_RE.exec(raw);
    if (!m) {
      syntaxErrors.push({ line: lineNo, text: trimmed });
      continue;
    }

    const key = m[1];
    let rest = raw.slice(m[0].length);
    let inlineComment: string | undefined;
    let interpolated = false;

    // double-quoted: may span interpolation; find closing quote on this line
    if (rest.startsWith('"')) {
      const close = rest.indexOf('"', 1);
      if (close === -1) {
        // multi-line value: consume until closing quote (simple joining)
        let value = rest.slice(1);
        let j = i + 1;
        for (; j < lines.length; j++) {
          const closeIdx = lines[j].indexOf('"');
          if (closeIdx !== -1) {
            value += '\n' + lines[j].slice(0, closeIdx);
            i = j;
            break;
          }
          value += '\n' + lines[j];
        }
        if (j >= lines.length && i < j) {
          // unterminated — keep what we have
          i = j - 1;
        }
        push(key, value, lineNo, true, pendingComment);
        pendingComment = undefined;
        continue;
      }
      interpolated = true;
      const value = rest.slice(1, close);
      const after = rest.slice(close + 1).trim();
      if (after.startsWith('#')) inlineComment = after.replace(/^#\s*/, '').trim() || undefined;
      push(key, value, lineNo, true, pendingComment ?? inlineComment);
      pendingComment = undefined;
      continue;
    }

    if (rest.startsWith("'")) {
      const close = rest.indexOf("'", 1);
      if (close === -1) {
        syntaxErrors.push({ line: lineNo, text: trimmed });
        continue;
      }
      const value = rest.slice(1, close);
      const after = rest.slice(close + 1).trim();
      if (after.startsWith('#')) inlineComment = after.replace(/^#\s*/, '').trim() || undefined;
      push(key, value, lineNo, false, pendingComment ?? inlineComment);
      pendingComment = undefined;
      continue;
    }

    // unquoted: strip inline comment (first ` #`), then trim
    const hashIdx = rest.indexOf(' #');
    if (hashIdx !== -1) {
      inlineComment = rest.slice(hashIdx + 1).replace(/^#\s*/, '').trim() || undefined;
      rest = rest.slice(0, hashIdx);
    }
    push(key, rest.trim(), lineNo, false, pendingComment ?? inlineComment);
    pendingComment = undefined;
  }

  function push(key: string, value: string, line: number, interpolated: boolean, comment?: string) {
    const prev = seen.get(key);
    if (prev) {
      if (!duplicates.includes(key)) duplicates.push(key);
      return; // dotenv keeps the first occurrence
    }
    const entry: EnvEntry = { key, value, line };
    if (comment) entry.comment = comment;
    if (interpolated) entry.interpolated = true;
    entries.push(entry);
    seen.set(key, entry);
  }

  return { entries, duplicates, syntaxErrors };
}

export function envMap(entries: EnvEntry[]): Map<string, EnvEntry> {
  return new Map(entries.map((e) => [e.key, e]));
}
