# envdrift

[![CI](https://github.com/HTempt/envdrift/actions/workflows/ci.yml/badge.svg)](https://github.com/HTempt/envdrift/actions/workflows/ci.yml)

**Detect environment variable drift** — the gap between what your code actually reads and what `.env.example` declares.

The pain it solves: a fresh `git clone` + `npm install` + `npm run dev` crashes with `undefined` config, because someone added `process.env.NEW_THING` to code but never updated `.env.example`. Nobody notices until the next person (or the CI, or an AI agent in a fresh sandbox) hits it.

## What it detects

| Category | Meaning | CI exit code impact |
|---|---|---|
| `missing` | env vars referenced in code but absent from `.env.example` | **fails (1)** |
| `leaks` | real-looking secrets committed in `.env.example` (DB URLs, API keys, JWTs…) | **fails (1)** |
| `dead` | declared in `.env.example` but never referenced anywhere | warning only |
| `dynamic` | dynamic lookups (`process.env[name]`) that can't be statically checked | info only |

## Install & run

```bash
# from source (v0.1)
git clone <this-repo> && cd envdrift && npm install && npm run build
node dist/cli.js /path/to/project
```

```text
envdrift · my-api
scanned 164 files · 23 unique env refs · 19 vars in example

✗ missing from .env.example (2) — will crash on a fresh clone
  QUEUE_REDIS_URL  used in src/queue.go:6 (2×, go/js)
  SMTP_PASSWORD    used in src/server.js:22 (2×, js/python)

⚠ possible leaked secrets in committed env files (1)
  DATABASE_URL  .env.example:2 — database URL with credentials — non-placeholder value committed

~ declared but unused (1) — candidate dead vars
  STRIPE_API_KEY  .env.example:17 — External services

? dynamic lookups not statically checkable (1)
  <dynamic:key>  src/server.js:18
```

## Languages supported (read side)

`js/ts/tsx/mjs/cjs` (`process.env.X`, `import.meta.env.X`, `Deno/Bun.env.get`)
· `python` (`os.environ[...]`, `os.environ.get`, `os.getenv`)
· `go` (`os.Getenv`, `os.LookupEnv`)
· `java/kotlin` (`System.getenv`)
· `rust` (`env::var`)
· `ruby` (`ENV[...]`, `ENV.fetch`)
· `php` (`getenv`, `$_ENV`)
· `c#` (`Environment.GetEnvironmentVariable`)
· `yaml` (docker-compose `- KEY=` list style)

## AI-agent friendly

`--json` emits a stable schema with a `summary.exitCode` field — designed for MCP servers, CI bots, and coding agents that provision their own sandboxes:

```bash
envdrift --json | jq '.summary'
```

## Options

```
envdrift [path]
  --json              JSON output
  --allow A,B         extra variable names to ignore (built-in list always applies)
  --env-file FILES    comma-separated declaration files
                      (default: .env.example,.env.sample,.env.template,.env.defaults)
  --no-local          ignore local .env when judging what is "missing"
```

Exit codes: `0` clean · `1` missing vars or leaked secrets · `2` tool error.

## Design notes

- Static-analysis only — fast, no execution, no config needed. Dynamic lookups are reported, not guessed.
- Placeholder-aware leak detection: `JWT_SECRET=changeme` is fine; `DATABASE_URL=postgres://user:pass@db:5432/x` is a leak.
- Built-in allowlist for runtime-injected vars (`NODE_ENV`, `PORT`, `RUST_LOG`, `CI`, proxies…) so fresh projects aren't noisy.

## Roadmap

- `--fix`: write detected vars into `.env.example` with the nearest code comment as doc
- git pre-commit hook + GitHub Action
- MCP server wrapper
- interpolation resolution (`${OTHER_VAR}` chains)

MIT
