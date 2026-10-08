#!/usr/bin/env node
/** 针对性根因诊断 */
import { safeFetchText, validateUrl } from "../src/security.ts";

const d = async (label, fn) => {
  try { const r = await fn(); console.log(`[OK] ${label}`, r); }
  catch (e) { console.log(`[FAIL] ${label}:`, e?.name, e?.message, JSON.stringify(e?.details ?? {})); }
};

// 1. wikipedia local fetch 为何失败
await d("wiki-local", async () => {
  const r = await safeFetchText("https://en.wikipedia.org/wiki/Node.js", { timeoutMs: 8000 });
  return `len=${r.text.length} flags=${r.riskFlags.join(",")}`;
});

// 2. raw.githubusercontent local
await d("raw-md-local", async () => {
  const r = await safeFetchText("https://raw.githubusercontent.com/leing2021/pi-search/main/README.md", { timeoutMs: 8000 });
  return `len=${r.text.length}`;
});

// 3. GBK 编码页面（qq.com 老站多为 GBK）
await d("gbk-page", async () => {
  const r = await safeFetchText("https://www.qq.com", { timeoutMs: 8000 });
  return `len=${r.text.length} head=${r.text.slice(30, 90)}`;
});

// 4. DDG 直连
await d("ddg-direct", async () => {
  const r = await safeFetchText("https://html.duckduckgo.com/html/?q=test", { timeoutMs: 8000 });
  return `len=${r.text.length}`;
});

// 5. HTTP 重定向（github http→https）
await d("http-redirect", async () => validateUrl("http://github.com").then((v) => v.url.href));

// 6. http bin 重定向链
await d("http-bin-redirect", async () => {
  const r = await safeFetchText("http://httpbin.org/redirect/2", { timeoutMs: 8000 });
  return `final=${r.url} len=${r.text.length}`;
});

// 7. research 的 fetchError 情况：手动模拟 research 内部流程，统计失败率
import { handleWebSearch } from "../extensions/pi-search-core.ts";
const sr = await handleWebSearch({ query: "SSRF protection best practices Node.js" });
console.log("[research-fetch-test] search provider:", sr.provider, "urls:", sr.results.map((r) => r.url));
let ok = 0, fail = 0;
for (const r of sr.results.slice(0, 5)) {
  try { await safeFetchText(r.url, { timeoutMs: 8000 }); ok++; }
  catch { fail++; console.log("  [fetch-fail]", r.url); }
}
console.log(`[research-fetch-test] local fetch: ok=${ok} fail=${fail}`);

// 8. HTTP_PROXY 环境下 Node fetch 是否走代理
console.log("[proxy-env] HTTPS_PROXY =", process.env.HTTPS_PROXY ?? "(unset)", "| HTTP_PROXY =", process.env.HTTP_PROXY ?? "(unset)", "| ALL_PROXY =", process.env.ALL_PROXY ?? "(unset)");
