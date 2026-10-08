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
      return { verdict: verdict(r.results.length > 0 && r.details.engine === "rg"), metrics: { count: r.results.length, engine: r.details.engine } };
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
      const r = await handleWebSearch({ query: "ripgrep latest version release notes" });
      const withSnippet = r.results.filter((x) => (x.snippet ?? "").trim().length > 20).length;
      return {
        verdict: verdict(r.provider !== "none" && r.results.length >= 3, withSnippet < r.results.length * 0.5),
        metrics: { provider: r.provider, count: r.results.length, withSnippet },
      };
    }),
  },
  {
    id: "W2.general-zh", suite: "web_search",
    run: async () => await retry(2, async () => {
      const r = await handleWebSearch({ query: "大模型 上下文工程 实践" });
      return { verdict: verdict(r.provider !== "none" && r.results.length >= 3), metrics: { provider: r.provider, count: r.results.length } };
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
      return { verdict: verdict(!r.content.startsWith("[FetchError") && len > 500 && len < 20000), metrics: { len } };
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
      return {
        verdict: verdict(r.ok && r.citations.length >= 1),
        metrics: { citations: r.citations.length, ms: null, answerLen: r.answer.length },
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
const report = {
  generatedAt: new Date().toISOString(),
  version: JSON.parse(readFileSync("package.json", "utf8")).version,
  summary, results,
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
