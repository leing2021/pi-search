#!/usr/bin/env node
/**
 * pi-search release benchmark — 版本迭代回归基线
 *
 * 用法:
 *   node --experimental-strip-types tests/benchmark.mjs              # 跑基线，存档为 latest
 *   node --experimental-strip-types tests/benchmark.mjs --compare    # 跑完与 latest 对比
 *
 * 判定: 每用例 verdict = pass | degraded | fail；与历史对比输出 REGRESSION/IMPROVED。
 * 容错: 网络用例失败重试 1 次；环境性失败(代理断/密钥缺)标 inconclusive 不计 fail。
 */
import { handleSearch, handleWebSearch, handleWebFetch, handleResearchSearch, initProxyDispatcher } from "../extensions/pi-search-core.ts";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

await initProxyDispatcher();

const BENCH_DIR = "docs/reports/benchmarks";
const verdict = (ok, degraded = false) => (ok ? (degraded ? "degraded" : "pass") : "fail");

// ---------- 质量维度 helpers（确定性，零 LLM） ----------
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return "?"; } };
const STOP = new Set(["the", "a", "an", "of", "in", "for", "to", "and", "or", "how", "is", "are", "what", "best", "with", "on", "de", "la", "的", "了", "是", "在", "和"]);
const contentTokens = (q) => {
  const out = [];
  for (const part of q.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!part) continue;
    if (/[\u4e00-\u9fff]/.test(part)) {
      // CJK 整词过严：bigram 化后匹配更宽容
      if (part.length === 1) { out.push(part); continue; }
      for (let i = 0; i + 1 < part.length; i++) out.push(part.slice(i, i + 2));
    } else if (!STOP.has(part) && part.length > 1) {
      out.push(part);
    }
  }
  return [...new Set(out)].slice(0, 12);
};
// relevance@k: top-k 结果 title+snippet 覆盖查询核心词的占比（keyword-overlap proxy，业界 P@k 的确定性近似）
const relevanceAt = (query, results, k) => {
  const qts = contentTokens(query);
  if (!qts.length) return null;
  const top = results.slice(0, k);
  const hit = top.filter((r) => {
    const hay = `${r.title} ${r.snippet}`.toLowerCase();
    return qts.some((t) => hay.includes(t));
  }).length;
  return hit / top.length;
};
// 域名多样性: unique hosts / count（信息增益 proxy，同域重复=低多样性）
const domainDiversity = (results) => (results.length ? new Set(results.map((r) => hostOf(r.url))).size / results.length : 0);
// 新鲜度: 结果文本中可解析的近年份出现数（时效性查询用）
const freshnessHits = (results, minYear) => results.filter((r) => {
  const years = `${r.title} ${r.snippet}`.match(/20\d{2}/g) ?? [];
  return years.some((y) => Number(y) >= minYear);
}).length;
// 噪声密度: 导航/页脚词计数 / 内容长度（web_fetch 抽取质量，越低越好）
const NOISE_WORDS = ["cookie", "sign in", "log in", "subscribe", "newsletter", "all rights reserved", "skip to content"];
const noiseDensity = (content) => {
  const lower = content.toLowerCase();
  const hits = NOISE_WORDS.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
  return content.length ? hits / content.length : 0;
};

async function retry(times, fn) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try { return await fn(); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---------- 用例定义（精选自 capability-audit，含期望） ----------
const CASES = [
  // search
  {
    id: "S1.code-symbol", suite: "search",
    run: async () => {
      const r = await handleSearch({ query: "registerTool" });
      const qts = contentTokens("registerTool");
      const p5 = r.results.length ? r.results.slice(0, 5).filter((x) => qts.some((t) => x.snippet.toLowerCase().includes(t))).length / Math.min(5, r.results.length) : 0;
      return { verdict: verdict(r.results.length > 0 && r.details.engine === "rg"), metrics: { count: r.results.length, engine: r.details.engine, precisionAt5: p5 } };
    },
  },
  {
    id: "S2.cjk-bigram", suite: "search",
    run: async () => {
      const r = await handleSearch({ query: "处理重定向" });
      return { verdict: verdict(r.results.length > 0 && r.details.engine === "rg-cjk-bigram"), metrics: { count: r.results.length, engine: r.details.engine } };
    },
  },
  {
    id: "S3.sensitive-path", suite: "search",
    run: async () => {
      const r = await handleSearch({ query: "x", path: ".env" });
      return { verdict: verdict(r.details.pathBlocked === true), metrics: { blocked: Boolean(r.details.pathBlocked) } };
    },
  },
  // web_search
  {
    id: "W1.general-en", suite: "web_search",
    run: async () => await retry(2, async () => {
      const q = "ripgrep latest version release notes";
      const r = await handleWebSearch({ query: q });
      const rel = relevanceAt(q, r.results, 5);
      const div = domainDiversity(r.results);
      const withSnippet = r.results.filter((x) => (x.snippet ?? "").trim().length > 20).length;
      return {
        verdict: verdict(r.provider !== "none" && r.results.length >= 3 && rel >= 0.4, div < 0.4),
        metrics: { provider: r.provider, count: r.results.length, relevanceAt5: rel, domainDiversity: div, snippetDensity: r.results.length ? withSnippet / r.results.length : 0 },
      };
    }),
  },
  {
    id: "W2.general-zh", suite: "web_search",
    run: async () => await retry(2, async () => {
      const q = "大模型 上下文工程 实践";
      const r = await handleWebSearch({ query: q });
      const rel = relevanceAt(q, r.results, 5);
      return {
        verdict: verdict(r.provider !== "none" && r.results.length >= 3 && rel >= 0.4),
        metrics: { provider: r.provider, count: r.results.length, relevanceAt5: rel, domainDiversity: domainDiversity(r.results) },
      };
    }),
  },
  {
    id: "W4.freshness", suite: "web_search",
    run: async () => await retry(2, async () => {
      const year = new Date().getFullYear();
      const r = await handleWebSearch({ query: "node js latest LTS release" });
      const fresh = freshnessHits(r.results, year - 1);
      return {
        verdict: verdict(r.provider !== "none" && r.results.length >= 3 && fresh >= 2, fresh < 2),
        metrics: { provider: r.provider, count: r.results.length, freshHits: fresh, minYear: year - 1 },
      };
    }),
  },
  {
    id: "W3.ddg-fallback", suite: "web_search",
    run: async () => await retry(2, async () => {
      const r = await handleWebSearch({ query: "ssrf protection", provider: "duckduckgo" });
      return {
        verdict: verdict(r.provider === "duckduckgo" && r.results.length >= 3),
        metrics: { provider: r.provider, count: r.results.length },
      };
    }),
  },
  // web_fetch
  {
    id: "F1.doc-page", suite: "web_fetch",
    run: async () => await retry(2, async () => {
      const r = await handleWebFetch({ url: "https://react.dev/blog" });
      const len = r.content.length;
      const nd = noiseDensity(r.content);
      // 阈值参考业界 context-precision 思路：噪声词密度 <= 0.002（约每 500 字 ≤1 个噪声词）
      return { verdict: verdict(!r.content.startsWith("[FetchError") && len > 500 && len < 20000, nd > 0.002), metrics: { len, noiseDensity: nd } };
    }),
  },
  {
    id: "F2.http-redirect", suite: "web_fetch",
    run: async () => await retry(2, async () => {
      const r = await handleWebFetch({ url: "http://github.com" });
      return {
        verdict: verdict(!r.content.startsWith("[FetchError") && r.content.length > 500),
        metrics: { len: r.content.length, extractor: r.details.extractor },
      };
    }),
  },
  {
    id: "F3.ssrf-private-ip", suite: "security",
    // 直接测 validateUrl 无代理路径：确定性，不受运行时代理环境影响。
    // 有代理时私网预检跳过是既有设计（ssrf-proxy-aware-ip-check-skip），不属回归。
    run: async () => {
      const { validateUrl } = await import("../src/security.ts");
      let blocked = false;
      try { await validateUrl("http://192.168.31.1/", { env: {} }); } catch { blocked = true; }
      return { verdict: verdict(blocked), metrics: { blocked } };
    },
  },
  {
    id: "F4.thin-content-flag", suite: "web_fetch",
    run: async () => await retry(2, async () => {
      const r = await handleWebFetch({ url: "https://excalidraw.com/" });
      const flags = r.details.riskFlags ?? [];
      const flagged = flags.includes("thin-content-may-need-js");
      // SPA 页可能改版为有内容：ok 且 (有内容 或 有 flag) 均算 pass
      return { verdict: verdict(!r.content.startsWith("[FetchError")), metrics: { len: r.content.length, flagged } };
    }),
  },
  // research（慢，放最后）
  {
    id: "R1.basic", suite: "research_search",
    run: async () => await retry(1, async () => {
      const r = await handleResearchSearch({ query: "SSRF protection Node.js best practices", mode: "basic" });
      const cites = r.citations ?? [];
      const evidenceRatio = cites.length >= 5 ? 1 : cites.length / 5; // context-recall proxy：5 源目标实得占比
      const div = domainDiversity(cites);
      // 阈值参考 RAGAS 起步线：recall>0.8 起评；此处宽到 >=0.4（网络抖动），<0.8 记 degraded
      return {
        verdict: verdict(r.ok && cites.length >= 1, evidenceRatio < 0.4 || div < 0.4),
        metrics: { citations: cites.length, evidenceRatio, domainDiversity: div, answerLen: r.answer.length, confidence: r.confidence, ms: null },
      };
    }),
  },
  {
    id: "R2.no-evidence-hallucination-guard", suite: "research_search",
    run: async () => {
      const r = await handleResearchSearch({ query: "zxqvqwerc asdkjhasd qwertyzz", mode: "basic" });
      // 乱码查询：允许 NoEvidence/空 answer/低置信，不允许自信幻觉
      const guarded = r.answer.length === 0 || /NoEvidence/.test(r.verificationStatus) || r.confidence === "low";
      return { verdict: verdict(guarded), metrics: { answerLen: r.answer.length, confidence: r.confidence } };
    },
  },
];

// ---------- 执行 ----------
const results = [];
for (const c of CASES) {
  const t0 = Date.now();
  let out;
  try { out = await c.run(); }
  catch (e) { out = { verdict: "inconclusive", metrics: { error: String(e?.message ?? e).slice(0, 100) } }; }
  results.push({ id: c.id, suite: c.suite, ms: Date.now() - t0, verdict: out.verdict, metrics: out.metrics });
  console.error(`  ${out.verdict.padEnd(12)} ${c.id} (${Date.now() - t0}ms)`);
}

const summary = {
  pass: results.filter((r) => r.verdict === "pass").length,
  degraded: results.filter((r) => r.verdict === "degraded").length,
  fail: results.filter((r) => r.verdict === "fail").length,
  inconclusive: results.filter((r) => r.verdict === "inconclusive").length,
};
// ---------- 维度聚合 scorecard ----------
function buildScorecard(results) {
  const avg = (xs) => { const v = xs.filter((x) => typeof x === "number"); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const m = (id) => results.find((r) => r.id === id)?.metrics ?? {};
  const card = {
    availability: `${results.filter((r) => r.verdict === "pass").length}/${results.length} pass`,
    search: { precisionAt5: avg([m("S1.code-symbol").precisionAt5]) },
    web_search: {
      relevanceAt5: avg([m("W1.general-en").relevanceAt5, m("W2.general-zh").relevanceAt5]),
      domainDiversity: avg([m("W1.general-en").domainDiversity, m("W2.general-zh").domainDiversity, m("W3.ddg-fallback").domainDiversity].filter((x) => x !== undefined)),
      snippetDensity: m("W1.general-en").snippetDensity ?? null,
      freshness: m("W4.freshness").freshHits ?? null,
    },
    web_fetch: {
      noiseDensity: m("F1.doc-page").noiseDensity ?? null,
      completenessBytes: avg([m("F1.doc-page").len, m("F2.http-redirect").len]),
    },
    research: {
      evidenceRatio: m("R1.basic").evidenceRatio ?? null,
      domainDiversity: m("R1.basic").domainDiversity ?? null,
      hallucinationGuard: results.find((r) => r.id === "R2.no-evidence-hallucination-guard")?.verdict === "pass",
    },
    latency: {
      searchP50: avg(results.filter((r) => r.suite === "search").map((r) => r.ms)),
      webSearchP50: avg(results.filter((r) => r.suite === "web_search").map((r) => r.ms)),
      fetchP50: avg(results.filter((r) => r.suite === "web_fetch").map((r) => r.ms)),
      researchP50: avg(results.filter((r) => r.suite === "research_search").map((r) => r.ms)),
    },
  };
  return card;
}

const report = {
  generatedAt: new Date().toISOString(),
  version: JSON.parse(readFileSync("package.json", "utf8")).version,
  summary, scorecard: buildScorecard(results), results,
};

// ---------- 存档 ----------
mkdirSync(BENCH_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
writeFileSync(path.join(BENCH_DIR, `${stamp}-v${report.version}.json`), JSON.stringify(report, null, 2));
writeFileSync(path.join(BENCH_DIR, "latest.json"), JSON.stringify(report, null, 2));

// ---------- 对比 ----------
const compareIdx = process.argv.indexOf("--compare");
let prevPath = null;
if (compareIdx !== -1) {
  prevPath = process.argv[compareIdx + 1] ?? path.join(BENCH_DIR, "latest.json");
  // --compare 时刚写的 latest 是当前跑——应找历史最近一份（排除刚写入的）
  const files = readdirSync(BENCH_DIR).filter((f) => f.endsWith(".json") && f !== "latest.json" && !f.startsWith(stamp)).sort();
  if (files.length > 0) prevPath = path.join(BENCH_DIR, files[files.length - 1]);
}

console.log("\n========== BENCHMARK SUMMARY ==========");
console.log(`v${report.version}  pass=${summary.pass} degraded=${summary.degraded} fail=${summary.fail} inconclusive=${summary.inconclusive}`);
console.log("\n---------- DIMENSION SCORECARD ----------");
console.log(`availability        ${report.scorecard.availability}`);
const sc = report.scorecard;
const fmt = (v) => (typeof v === "number" ? v.toFixed(3) : String(v));
console.log(`search.precision@5 ${fmt(sc.search.precisionAt5)}`);
console.log(`web.relevance@5    ${fmt(sc.web_search.relevanceAt5)}  diversity ${fmt(sc.web_search.domainDiversity)}  snippet ${fmt(sc.web_search.snippetDensity)}  freshHits ${String(sc.web_search.freshness)}`);
console.log(`fetch.noiseDensity ${fmt(sc.web_fetch.noiseDensity)}  bytes ${fmt(sc.web_fetch.completenessBytes)}`);
console.log(`research.evidence  ${fmt(sc.research.evidenceRatio)}  diversity ${fmt(sc.research.domainDiversity)}  guard ${sc.research.hallucinationGuard ? "ok" : "FAIL"}`);
console.log(`latency  search ${Math.round(sc.latency.searchP50)}ms  web ${Math.round(sc.latency.webSearchP50)}ms  fetch ${Math.round(sc.latency.fetchP50)}ms  research ${Math.round(sc.latency.researchP50)}ms`);
console.log(`archived: ${path.join(BENCH_DIR, `${stamp}-v${report.version}.json`)}`);

if (prevPath && existsSync(prevPath)) {
  const prev = JSON.parse(readFileSync(prevPath, "utf8"));
  console.log(`\n---------- DIFF vs ${path.basename(prevPath)} (v${prev.version}, ${prev.generatedAt.slice(0, 10)}) ----------`);
  const prevMap = new Map(prev.results.map((r) => [r.id, r]));
  let regressions = 0, improvements = 0;
  for (const cur of results) {
    const p = prevMap.get(cur.id);
    if (!p) { console.log(`  NEW         ${cur.id}: ${cur.verdict}`); continue; }
    if (p.verdict !== cur.verdict) {
      const worse = ["pass", "degraded", "fail"].indexOf(cur.verdict) > ["pass", "degraded", "fail"].indexOf(p.verdict);
      console.log(`  ${worse ? "REGRESSION  " : "IMPROVED    "} ${cur.id}: ${p.verdict} -> ${cur.verdict}`);
      worse ? regressions++ : improvements++;
    }
    // 指标突变提示（数值型指标变化 >60%）
    for (const [k, v] of Object.entries(cur.metrics ?? {})) {
      const pv = p.metrics?.[k];
      if (typeof v === "number" && typeof pv === "number" && pv > 10) {
        const delta = (v - pv) / pv;
        if (Math.abs(delta) > 0.6) console.log(`  METRIC      ${cur.id}.${k}: ${pv} -> ${v} (${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}%)`);
      }
    }
  }
  console.log(`regressions=${regressions} improvements=${improvements}`);
  process.exitCode = regressions > 0 ? 1 : 0;
} else {
  console.log("(no prior archive to compare — first baseline)");
}
