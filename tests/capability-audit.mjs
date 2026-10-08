#!/usr/bin/env node
/**
 * pi-search capability audit — 真实网络 + 真实仓库，全场景矩阵
 * 输出: docs/reports/capability-audit.json + 控制台摘要
 * 运行: node --experimental-strip-types tests/capability-audit.mjs
 */
import { handleSearch, handleWebSearch, handleWebFetch, handleResearchSearch, initProxyDispatcher } from "../extensions/pi-search-core.ts";
import { writeFileSync, mkdirSync } from "node:fs";

// Mirror real pi load path: extension entry activates proxy routing at module load
await initProxyDispatcher();

const results = [];
const REPO = process.cwd();

async function timed(label, suite, fn) {
  const t0 = Date.now();
  let out;
  try {
    out = await fn();
  } catch (e) {
    out = { thrown: String(e?.message ?? e) };
  }
  const ms = Date.now() - t0;
  results.push({ id: label, suite, ms, ...out });
  return out;
}

// ---------- A. local search ----------
const searchCases = [
  ["A1.code-symbol", { query: "registerTool" }],
  ["A2.natural-en", { query: "redirect validation" }],
  ["A3.natural-zh-nospace", { query: "处理重定向的代码" }],
  ["A4.natural-zh-space", { query: "重定向 校验" }],
  ["A5.error-class", { query: "PiSearchError" }],
  ["A6.regexish", { query: "function.*fetch" }],
  ["A7.find-file", { query: "security 相关文件在哪" }],
  ["A8.sensitive-path", { query: "hello", path: ".env" }],
  ["A9.long-zh-sentence", { query: "如何处理网页内容的安全校验和截断逻辑" }],
];

for (const [id, params] of searchCases) {
  await timed(id, "search", async () => {
    const r = await handleSearch(params);
    const eng = r.details?.engine;
    return {
      engine: eng,
      count: r.results?.length ?? 0,
      top3: (r.results ?? []).slice(0, 3).map((x) => `${x.path}:${x.line}`),
      error: r.error?.message ?? null,
      // 质量信号: 命中行是否含查询 token
      relevance: (r.results ?? []).slice(0, 5).filter((x) =>
        params.query.split(/\s+/).some((t) => t.length > 3 && x.snippet.toLowerCase().includes(t.toLowerCase()))
      ).length,
    };
  });
}

// rg 缺失场景
await timed("A10.rg-missing", "search", async () => {
  const r = await handleSearch({ query: "registerTool" }, { runCommand: async () => { throw new Error("spawn rg ENOENT"); } });
  return { engine: r.details?.engine, count: r.results?.length ?? 0, error: r.error?.message ?? null, silentEmpty: r.results?.length === 0 && !r.error };
});

// ---------- B. web_search ----------
const webCases = [
  ["B1.en-general", { query: "rust async runtime comparison" }],
  ["B2.zh-general", { query: "大模型 上下文工程 实践" }],
  ["B3.error-msg", { query: "ERR_SSL_PROTOCOL_ERROR node fetch fix" }],
  ["B4.fresh", { query: "node 24 release notes" }],
  ["B5.api-doc", { query: "tokio select macro usage example" }],
  ["B6.no-result", { query: "zxqvqwerc asdkjhasd qwertyzz" }],
  ["B7.provider-duckduckgo", { query: "SSRF protection nodejs", provider: "duckduckgo" }],
  ["B8.provider-brave", { query: "SSRF protection nodejs", provider: "brave" }],
  ["B9.provider-tavily", { query: "SSRF protection nodejs", provider: "tavily" }],
  ["B10.provider-searxng", { query: "SSRF protection nodejs", provider: "searxng" }],
  ["B11.zh-error", { query: "报错 cannot find module 怎么解决" }],
  ["B12.code-snippet", { query: "javascript debounce function implementation" }],
];

for (const [id, params] of webCases) {
  await timed(id, "web_search", async () => {
    const r = await handleWebSearch(params);
    const res = r.results ?? [];
    return {
      provider: r.provider,
      count: res.length,
      fallbacks: r.details?.fallbackReasons ?? [],
      top3: res.slice(0, 3).map((x) => `${x.title.slice(0, 60)} | ${x.url.slice(0, 60)}`),
      snippetQuality: {
        withSnippet: res.filter((x) => (x.snippet ?? "").length > 40).length,
        emptySnippet: res.filter((x) => !(x.snippet ?? "").trim()).length,
      },
    };
  });
}

// ---------- C. web_fetch ----------
const fetchCases = [
  ["C1.normal-doc", "https://react.dev/blog"],
  ["C2.raw-md", "https://raw.githubusercontent.com/leing2021/pi-search/main/README.md"],
  ["C3.spa-page", "https://excalidraw.com/"],
  ["C4.big-wiki", "https://en.wikipedia.org/wiki/Node.js"],
  ["C5.pdf", "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"],
  ["C6.zh-page", "https://www.ruanyifeng.com/blog/2025/01/weekly-issue-328.html"],
  ["C7.403-protected", "https://www.zhihu.com/question/2641219127"],
  ["C8.http-redirect", "http://github.com"],
  ["C9.api-json", "https://api.github.com/repos/nodejs/node"],
];

for (const [id, url] of fetchCases) {
  await timed(id, "web_fetch", async () => {
    const r = await handleWebFetch({ url });
    const c = r.content ?? "";
    // 噪声信号: 导航/cookie/页脚关键词占比
    const noise = ["cookie", "sign in", "log in", "subscribe", "newsletter", "all rights reserved", "skip to content", "javascript"].filter((k) => c.toLowerCase().includes(k)).length;
    return {
      extractor: r.details?.extractor,
      ok: !c.startsWith("[FetchError"),
      contentLen: c.length,
      head120: c.slice(0, 120).replace(/\n/g, " "),
      noiseSignals: noise,
      riskFlags: r.details?.riskFlags ?? [],
    };
  });
}

// token 效率对比: 同页面 defuddle CLI vs pi-search（若装了 defuddle）
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
await timed("C10.extractor-compare", "web_fetch", async () => {
  const url = "https://en.wikipedia.org/wiki/Node.js";
  let defuddleLen = null;
  try {
    const { stdout } = await execFileAsync("defuddle", [url, "-o", "markdown"], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    defuddleLen = stdout.length;
  } catch (e) {
    defuddleLen = `unavailable: ${String(e?.message ?? e).slice(0, 80)}`;
  }
  const r = await handleWebFetch({ url });
  return { piSearchLen: (r.content ?? "").length, defuddleLen };
});

// ---------- D. research_search ----------
const researchCases = [
  ["D1.basic-en", { query: "SSRF protection best practices Node.js", mode: "basic" }],
  ["D2.deep-en", { query: "web search API comparison for AI agents 2025", mode: "deep" }],
  ["D3.zh", { query: "2025 前端构建工具对比 vite rspack", mode: "basic" }],
  ["D4.multi-hop", { query: "哪个开源搜索引擎在 2025 年 BERT 检索评测中得分最高，许可证是什么", mode: "basic" }],
  ["D5.no-result", { query: "zxqvqwerc asdkjhasd", mode: "basic" }],
];

for (const [id, params] of researchCases) {
  await timed(id, "research_search", async () => {
    const r = await handleResearchSearch(params);
    return {
      ok: r.ok,
      answerLen: (r.answer ?? "").length,
      answerHead: (r.answer ?? "").slice(0, 200),
      confidence: r.confidence,
      verification: r.verificationStatus,
      citations: (r.citations ?? []).length,
      citationDomains: [...new Set((r.citations ?? []).map((c) => { try { return new URL(c.url).hostname; } catch { return "?"; } }))],
    };
  });
}

// ---------- 输出 ----------
mkdirSync("docs/reports", { recursive: true });
const report = { generatedAt: new Date().toISOString(), repo: REPO, results };
writeFileSync("docs/reports/capability-audit.json", JSON.stringify(report, null, 2));

console.log("\n========== SUMMARY ==========");
for (const r of results) {
  const brief = JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !["id", "suite", "top3", "head120", "answerHead"].includes(k)).slice(0, 8)));
  console.log(`[${r.suite}] ${r.id} (${r.ms}ms) ${brief}`);
}
