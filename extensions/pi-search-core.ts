/**
 * pi-search — Tool handlers and definitions (testable core)
 *
 * Separated from extension entry point for testability.
 * No Pi-specific imports; no TypeBox dependency.
 */

import {
	runCommand,
	safeFetchText,
	resolveSafePath,
	validateUrl,
} from "../src/security.ts";
import {
	webSearch,
	extractFirecrawl,
	type SearchResult,
} from "../src/providers.ts";
import {
	researchSearch,
	type ResearchReport,
} from "../src/research.ts";
import {
	detectPromptInjection,
	wrapUntrusted,
} from "../src/text.ts";

const MAX_CONTENT = 6000;
const MAX_RESULTS = 10;
const THIN_CONTENT_CHARS = 500;

type LocalSearchResult = {
	title: string;
	path: string;
	line?: string;
	column?: string;
	snippet: string;
};

function trunc(text: string, max = MAX_CONTENT): string {
	return text.length <= max ? text : text.slice(0, max) + `\n... (truncated, ${text.length} total chars)`;
}

/**
 * Activate proxy support for Node fetch (undici ignores HTTP(S)_PROXY env by default).
 * Mirrors the undici EnvHttpProxyAgent env contract (reads both cases, ignores ALL_PROXY)
 * so the guard never claims success when the agent would stay direct:
 *   - lowercase http(s)_proxy counts as configured (undici reads it)
 *   - ALL_PROXY with an http(s):// value is passed explicitly (undici skips ALL_PROXY)
 *   - ALL_PROXY with socks5:// is ignored — undici ProxyAgent is http-only
 * Safe to call multiple times; no proxy env leaves the dispatcher untouched.
 */
export async function initProxyDispatcher(
	env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
	const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
	const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
	const allProxy = env.ALL_PROXY ?? env.all_proxy;
	const isHttpUrl = (v?: string) => Boolean(v && /^https?:\/\//i.test(v));

	if (!httpProxy && !httpsProxy) {
		if (!isHttpUrl(allProxy)) return false;
	}
	try {
		const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
		const opts: { httpProxy?: string; httpsProxy?: string } = {};
		if (!httpProxy && isHttpUrl(allProxy)) opts.httpProxy = allProxy!;
		if (!httpsProxy && isHttpUrl(allProxy)) opts.httpsProxy = allProxy!;
		setGlobalDispatcher(new EnvHttpProxyAgent(opts));
		return true;
	} catch {
		return false; // undici unavailable — fetch stays direct
	}
}

function hasCJK(q: string): boolean {
	return /[\u4e00-\u9fff]/.test(q);
}

/**
 * Split a query into rg OR-pattern tokens.
 * ASCII words pass through; CJK runs become overlapping bigrams (single CJK chars pass through),
 * because Chinese words rarely appear verbatim in code/comments.
 */
function extractSearchTokens(query: string): string[] {
	const tokens: string[] = [];
	for (const part of query.split(/([\u4e00-\u9fff]+)/)) {
		if (!part) continue;
		if (hasCJK(part)) {
			if (part.length === 1) {
				tokens.push(part);
				continue;
			}
			for (let i = 0; i + 1 < part.length; i++) tokens.push(part.slice(i, i + 2));
		} else {
			tokens.push(...part.split(/\s+/).filter(Boolean));
		}
	}
	return tokens;
}

function looksLikeCode(q: string): boolean {
	if (hasCJK(q)) return false; // CJK text never matches code identifiers — always natural language
	const hasSpace = q.includes(" ");
	if (hasSpace) return /[{}()\[\]=<>:;%@#]/.test(q);
	return /[A-Z][a-z]+[A-Z]|_\w{2,}|\w+\.\w{2,}|\/\w+|[{}()\[\]=<>:;${}%@#]/.test(q) || q.length <= 20;
}

export async function handleSearch(
	params: { query: string; path?: string; engine?: string },
	deps?: { runCommand?: typeof runCommand; resolveSafePath?: (p: string, opts?: { cwd?: string; env?: Record<string, string | undefined> }) => string },
): Promise<{ results: LocalSearchResult[]; details: Record<string, unknown>; error?: { message: string } }> {
	const searchPath = params.path ?? ".";
	const engine = params.engine ?? "auto";
	const run = deps?.runCommand ?? runCommand;
	const resolvePath = deps?.resolveSafePath ?? resolveSafePath;

	try {
		resolvePath(searchPath);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			results: [],
			details: { engine: "blocked", query: params.query, path: searchPath, sandboxMode: "process-env-cwd-timeout", pathBlocked: true },
			error: { message: msg },
		};
	}

	const isCode = looksLikeCode(params.query);
	const cjk = hasCJK(params.query);
	let rgOutput = "";
	let usedEngine = "rg";

	try {
		if (isCode || engine === "rg") {
			const { stdout } = await run("rg", [
				"--max-count", "20",
				"--no-heading",
				"--column",
				"--color", "never",
				"--", params.query,
				searchPath,
			], {
				timeout: 10_000,
			});
			rgOutput = stdout;
		} else {
			const tokens = extractSearchTokens(params.query).slice(0, 8);
			const pattern = tokens.join("|");
			const { stdout } = await run("rg", [
				"--max-count", "20",
				"--no-heading",
				"--column",
				"--color", "never",
				"-i",
				"--", pattern,
				searchPath,
			], {
				timeout: 10_000,
			});
			rgOutput = stdout;
			usedEngine = cjk ? "rg-cjk-bigram" : "rg-multi-token";
		}
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException | null)?.code;
		const msg = err instanceof Error ? err.message : String(err);
		if (code === "ENOENT" || /spawn rg ENOENT/i.test(msg)) {
			return {
				results: [],
				details: {
					engine: "rg-missing",
					query: params.query,
					path: searchPath,
					sandboxMode: "process-env-cwd-timeout",
					rgAvailable: false,
					apiKeyExposed: false,
				},
				error: { message: "ripgrep (rg) not found in PATH. Install ripgrep, or use web_search for web sources." },
			};
		}
		usedEngine = isCode ? "rg" : (cjk ? "rg-cjk-bigram" : "rg-multi-token");
	}

	const results: LocalSearchResult[] = rgOutput
		.split("\n")
		.filter(Boolean)
		.slice(0, MAX_RESULTS)
		.map((line) => {
			const parts = line.split(":", 4);
			const filePath = parts[0] ?? "";
			return {
				title: filePath,
				path: filePath,
				line: parts[1],
				column: parts[2],
				snippet: trunc((parts.slice(3).join(":") ?? "").trim()),
			};
		});

	return {
		results,
		details: {
			engine: usedEngine,
			query: params.query,
			path: searchPath,
			sandboxMode: "process-env-cwd-timeout",
			resultCount: results.length,
			apiKeyExposed: false,
		},
	};
}

export async function handleWebSearch(
	params: { query: string; provider?: string; count?: number },
	deps?: { webSearch?: typeof webSearch },
): Promise<{ provider: string; results: SearchResult[]; details: Record<string, unknown> }> {
	const searchFn = deps?.webSearch ?? webSearch;
	const result = await searchFn({
		query: params.query,
		provider: params.provider ?? "auto",
		env: process.env as Record<string, string | undefined>,
	});

	if (!result.ok) {
		return {
			provider: "none",
			results: [],
			details: {
				provider: "none",
				providersAttempted: (result.error?.details as Record<string, unknown>)?.providersAttempted ?? [],
				querySentTo: (result.error?.details as Record<string, unknown>)?.querySentTo ?? [],
				fallbackReasons: (result.error?.details as Record<string, unknown>)?.fallbackReasons ?? [],
				error: result.error?.message ?? "All providers failed",
				apiKeyExposed: false,
			},
		};
	}

	const count = params.count ?? MAX_RESULTS;
	const results = result.data.slice(0, count);

	return {
		provider: result.provider,
		results,
		details: {
			provider: result.provider,
			providersAttempted: (result.details as Record<string, unknown>)?.providersAttempted ?? [result.provider],
			querySentTo: (result.details as Record<string, unknown>)?.querySentTo ?? [],
			fallbackReasons: (result.details as Record<string, unknown>)?.fallbackReasons ?? [],
			resultCount: results.length,
			apiKeyExposed: false,
		},
	};
}

async function defaultFirecrawlFetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status?: number; content?: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const res = await fetch(url, {
			method: opts?.method ?? 'POST',
			headers: opts?.headers,
			body: opts?.body,
			signal: controller.signal,
			redirect: 'manual',
		});
		clearTimeout(timer);
		const body = await res.text();
		return { ok: res.ok, status: res.status, content: body };
	} catch (err) {
		clearTimeout(timer);
		throw err;
	}
}

export async function handleWebFetch(
	params: { url: string; extract?: boolean },
	deps?: {
		fetch?: (url: string) => Promise<{ text: string; riskFlags: string[] }>;
		firecrawl?: ((url: string) => Promise<{ content: string; markdown?: string }>) | null;
		firecrawlFetch?: (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status?: number; content?: string }>;
		firecrawlApiKey?: string;
	},
): Promise<{ content: string; trust: string; details: Record<string, unknown> }> {
	const fetchFn = deps?.fetch ?? safeFetchText;
	const hasFcKey = Boolean(deps?.firecrawlApiKey ?? process.env.FIRECRAWL_API_KEY);
	const fcApiKey = deps?.firecrawlApiKey ?? process.env.FIRECRAWL_API_KEY ?? '';
	const fcFetch = deps?.firecrawlFetch ?? defaultFirecrawlFetch;

	const firecrawlFn = deps?.firecrawl !== undefined
		? deps.firecrawl
		: hasFcKey
			? async (url: string) => {
					const response = await fcFetch('https://api.firecrawl.dev/v1/scrape', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'Authorization': `Bearer ${fcApiKey}`,
						},
					body: JSON.stringify({ url, formats: ['markdown'] }),
					});
					if (!response.ok) {
						throw new Error(`Firecrawl API error: HTTP ${response.status ?? 'unknown'}`);
					}
					return extractFirecrawl({ apiKey: fcApiKey }, url, response.content ?? '');
				}
			: null;

	const allRiskFlags: string[] = [];
	let content = "";
	let extractor = "local";

	if (params.extract && firecrawlFn) {
		try {
			const fcResult = await firecrawlFn(params.url);
			content = fcResult.content || fcResult.markdown || "";
			extractor = "firecrawl";
		} catch {
			return {
				content: `[FetchError: failed to fetch ${params.url}]`,
				trust: "untrusted",
				details: { extractor: "failed", url: params.url, trust: "untrusted", riskFlags: allRiskFlags, apiKeyExposed: false },
			};
		}
	} else {
		try {
			const result = await fetchFn(params.url);
			if (typeof result === "string") {
				content = result;
			} else {
				content = result.text ?? "";
				if (result.riskFlags) allRiskFlags.push(...result.riskFlags);
			}
		} catch (localError) {
			// Security gate: validate URL before Firecrawl fallback
			// If the URL was rejected by security policy (HTTP, private IP, credentials),
			// do NOT bypass via Firecrawl — the security decision applies to the URL itself.
			try {
				await validateUrl(params.url);
			} catch {
				return {
					content: `[FetchError: failed to fetch ${params.url}]`,
					trust: "untrusted",
					details: { extractor: "failed", url: params.url, trust: "untrusted", riskFlags: allRiskFlags, apiKeyExposed: false },
				};
			}

			if (firecrawlFn) {
				try {
					const fcResult = await firecrawlFn(params.url);
					content = fcResult.content || fcResult.markdown || "";
					extractor = "firecrawl";
				} catch {
					return {
						content: `[FetchError: failed to fetch ${params.url}]`,
						trust: "untrusted",
						details: { extractor: "failed", url: params.url, trust: "untrusted", riskFlags: allRiskFlags, apiKeyExposed: false },
					};
				}
			} else {
				return {
					content: `[FetchError: failed to fetch ${params.url}]`,
					trust: "untrusted",
					details: { extractor: "failed", url: params.url, trust: "untrusted", riskFlags: allRiskFlags, apiKeyExposed: false },
				};
			}
		}
	}

	const injectionFlags = detectPromptInjection(content);
	allRiskFlags.push(...injectionFlags);
	if (extractor === "local" && content.length < THIN_CONTENT_CHARS) {
		allRiskFlags.push("thin-content-may-need-js");
	}

	const wrapped = wrapUntrusted(content);

	return {
		content: trunc(wrapped),
		trust: "untrusted",
		details: {
			extractor,
			url: params.url,
			trust: "untrusted",
			riskFlags: allRiskFlags,
			contentLength: content.length,
			apiKeyExposed: false,
		},
	};
}

export async function handleResearchSearch(
	params: { query: string; mode?: "basic" | "deep"; maxSources?: number },
	deps?: { researchSearch?: typeof researchSearch },
): Promise<ResearchReport> {
	const searchFn = deps?.researchSearch ?? researchSearch;
	return searchFn({
		query: params.query,
		mode: params.mode ?? "basic",
		maxSources: params.maxSources ?? 5,
		env: process.env as Record<string, string | undefined>,
	});
}

export const TOOL_NAMES = ["search", "web_search", "web_fetch", "research_search"] as const;
