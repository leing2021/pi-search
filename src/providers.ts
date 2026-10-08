export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type ProviderConfig = {
  hasSearxng: boolean;
  hasBrave: boolean;
  hasTavily: boolean;
  hasFirecrawl: boolean;
  searxngUrl?: string;
};

type QuotaState = {
  until: number;
  reason: string;
};

const QUOTA_TTL_MS = 10 * 60 * 1000; // 10 minutes
const NETWORK_TTL_MS = 2 * 60 * 1000; // 2 minutes for connection-refused-type failures

const quotaStates = new Map<string, QuotaState>();

export function resetAllCooldowns(): void {
  quotaStates.clear();
}

function recordQuota(provider: string, reason: string, ttlMs: number): void {
  quotaStates.set(provider, { until: Date.now() + ttlMs, reason });
}

export function recordProviderQuota(provider: string, reason: string): void {
  recordQuota(provider, reason, QUOTA_TTL_MS);
}

function isQuotaExpired(state: QuotaState): boolean {
  return Date.now() >= state.until;
}

export function isProviderAvailable(provider: string): boolean {
  const state = quotaStates.get(provider);
  if (!state) return true;
  if (isQuotaExpired(state)) {
    quotaStates.delete(provider);
    return true;
  }
  return false;
}

export function recordProviderFailure(provider: string, errorMessage: string): void {
  const lower = errorMessage.toLowerCase();
  const isConnectionFailure =
    lower.includes('econnrefused') ||
    lower.includes('ehostunreach') ||
    lower.includes('enetunreach') ||
    lower.includes('connection refused') ||
    lower.includes('network is unreachable') ||
    lower.includes('connection reset') ||
    lower.includes('fetch failed') ||
    lower.includes('enotfound') ||
    lower.includes('getaddrinfo');

  if (isConnectionFailure) {
    recordQuota(provider, `connection failure: ${errorMessage}`, NETWORK_TTL_MS);
  }
}

function isQuotaError(status: number, bodyText: string): boolean {
  return (
    status === 429 ||
    status === 402 ||
    status === 403 ||
    status === 1015 ||
    bodyText.toLowerCase().includes('rate limit') ||
    bodyText.toLowerCase().includes('quota') ||
    bodyText.toLowerCase().includes('credits') ||
    bodyText.toLowerCase().includes('limit reached') ||
    bodyText.toLowerCase().includes('monthly limit')
  );
}

function classifyResponseError(status: number, bodyText: string, isJson: boolean): 'quota' | 'auth' | 'network' | 'parse' | 'other' {
  if (status === 401 || status === 403 || bodyText.toLowerCase().includes('invalid api key') || bodyText.toLowerCase().includes('unauthorized')) return 'auth';
  if (isQuotaError(status, bodyText)) return 'quota';
  if (!isJson) return 'parse';
  return 'network';
}

export function detectProviderConfig(env: Record<string, string | undefined>): ProviderConfig {
  const hasSearxng =
    env.PI_SEARCH_SEARXNG_URL &&
    env.PI_SEARCH_ALLOW_PRIVATE_SEARXNG === 'always';
  return {
    hasSearxng: Boolean(hasSearxng),
    hasBrave: Boolean(env.BRAVE_SEARCH_API_KEY),
    hasTavily: Boolean(env.TAVILY_API_KEY),
    hasFirecrawl: Boolean(env.FIRECRAWL_API_KEY),
    searxngUrl: hasSearxng ? env.PI_SEARCH_SEARXNG_URL! : undefined,
  };
}

export function buildSearchResult(options: {
  provider: string;
  results: SearchResult[];
  details: Record<string, unknown>;
}): { ok: true; provider: string; data: SearchResult[]; details: Record<string, unknown> } {
  return {
    ok: true,
    provider: options.provider,
    data: options.results,
    details: {
      provider: options.provider,
      apiKeyExposed: false,
      ...options.details,
    },
  };
}

export async function searchBrave(
  _params: { query: string; apiKey: string },
  rawResponse: string,
): Promise<SearchResult[] | null> {
  try {
    const parsed = JSON.parse(rawResponse);
    const results = parsed?.web?.results ?? parsed?.results ?? [];
    if (!Array.isArray(results) || results.length === 0) return [];
    return results.map((r) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      snippet: String(r.description ?? r.snippet ?? ''),
    }));
  } catch {
    return null;
  }
}

export async function searchTavily(
  _params: { query: string; apiKey: string },
  rawResponse: string,
): Promise<SearchResult[] | null> {
  try {
    const parsed = JSON.parse(rawResponse);
    const results = parsed?.results ?? [];
    if (!Array.isArray(results) || results.length === 0) return [];
    return results.map((r) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      snippet: String(r.content ?? r.snippet ?? ''),
    }));
  } catch {
    return null;
  }
}

export async function searchSearxng(
  params: { baseUrl: string; query: string },
  rawResponse: string,
): Promise<SearchResult[] | null> {
  try {
    const parsed = JSON.parse(rawResponse);
    const results = parsed?.results ?? [];
    if (!Array.isArray(results) || results.length === 0) return [];
    return results
      .filter((r) => r.url)
      .map((r) => ({
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.content ?? r.snippet ?? ''),
      }));
  } catch {
    return null;
  }
}

export async function searchDuckDuckGo(
  _params: { baseUrl: string },
  html: string,
): Promise<SearchResult[] | null> {
  function extractUrlFromHref(href: string): string | null {
    const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      try { return decodeURIComponent(uddgMatch[1]); } catch { return null; }
    }
    if (href.startsWith('http')) return href;
    return null;
  }

  const resultLinks = [...html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippetMatches = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];

  // Fallback: if no result__a links found, try generic <a href="http..."> links
  if (resultLinks.length === 0) {
    const fallbackLinks = [...html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi)];
    if (fallbackLinks.length === 0) return null;
    const fallbackResults: SearchResult[] = [];
    for (let i = 0; i < fallbackLinks.length && fallbackResults.length < 10; i++) {
      const match = fallbackLinks[i];
      const url = match[1];
      const titleRaw = match[2].replace(/<[^>]+>/g, '').trim();
      if (url.startsWith('http') && titleRaw && !url.includes('duckduckgo') && !url.includes('html.duckduckgo')) {
        fallbackResults.push({ title: titleRaw, url, snippet: '' });
      }
    }
    return fallbackResults.length > 0 ? fallbackResults : null;
  }

  const results: SearchResult[] = [];
  for (let i = 0; i < resultLinks.length && results.length < 10; i++) {
    const match = resultLinks[i];
    const url = extractUrlFromHref(match[1]);
    const titleRaw = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = snippetMatches[i]
      ? snippetMatches[i][1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '';
    if (url && titleRaw && !url.includes('duckduckgo') && !url.includes('html.duckduckgo')) {
      results.push({ title: titleRaw, url, snippet });
    }
  }
  return results.length > 0 ? results : null;
}

export async function extractFirecrawl(
  _params: { apiKey: string },
  _url: string,
  rawResponse: string,
): Promise<{ content: string; markdown?: string }> {
  try {
    const parsed = JSON.parse(rawResponse);
    return {
      content: String(parsed?.data?.content ?? parsed?.content ?? ''),
      markdown: parsed?.data?.markdown ? String(parsed.data.markdown) : undefined,
    };
  } catch {
    return { content: '', markdown: undefined };
  }
}

function redactProviderUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (/api[_-]?key|token|secret|password/i.test(key)) {
        parsed.searchParams.set(key, 'REDACTED');
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, '$1=REDACTED');
  }
}

function redactSensitiveText(text: string): string {
  // Redact API keys from URLs
  let result = text.replace(/(https?:\/\/[^\s]+)/gi, (url) => redactProviderUrl(url));
  // Redact API keys from JSON body values: "api_key":"<value>"
  result = result.replace(/("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]*("\s*[,\}\]])/gi, '$1REDACTED$2');
  return result;
}

export async function webSearch(options: {
  query: string;
  provider?: string;
  env?: Record<string, string | undefined>;
  fetch?: (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status?: number; content?: string }>;
}): Promise<
  | { ok: true; provider: string; data: SearchResult[]; details: Record<string, unknown> }
  | { ok: false; error: { errorClass: string; message: string; details: Record<string, unknown> }; userText: string }
> {
  const provider = options.provider ?? 'auto';
  const cfg = detectProviderConfig(options.env ?? process.env);
  const providersAttempted: string[] = [];
  const querySentTo: string[] = [];
  const fallbackReasons: Array<{ provider: string; reason: string }> = [];

  interface ProviderEntry {
    id: string;
    url: string | null;
    fetchOptions?: () => { method?: string; headers?: Record<string, string>; body?: string };
    classifyError?: (s: number, b: string, j: boolean) => string;
    recordQuota?: (r: string) => void;
  }

  const providers: ProviderEntry[] = [];

  // SearXNG: private, only if configured
  if (cfg.hasSearxng && (provider === 'auto' || provider === 'searxng')) {
    providers.push({
      id: 'searxng',
      url: `${cfg.searxngUrl}/search?q=${encodeURIComponent(options.query)}&format=json`,
    });
  }

  // Brave: third-party, fallback after SearXNG
  // Uses X-Subscription-Token header per Brave Search API spec
  if (cfg.hasBrave && (provider === 'auto' || provider === 'brave')) {
    const braveApiKey = options.env?.BRAVE_SEARCH_API_KEY ?? '';
    providers.push({
      id: 'brave',
      url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(options.query)}&count=10`,
      fetchOptions: () => ({
        headers: { 'X-Subscription-Token': braveApiKey, 'Accept': 'application/json' },
      }),
      classifyError: (s, b, j) => classifyResponseError(s, b, j),
      recordQuota: (r) => recordProviderQuota('brave', r),
    });
  }

  // Tavily: research-focused, uses POST JSON body per Tavily API spec
  if (cfg.hasTavily && (provider === 'auto' || provider === 'tavily')) {
    const tavilyApiKey = options.env?.TAVILY_API_KEY ?? '';
    providers.push({
      id: 'tavily',
      url: 'https://api.tavily.com/search',
      fetchOptions: () => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyApiKey, query: options.query, max_results: 10 }),
      }),
      classifyError: (s, b, j) => classifyResponseError(s, b, j),
      recordQuota: (r) => recordProviderQuota('tavily', r),
    });
  }

  // DuckDuckGo: no-key last fallback, always available
  if (provider === 'auto' || provider === 'duckduckgo') {
    providers.push({ id: 'duckduckgo', url: null });
  }

  // Firecrawl search endpoint only if explicitly requested
  if (provider === 'firecrawl' && cfg.hasFirecrawl) {
    providers.push({
      id: 'firecrawl',
      url: `https://api.firecrawl.dev/v0/search?apiKey=${options.env?.FIRECRAWL_API_KEY}&query=${encodeURIComponent(options.query)}`,
      classifyError: (s, b, j) => classifyResponseError(s, b, j),
      recordQuota: (r) => recordProviderQuota('firecrawl', r),
    });
  }

  if (providers.length === 0) {
    return {
      ok: false,
      error: {
        errorClass: 'ProviderUnavailableError',
        message: `Provider is not configured or available: ${provider}`,
        details: { provider, providersAttempted: [], querySentTo: [], fallbackReasons: [{ provider, reason: 'provider unavailable or missing API key' }] },
      },
      userText: `[ProviderUnavailableError: ${provider} unavailable]`,
    };
  }

  const actualFetch = options.fetch ?? defaultFetch;

  for (const prov of providers) {
    if (!isProviderAvailable(prov.id) && prov.id !== 'duckduckgo') {
      const cooldownReason = quotaStates.get(prov.id)?.reason ?? 'previous failure';
      fallbackReasons.push({ provider: prov.id, reason: `cooldown: ${cooldownReason}` });
      continue;
    }

    providersAttempted.push(prov.id);

    try {
      let rawResponse: string;

      if (prov.url) {
        const redactedUrl = prov.id === 'tavily' ? prov.url : redactProviderUrl(prov.url);
        querySentTo.push(redactedUrl);
        const fetchOpts = prov.fetchOptions?.();
        const res = await actualFetch(prov.url, fetchOpts);
        if (!res.ok) {
          const status = res.status ?? 500;
          const bodyText = (res.content ?? '').toString().slice(0, 200);
          const errType = prov.classifyError ? prov.classifyError(status, bodyText, true) : 'other';
          prov.recordQuota?.(`HTTP ${status}`);
          fallbackReasons.push({ provider: prov.id, reason: `${errType}: HTTP ${status}` });
          continue;
        }
        rawResponse = res.content ?? '';
      } else if (prov.id === 'duckduckgo') {
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(options.query)}`;
        querySentTo.push(ddgUrl);
        const res = await actualFetch(ddgUrl);
        if (!res.ok) {
          prov.recordQuota?.(`HTTP ${res.status ?? 500}`);
          fallbackReasons.push({ provider: prov.id, reason: `HTTP ${res.status ?? 500}` });
          continue;
        }
        rawResponse = res.content ?? '';
      } else {
        continue;
      }

      let results: SearchResult[] | null = null;
      if (prov.id === 'brave') {
        results = await searchBrave({ query: options.query, apiKey: 'key' }, rawResponse);
      } else if (prov.id === 'tavily') {
        results = await searchTavily({ query: options.query, apiKey: 'key' }, rawResponse);
      } else if (prov.id === 'searxng') {
        results = await searchSearxng({ baseUrl: cfg.searxngUrl!, query: options.query }, rawResponse);
      } else if (prov.id === 'duckduckgo') {
        results = await searchDuckDuckGo({ baseUrl: 'https://html.duckduckgo.com' }, rawResponse);
      }

      if (!results || results.length === 0) {
        fallbackReasons.push({ provider: prov.id, reason: 'no results or parse error' });
        continue;
      }

      return buildSearchResult({
        provider: prov.id,
        results,
        details: {
          providersAttempted,
          querySentTo,
          fallbackReasons,
          apiKeyEnv: prov.id === 'brave' ? 'BRAVE_SEARCH_API_KEY' : prov.id === 'tavily' ? 'TAVILY_API_KEY' : prov.id === 'firecrawl' ? 'FIRECRAWL_API_KEY' : undefined,
          apiKeyExposed: false,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const safeMsg = redactSensitiveText(msg);
      if (prov.id !== 'duckduckgo') recordProviderFailure(prov.id, safeMsg);
      fallbackReasons.push({ provider: prov.id, reason: safeMsg });
    }
  }

  return {
    ok: false,
    error: {
      errorClass: 'AllProvidersFailedError',
      message: `All providers failed after ${providersAttempted.length} attempts`,
      details: { providersAttempted, querySentTo, fallbackReasons },
    },
    userText: `[AllProvidersFailedError: all ${providersAttempted.length} providers failed]`,
  };
}

async function defaultFetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status?: number; content?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; pi-search/1.0)',
      'Accept': 'application/json, text/html, */*',
      ...(opts?.headers ?? {}),
    };
    const res = await fetch(url, {
      method: opts?.method ?? 'GET',
      headers,
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
