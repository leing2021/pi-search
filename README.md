# pi-search

[简体中文](README_CN.md)

A minimal, secure evidence gateway for [Pi Coding Agent](https://github.com/badlogic/pi-mono).

`pi-search` gives agents four focused tools:

- `search` — search the local repo with ripgrep
- `web_search` — find web sources through routed providers
- `web_fetch` — fetch and clean one web page safely
- `research_search` — collect web evidence, with optional LLM verification

It is designed to be simple, auditable, and safe by default.

## Install

```bash
pi install npm:@leing2021/pi-search
# Restart pi or run /reload
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["extensions/pi-search.ts"]
  }
}
```

## Quick use

```ts
search({ query: "registerTool" })

web_search({ query: "React 19 features" })

web_fetch({ url: "https://react.dev/blog" })

research_search({ query: "SSRF protection in Node.js" })
```

## Tools

| Tool | Purpose | Default behavior |
|---|---|---|
| `search` | Local repo search | Uses `ripgrep`; blocks unsafe paths by default |
| `web_search` | Web source discovery | Routes through SearXNG / Brave / Tavily / DuckDuckGo |
| `web_fetch` | Safe page fetch | http(s), SSRF checks, redirect checks, HTML cleanup |
| `research_search` | Evidence collection | LLM verification is off unless explicitly enabled |

## Configuration

All configuration is optional. Use only what you need.

```bash
# Web search providers
export BRAVE_SEARCH_API_KEY="brave_xxx"
export TAVILY_API_KEY="tvly_xxx"
export FIRECRAWL_API_KEY="fc_xxx"

# Optional private SearXNG provider
export PI_SEARCH_SEARXNG_URL="http://<private-searxng-host>:8888"
export PI_SEARCH_ALLOW_PRIVATE_SEARXNG="always"

# Optional provider override
export PI_SEARCH_WEB_PROVIDER="auto" # auto | brave | tavily | duckduckgo

# Optional research LLM verification
export PI_SEARCH_LLM_ENABLED="always" # never | ask | always
export PI_SEARCH_LLM_PROVIDER="openai" # openai | anthropic | local-openai
export PI_SEARCH_LLM_MODEL="gpt-4o-mini"
export PI_SEARCH_LLM_BASE_URL="https://api.openai.com/v1"
export PI_SEARCH_LLM_API_KEY_ENV="OPENAI_API_KEY"
export OPENAI_API_KEY="<OPENAI_API_KEY>"

# Optional local search boundary override
export PI_SEARCH_ALLOW_OUTSIDE_CWD="always"
```

### Proxy note

When `HTTPS_PROXY` / `HTTP_PROXY` (any case) or `ALL_PROXY` (http(s):// only) is set,
pi-search installs an undici `EnvHttpProxyAgent` as the global fetch dispatcher
at extension load. This affects every `fetch` in the host process, matching
curl-style env-proxy semantics. Set `NO_PROXY=localhost,127.0.0.1` to keep
loopback/LAN traffic direct.

## Provider routing

`pi-search` uses intent-based routing instead of broad fan-out.

| Task | Primary path | Fallback |
|---|---|---|
| General web search | SearXNG if explicitly enabled, otherwise Brave | Tavily → DuckDuckGo |
| Page fetch | Local safe fetch | Firecrawl when configured / requested |
| Basic research | Search + safe fetch | Provider fallback |
| Deep research | Tavily-oriented evidence | Search + fetch fallback |

Private SearXNG is allowed only when both variables are set:

```bash
export PI_SEARCH_SEARXNG_URL="http://<private-searxng-host>:8888"
export PI_SEARCH_ALLOW_PRIVATE_SEARXNG="always"
```

## Safety model

`pi-search` is a process-level safety layer. It is not a Docker, VM, or OS sandbox.

It focuses on practical defaults:

- child commands use `execFile`, not shell strings
- child processes get a minimal environment
- local search stays inside `cwd` unless explicitly allowed
- sensitive paths like `.env`, `.ssh`, and private keys are blocked
- web fetches validate URL, DNS, IP range, redirects, content type, size, and timeout
- fetched web content is marked as untrusted
- API key values are never shown in tool output
- optional research LLM only receives clipped evidence, not chat history

The implementation lives in `src/security.ts` and is covered by the test suite.

## AI agent setup prompt

Copy this into a new AI agent when you want it to install and configure `pi-search`:

```text
Install and configure pi-search for Pi Coding Agent.

Installation:
pi install npm:@leing2021/pi-search
Then restart pi or run /reload.

Available tools:
- search({ query, path? })
- web_search({ query, provider?, count? })
- web_fetch({ url })
- research_search({ query, mode?, maxSources? })

Use these environment variables when needed:

WEB_SEARCH:
BRAVE_SEARCH_API_KEY="brave_xxx"
TAVILY_API_KEY="tvly_xxx"
FIRECRAWL_API_KEY="fc_xxx"
PI_SEARCH_WEB_PROVIDER="auto"

PRIVATE_SEARCH:
PI_SEARCH_SEARXNG_URL="http://<private-searxng-host>:8888"
PI_SEARCH_ALLOW_PRIVATE_SEARXNG="always"

RESEARCH_LLM:
PI_SEARCH_LLM_ENABLED="always"
PI_SEARCH_LLM_PROVIDER="openai"
PI_SEARCH_LLM_MODEL="gpt-4o-mini"
PI_SEARCH_LLM_BASE_URL="https://api.openai.com/v1"
PI_SEARCH_LLM_API_KEY_ENV="OPENAI_API_KEY"
OPENAI_API_KEY="<OPENAI_API_KEY>"

LOCAL_SEARCH:
PI_SEARCH_ALLOW_OUTSIDE_CWD="always"
```

Research LLM notes:

- The prompt uses OpenAI as the default example.
- `PI_SEARCH_LLM_API_KEY_ENV` is the name of the environment variable that stores the API key. It is not the API key itself.
- For a local model, use an OpenAI-compatible API such as Ollama, LM Studio, or vLLM:

```bash
PI_SEARCH_LLM_PROVIDER="local-openai"
PI_SEARCH_LLM_MODEL="<local-model-name>"
PI_SEARCH_LLM_BASE_URL="http://<local-llm-host>:11434/v1"
PI_SEARCH_LLM_API_KEY_ENV="LOCAL_LLM_API_KEY"
LOCAL_LLM_API_KEY="<LOCAL_LLM_API_KEY_OR_DUMMY>"
```

Other OpenAI-compatible provider examples:

```bash
# OpenRouter
PI_SEARCH_LLM_PROVIDER="openai"
PI_SEARCH_LLM_MODEL="openai/gpt-4o-mini"
PI_SEARCH_LLM_BASE_URL="https://openrouter.ai/api/v1"
PI_SEARCH_LLM_API_KEY_ENV="OPENROUTER_API_KEY"
OPENROUTER_API_KEY="<OPENROUTER_API_KEY>"

# DeepSeek
PI_SEARCH_LLM_PROVIDER="openai"
PI_SEARCH_LLM_MODEL="deepseek-chat"
PI_SEARCH_LLM_BASE_URL="https://api.deepseek.com/v1"
PI_SEARCH_LLM_API_KEY_ENV="DEEPSEEK_API_KEY"
DEEPSEEK_API_KEY="<DEEPSEEK_API_KEY>"
```

## Project structure

```text
.
├── extensions/        # Pi extension entry
├── src/               # security, providers, research, text helpers
├── tests/             # node:test suite
├── package.json       # package metadata and Pi extension manifest
├── README.md          # English README
└── README_CN.md       # Chinese README
```

## Test

```bash
npm test
```

## What pi-search is not

- not a browser agent
- not a crawler
- not a multi-agent orchestrator
- not an OS-level sandbox
- not a general research framework

It is intentionally small: search, fetch, evidence, safety.

## License

MIT
