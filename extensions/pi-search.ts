/**
 * pi-search — Minimal Secure Evidence Gateway Extension for Pi Coding Agent
 *
 * Registers exactly 4 tools: search, web_search, web_fetch, research_search
 *
 * Security model:
 *   - All external content marked as UNTRUSTED
 *   - apiKeyExposed always false
 *   - Second LLM (research) sees only clipped evidence, never full context
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import {
	handleSearch,
	handleWebSearch,
	handleWebFetch,
	handleResearchSearch,
	initProxyDispatcher,
	TOOL_NAMES,
} from "./pi-search-core.ts";

export default function (pi: ExtensionAPI) {
	// Node fetch ignores HTTP(S)_PROXY env by default; activate proxy routing early.
	void initProxyDispatcher();

	pi.registerTool({
		name: "search",
		label: "Search",
		description: "Search local codebase using ripgrep. Code-like queries use exact match; natural language uses multi-token OR fallback; CJK queries use bigram matching. No mgrep.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query: symbol, pattern, or natural language" }),
			path: Type.Optional(Type.String({ description: "Directory to search (default: cwd)" })),
			engine: Type.Optional(Type.String({ description: "Force engine: auto|rg (default: auto)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await handleSearch(params);
			const text = result.results.length > 0
				? result.results.map((r) => `${r.title}: ${r.snippet}`).join("\n")
				: result.error?.message ?? "No results found";
			return {
				content: [{ type: "text" as const, text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web with intent-based routing. Providers: SearXNG (private) → Brave → Tavily → DuckDuckGo. Quota-aware fallback.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			provider: Type.Optional(Type.String({ description: "Force provider: auto|brave|tavily|searxng|duckduckgo (default: auto)" })),
			count: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await handleWebSearch(params);
			const text = result.results.length > 0
				? result.results.map((r) => `[${r.title}](${r.url}) — ${r.snippet}`).join("\n")
				: `No results (provider: ${result.provider})`;
			return {
				content: [{ type: "text" as const, text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch and extract content from a URL. Local safe fetch first, Firecrawl fallback. All content marked UNTRUSTED.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			extract: Type.Optional(Type.Boolean({ description: "Force Firecrawl extraction" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await handleWebFetch(params);
			return {
				content: [{ type: "text" as const, text: result.content }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: "research_search",
		label: "Research Search",
		description: "Deep research with evidence collection and optional LLM verification. Basic mode: search + local fetch. Deep mode: Tavily + Firecrawl + LLM.",
		parameters: Type.Object({
			query: Type.String({ description: "Research query" }),
			mode: Type.Optional(Type.String({ description: "basic|deep (default: basic)" })),
			maxSources: Type.Optional(Type.Number({ description: "Max evidence sources (default: 5)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await handleResearchSearch(params);
			// Surface real verification status: disabled vs failed (with error class) vs empty answer
			const statusPrefix = result.answer
				? ""
				: `${result.verificationStatus ?? "[VERIFICATION DISABLED]"}\n`;
			const text = result.answer
				? result.answer + "\n\nCitations:\n" + result.citations.map((c) => `[${c.id}] ${c.title} — ${c.url}`).join("\n")
				: statusPrefix + "Evidence collected:\n" + result.citations.map((c) => `[${c.id}] ${c.title} — ${c.url}`).join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: result.details,
			};
		},
	});
}
