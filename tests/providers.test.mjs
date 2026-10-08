import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  buildSearchResult,
  detectProviderConfig,
  extractFirecrawl,
  isProviderAvailable,
  recordProviderFailure,
  recordProviderQuota,
  resetAllCooldowns,
  searchBrave,
  searchDuckDuckGo,
  searchSearxng,
  searchTavily,
  webSearch,
} from '../src/providers.ts';

function makeJsonResponse(data) {
  return { ok: true, content: JSON.stringify(data) };
}

afterEach(() => resetAllCooldowns());

test('detectProviderConfig returns correct flags from env', () => {
  resetAllCooldowns();
  const cfg = detectProviderConfig({
    PI_SEARCH_SEARXNG_URL: 'http://10.255.0.10:8888',
    PI_SEARCH_ALLOW_PRIVATE_SEARXNG: 'always',
    BRAVE_SEARCH_API_KEY: 'test-brave-key',
    TAVILY_API_KEY: 'test-tavily-key',
    FIRECRAWL_API_KEY: 'test-firecrawl-key',
  });
  assert.equal(cfg.hasSearxng, true);
  assert.equal(cfg.hasBrave, true);
  assert.equal(cfg.hasTavily, true);
  assert.equal(cfg.hasFirecrawl, true);
});

test('detectProviderConfig returns false when searxng not allowed', () => {
  resetAllCooldowns();
  const cfg = detectProviderConfig({
    PI_SEARCH_SEARXNG_URL: 'http://10.255.0.10:8888',
    BRAVE_SEARCH_API_KEY: 'test',
  });
  assert.equal(cfg.hasSearxng, false);
});

test('isProviderAvailable returns true for available provider', () => {
  resetAllCooldowns();
  assert.equal(isProviderAvailable('brave'), true);
});

test('isProviderAvailable returns false for provider in quota cooldown', () => {
  resetAllCooldowns();
  recordProviderQuota('brave', 'quota exhausted');
  assert.equal(isProviderAvailable('brave'), false);
});

test('recordProviderQuota sets cooldown and fallbackReason', () => {
  resetAllCooldowns();
  recordProviderQuota('brave', '429 rate limit');
  assert.equal(isProviderAvailable('brave'), false);
});

test('recordProviderFailure sets non-quota cooldown only if network/provider unavailable', () => {
  resetAllCooldowns();
  recordProviderFailure('searxng', 'connection refused');
  assert.equal(isProviderAvailable('searxng'), false);
});

test('recordProviderFailure does not set cooldown for generic timeout', () => {
  resetAllCooldowns();
  recordProviderFailure('brave', 'timeout');
  assert.equal(isProviderAvailable('brave'), true);
});

test('webSearch routes to searxng first when configured', async () => {
  resetAllCooldowns();
  const result = await webSearch({
    query: 'test query',
    provider: 'auto',
    env: {
      PI_SEARCH_SEARXNG_URL: 'http://10.255.0.10:8888',
      PI_SEARCH_ALLOW_PRIVATE_SEARXNG: 'always',
    },
    fetch: async (url) => {
      if (url.includes('10.255.0.10')) return makeJsonResponse({ results: [{ title: 'Searxng result', url: 'https://searxng.example', snippet: 'test' }] });
      throw new Error('unexpected');
    },
  });
  assert.equal(result.provider, 'searxng');
  assert.equal(result.details.providersAttempted[0], 'searxng');
});

test('webSearch falls back from searxng to brave when searxng unavailable', async () => {
  resetAllCooldowns();
  recordProviderFailure('searxng', 'connection refused');
  const result = await webSearch({
    query: 'test',
    provider: 'auto',
    env: {
      PI_SEARCH_SEARXNG_URL: 'http://10.255.0.10:8888',
      PI_SEARCH_ALLOW_PRIVATE_SEARXNG: 'always',
      BRAVE_SEARCH_API_KEY: 'key',
    },
    fetch: async (url) => {
      if (url.includes('brave')) return makeJsonResponse({ results: [{ title: 'Brave result', url: 'https://brave.example', snippet: 'test' }] });
      throw new Error('unexpected: ' + url);
    },
  });
  // searxng is skipped due to cooldown, brave succeeds
  assert.equal(result.provider, 'brave');
  assert.deepEqual(result.details.providersAttempted, ['brave']);
});

test('webSearch falls back on quota exhaustion', async () => {
  resetAllCooldowns();
  recordProviderQuota('brave', 'quota exhausted');
  const result = await webSearch({
    query: 'test',
    provider: 'auto',
    env: { BRAVE_SEARCH_API_KEY: 'key', TAVILY_API_KEY: 'key' },
    fetch: async (url) => {
      if (url.includes('tavily')) return makeJsonResponse({ results: [{ title: 'Tavily result', url: 'https://tavily.example', snippet: 'test' }] });
      throw new Error('unexpected');
    },
  });
  assert.equal(result.provider, 'tavily');
});

test('webSearch records cooldown skip reason in fallbackReasons', async () => {
  resetAllCooldowns();
  recordProviderQuota('brave', 'HTTP 429');
  const result = await webSearch({
    query: 'test',
    provider: 'auto',
    env: { BRAVE_SEARCH_API_KEY: 'key', TAVILY_API_KEY: 'key' },
    fetch: async (url) => {
      if (url.includes('tavily')) return makeJsonResponse({ results: [{ title: 'Tavily result', url: 'https://tavily.example', snippet: 'test' }] });
      throw new Error('unexpected ' + url);
    },
  });
  assert.equal(result.provider, 'tavily');
  const skip = (result.details?.fallbackReasons ?? []).find((f) => f.provider === 'brave');
  assert.ok(skip, 'cooldown-skipped provider must appear in fallbackReasons');
  assert.match(String(skip.reason), /cooldown/);
});

test('webSearch does NOT fallback on non-quota Brave timeout', async () => {
  resetAllCooldowns();
  const result = await webSearch({
    query: 'test',
    provider: 'brave',
    env: { BRAVE_SEARCH_API_KEY: 'key', TAVILY_API_KEY: 'key' },
    fetch: async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.errorClass, 'AllProvidersFailedError');
});

test('webSearch explicit duckduckgo skips all fallbacks', async () => {
  resetAllCooldowns();
  recordProviderQuota('brave', 'exhausted');
  const result = await webSearch({
    query: 'test',
    provider: 'duckduckgo',
    env: {},
    fetch: async (url) => {
      // mock catches duckduckgo URL
      if (url.includes('duckduckgo')) return { ok: true, content: '<a href="https://ddg.example">DDG Result</a>' };
      throw new Error('unexpected: ' + url);
    },
  });
  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.details.providersAttempted.length, 1);
});

test('webSearch explicit unavailable provider fails instead of silently falling back', async () => {
  resetAllCooldowns();
  let called = false;
  const result = await webSearch({
    query: 'test',
    provider: 'tavily',
    env: { BRAVE_SEARCH_API_KEY: 'brave-key' },
    fetch: async () => {
      called = true;
      throw new Error('should not call network');
    },
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error.errorClass, 'ProviderUnavailableError');
  assert.equal(result.error.details.provider, 'tavily');
});

test('webSearch defaults to auto routing when provider omitted', async () => {
  resetAllCooldowns();
  const result = await webSearch({
    query: 'test',
    env: { BRAVE_SEARCH_API_KEY: 'key' },
    fetch: async (url) => {
      if (url.includes('brave')) return makeJsonResponse({ results: [{ title: 'Brave result', url: 'https://brave.example', snippet: 'test' }] });
      throw new Error('unexpected: ' + url);
    },
  });
  assert.equal(result.provider, 'brave');
});

test('webSearch tavily does not expose API key in querySentTo or details', async () => {
  resetAllCooldowns();
  let capturedBody = null;
  const result = await webSearch({
    query: 'test',
    provider: 'tavily',
    env: { TAVILY_API_KEY: 'test-tavily-redacted-value' },
    fetch: async (url, opts) => {
      capturedBody = opts?.body ?? null;
      return makeJsonResponse({ results: [{ title: 'Tavily result', url: 'https://tavily.example', snippet: 'test' }] });
    },
  });
  assert.equal(result.provider, 'tavily');
  // API key is in POST body, not URL
  assert.ok(capturedBody && capturedBody.includes('test-tavily-redacted-value'), 'API key should be in POST body');
  // querySentTo and details should NOT contain the raw key
  assert.ok(!JSON.stringify(result.details).includes('test-tavily-redacted-value'));
  // URL in querySentTo is clean
  for (const u of (result.details.querySentTo ?? [])) {
    assert.ok(!u.includes('test-tavily-redacted-value'), `querySentTo URL must not contain key: ${u}`);
  }
});

test('webSearch tavily does not expose API key in failure details', async () => {
  resetAllCooldowns();
  const result = await webSearch({
    query: 'test',
    provider: 'tavily',
    env: { TAVILY_API_KEY: 'test-tavily-redacted-value' },
    fetch: async (url, opts) => {
      throw new Error(`failed URL: ${url} body: ${opts?.body ?? 'none'}`);
    },
  });
  assert.equal(result.ok, false);
  // Error details must not contain raw API key
  assert.ok(!JSON.stringify(result.error.details).includes('test-tavily-redacted-value'));
});

test('searchBrave calls correct endpoint and maps response', async () => {
  resetAllCooldowns();
  const raw = { web: { results: [{ title: 'Test', url: 'https://example.com', description: 'desc' }] } };
  const results = await searchBrave({ query: 'test', apiKey: 'key' }, JSON.stringify(raw));
  assert.equal(results[0].title, 'Test');
  assert.equal(results[0].url, 'https://example.com');
});

test('searchBrave rescues malformed JSON as JSONParseError', async () => {
  resetAllCooldowns();
  const results = await searchBrave({ query: 'test', apiKey: 'key' }, '<html>not json</html>');
  assert.equal(results, null);
});

test('searchTavily maps response correctly', async () => {
  resetAllCooldowns();
  const raw = { results: [{ title: 'Tav', url: 'https://t.com', content: 'content', score: 0.95 }] };
  const results = await searchTavily({ query: 'test', apiKey: 'key' }, JSON.stringify(raw));
  assert.equal(results[0].title, 'Tav');
  assert.equal(results[0].snippet, 'content');
});

test('searchSearxng maps response correctly', async () => {
  resetAllCooldowns();
  const raw = { results: [{ title: 'SX', url: 'https://sx.com', content: 'text' }] };
  const results = await searchSearxng({ baseUrl: 'http://localhost', query: 'test' }, JSON.stringify(raw));
  assert.equal(results[0].url, 'https://sx.com');
});

test('searchDuckDuckGo extracts results from real HTML with uddg redirect URLs', async () => {
  resetAllCooldowns();
  const html = `<html><body>
    <div class="results">
      <div class="result">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2F&amp;rut=abc123">TypeScript: JavaScript With Syntax For Types</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2F">TypeScript is a strongly typed programming language...</a>
      </div>
      <div class="result">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Ftypescript">GitHub - microsoft/TypeScript</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Ftypescript">TypeScript is a superset of JavaScript...</a>
      </div>
    </div>
  </body></html>`;
  const results = await searchDuckDuckGo({ baseUrl: 'https://html.duckduckgo.com' }, html);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'TypeScript: JavaScript With Syntax For Types');
  assert.equal(results[0].url, 'https://www.typescriptlang.org/');
  assert.equal(results[0].snippet, 'TypeScript is a strongly typed programming language...');
  assert.equal(results[1].title, 'GitHub - microsoft/TypeScript');
  assert.equal(results[1].url, 'https://github.com/typescript');
});

test('searchDuckDuckGo extracts results from HTML', async () => {
  resetAllCooldowns();
  const html = `<html><body>
    <li class="result"><a class="result__a" href="https://a.com">Title A</a><a class="result__snippet">Snippet A</a></li>
    <li class="result"><a class="result__a" href="https://b.com">Title B</a><a class="result__snippet">Snippet B</a></li>
  </body></html>`;
  const results = await searchDuckDuckGo({ baseUrl: 'http://localhost' }, html);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Title A');
  assert.equal(results[1].snippet, 'Snippet B');
});

test('searchDuckDuckGo returns null on structure change', async () => {
  resetAllCooldowns();
  const html = '<html><body><p>No results at all</p></body></html>';
  const results = await searchDuckDuckGo({ baseUrl: 'http://localhost' }, html);
  assert.equal(results, null);
});

test('extractFirecrawl maps response correctly', async () => {
  resetAllCooldowns();
  const raw = { data: { content: 'content here', markdown: '# heading' } };
  const result = await extractFirecrawl({ apiKey: 'key' }, 'https://example.com', JSON.stringify(raw));
  assert.equal(result.content, 'content here');
});

test('extractFirecrawl returns empty structured result on malformed JSON', async () => {
  resetAllCooldowns();
  const result = await extractFirecrawl({ apiKey: 'key' }, 'https://example.com', 'not-json');
  assert.equal(result.content, '');
  assert.equal(result.markdown, undefined);
});

test('buildSearchResult returns structured format with provider top-level', () => {
  resetAllCooldowns();
  const result = buildSearchResult({
    provider: 'brave',
    results: [{ title: 'T', url: 'https://x.com', snippet: 's' }],
    details: { provider: 'brave', apiKeyEnv: 'BRAVE_SEARCH_API_KEY' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'brave');
  assert.equal(result.data[0].title, 'T');
  assert.equal(result.details.apiKeyExposed, false);
});

test('apiKeyExposed is always false in details', async () => {
  resetAllCooldowns();
  const result = buildSearchResult({
    provider: 'brave',
    results: [],
    details: { provider: 'brave', apiKeyEnv: 'BRAVE_SEARCH_API_KEY' },
  });
  assert.equal(result.details.apiKeyExposed, false);
});

test('webSearch records all fallbackReasons and querySentTo in details', async () => {
  resetAllCooldowns();
  recordProviderQuota('brave', '429');
  recordProviderQuota('tavily', '402');
  const result = await webSearch({
    query: 'test',
    provider: 'auto',
    env: {},
    fetch: async (url) => {
      if (url.includes('duckduckgo')) return { ok: true, content: '<a href="https://ddg.example">DDG Result</a>' };
      throw new Error('unexpected: ' + url);
    },
  });
  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.details.providersAttempted.length, 1);
  assert.equal(result.details.querySentTo.length, 1);
});

// ============================================================
// BUG 1: Brave provider must send X-Subscription-Token header
// ============================================================

test('webSearch brave sends X-Subscription-Token header', async () => {
  resetAllCooldowns();
  let capturedHeaders = {};
  const result = await webSearch({
    query: 'test brave header',
    provider: 'brave',
    env: { BRAVE_SEARCH_API_KEY: 'test-brave-token-123' },
    fetch: async (url, opts) => {
      capturedHeaders = opts?.headers ?? {};
      return makeJsonResponse({ web: { results: [{ title: 'Brave Header Test', url: 'https://brave.example', description: 'test' }] } });
    },
  });
  assert.equal(result.provider, 'brave');
  assert.equal(capturedHeaders['X-Subscription-Token'], 'test-brave-token-123');
  // API key must NOT appear in URL
  assert.ok(!capturedHeaders['url']?.includes('test-brave-token-123'));
  // querySentTo should not contain the key
  const sentUrls = result.details.querySentTo ?? [];
  for (const u of sentUrls) {
    assert.ok(!u.includes('test-brave-token-123'), `URL should not contain API key: ${u}`);
  }
});

// ============================================================
// BUG 2: Tavily provider must use POST JSON body, not GET with api_key in URL
// ============================================================

test('webSearch tavily uses POST with JSON body, API key not in URL', async () => {
  resetAllCooldowns();
  let capturedMethod = '';
  let capturedBody = null;
  let capturedHeaders = {};
  let capturedUrl = '';
  const result = await webSearch({
    query: 'test tavily post',
    provider: 'tavily',
    env: { TAVILY_API_KEY: 'test-tavily-key-456' },
    fetch: async (url, opts) => {
      capturedUrl = url;
      capturedMethod = String(opts?.method ?? 'GET');
      capturedHeaders = opts?.headers ?? {};
      capturedBody = opts?.body ? JSON.parse(String(opts.body)) : null;
      return makeJsonResponse({ results: [{ title: 'Tavily POST Test', url: 'https://tavily.example', content: 'test' }] });
    },
  });
  assert.equal(result.provider, 'tavily');
  assert.equal(capturedMethod, 'POST');
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
  // API key in body, not URL
  assert.equal(capturedBody?.api_key, 'test-tavily-key-456');
  assert.equal(capturedBody?.query, 'test tavily post');
  assert.ok(!capturedUrl.includes('test-tavily-key-456'), 'URL must not contain API key');
  // querySentTo should not contain the key
  const sentUrls = result.details.querySentTo ?? [];
  for (const u of sentUrls) {
    assert.ok(!u.includes('test-tavily-key-456'), `querySentTo must not contain API key: ${u}`);
  }
});

test('webSearch tavily POST failure still classifies auth error correctly', async () => {
  resetAllCooldowns();
  const result = await webSearch({
    query: 'test',
    provider: 'tavily',
    env: { TAVILY_API_KEY: 'bad-key' },
    fetch: async () => {
      return { ok: false, status: 401, content: JSON.stringify({ error: 'Invalid API key' }) };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.errorClass, 'AllProvidersFailedError');
  const reasons = result.error.details.fallbackReasons ?? [];
  assert.ok(reasons.some(r => r.reason.includes('auth')), `Expected auth reason, got: ${JSON.stringify(reasons)}`);
});
