# pi-search

[English](README.md)

一个为 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 设计的最小化安全证据网关。

`pi-search` 为 Agent 提供四个专注的工具：

- `search` — 用 ripgrep 搜索本地仓库
- `web_search` — 通过路由后的 provider 查找网页来源
- `web_fetch` — 安全抓取并清理单个网页
- `research_search` — 收集网页证据，可选 LLM 验证

它的目标是简单、可审计，并且默认安全。

## 安装

```bash
pi install npm:@leing2021/pi-search
# 重启 pi 或执行 /reload
```

本包通过 `package.json` 暴露 Pi extension：

```json
{
  "pi": {
    "extensions": ["extensions/pi-search.ts"]
  }
}
```

## 快速使用

```ts
search({ query: "registerTool" })

web_search({ query: "React 19 features" })

web_fetch({ url: "https://react.dev/blog" })

research_search({ query: "SSRF protection in Node.js" })
```

## 工具

| 工具 | 用途 | 默认行为 |
|---|---|---|
| `search` | 本地仓库搜索 | 使用 `ripgrep`；默认阻止不安全路径 |
| `web_search` | 网页来源发现 | 通过 SearXNG / Brave / Tavily / DuckDuckGo 路由 |
| `web_fetch` | 安全网页抓取 | http(s)、SSRF 检查、重定向检查、HTML 清理 |
| `research_search` | 证据收集 | LLM 验证默认关闭，需显式启用 |

## 配置

所有配置都是可选的。只设置你需要的部分。

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

### 代理说明

设置了 `HTTPS_PROXY` / `HTTP_PROXY`（大小写均可）或 `ALL_PROXY`（仅 http(s)://）时，
pi-search 会在扩展加载时安装 undici `EnvHttpProxyAgent` 作为全局 fetch
dispatcher。这会影响宿主进程内所有 `fetch`，与 curl 风格的 env 代理语义一致。
如需回环/内网流量直连，设置 `NO_PROXY=localhost,127.0.0.1`。

## Provider 路由

`pi-search` 使用任务感知路由，而不是广泛 fan-out。

| 任务 | 优先路径 | 回退 |
|---|---|---|
| 通用网页搜索 | 显式启用 SearXNG 时使用 SearXNG，否则 Brave | Tavily → DuckDuckGo |
| 网页抓取 | 本地 safe fetch | 配置或请求时使用 Firecrawl |
| 基础研究 | Search + safe fetch | Provider fallback |
| 深度研究 | Tavily-oriented evidence | Search + fetch fallback |

私有 SearXNG 只有在同时设置两个变量时才允许：

```bash
export PI_SEARCH_SEARXNG_URL="http://<private-searxng-host>:8888"
export PI_SEARCH_ALLOW_PRIVATE_SEARXNG="always"
```

## 安全模型

`pi-search` 是进程级安全层，不是 Docker、VM 或操作系统级沙箱。

它关注实用的安全默认值：

- 子命令使用 `execFile`，不使用 shell string
- 子进程只获得最小环境变量
- 本地搜索默认限制在 `cwd` 内，除非显式允许
- 默认阻止 `.env`、`.ssh`、私钥等敏感路径
- 网页抓取会校验 URL、DNS、IP 范围、重定向、Content-Type、大小和超时
- 抓取到的网页内容会标记为 untrusted
- 工具输出不会显示 API key 值
- 可选 research LLM 只接收裁剪后的 evidence，不接收聊天历史

实现位于 `src/security.ts`，并由测试套件覆盖。

## AI Agent 配置提示词

如果你希望一个新的 AI Agent 安装并配置 `pi-search`，可以复制下面这段：

```text
为 Pi Coding Agent 安装并配置 pi-search。

安装：
pi install npm:@leing2021/pi-search
然后重启 pi，或执行 /reload。

可用工具：
- search({ query, path? })
- web_search({ query, provider?, count? })
- web_fetch({ url })
- research_search({ query, mode?, maxSources? })

需要时使用以下环境变量：

网页搜索：
BRAVE_SEARCH_API_KEY="brave_xxx"
TAVILY_API_KEY="tvly_xxx"
FIRECRAWL_API_KEY="fc_xxx"
PI_SEARCH_WEB_PROVIDER="auto"

私有搜索：
PI_SEARCH_SEARXNG_URL="http://<private-searxng-host>:8888"
PI_SEARCH_ALLOW_PRIVATE_SEARXNG="always"

研究 LLM：
PI_SEARCH_LLM_ENABLED="always"
PI_SEARCH_LLM_PROVIDER="openai"
PI_SEARCH_LLM_MODEL="gpt-4o-mini"
PI_SEARCH_LLM_BASE_URL="https://api.openai.com/v1"
PI_SEARCH_LLM_API_KEY_ENV="OPENAI_API_KEY"
OPENAI_API_KEY="<OPENAI_API_KEY>"

本地搜索：
PI_SEARCH_ALLOW_OUTSIDE_CWD="always"
```

研究 LLM 说明：

- 提示词里以 OpenAI 为例。
- `PI_SEARCH_LLM_API_KEY_ENV` 填的是“保存密钥的环境变量名”，不是密钥本身。
- 本地模型请使用 OpenAI-compatible API，例如 Ollama、LM Studio、vLLM：

```bash
PI_SEARCH_LLM_PROVIDER="local-openai"
PI_SEARCH_LLM_MODEL="<local-model-name>"
PI_SEARCH_LLM_BASE_URL="http://<local-llm-host>:11434/v1"
PI_SEARCH_LLM_API_KEY_ENV="LOCAL_LLM_API_KEY"
LOCAL_LLM_API_KEY="<LOCAL_LLM_API_KEY_OR_DUMMY>"
```

其他 OpenAI-compatible 服务示例：

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

## 项目结构

```text
.
├── extensions/        # Pi extension 入口
├── src/               # security、providers、research、text helpers
├── tests/             # node:test 测试
├── package.json       # package metadata 和 Pi extension manifest
├── README.md          # 英文 README
└── README_CN.md       # 中文 README
```

## 测试

```bash
npm test        # 单测（109）
npm run bench   # 发布基线：固定用例矩阵，自动与上一份存档基线对比
```

基线存档在 `docs/reports/benchmarks/`（gitignore）；`latest.json` 始终指向最近一次。
发现回归时退出码为 1。

## pi-search 不是什么

- 不是浏览器 Agent
- 不是爬虫
- 不是多 Agent 编排器
- 不是操作系统级沙箱
- 不是通用研究框架

它刻意保持很小：搜索、抓取、证据、安全。

## License

MIT
