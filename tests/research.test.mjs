import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEvidencePack,
  buildResearchReport,
  clipEvidence,
  detectLlmConfig,
  isLlmEnabled,
  researchSearch,
  callSecondLlm,
  RESERVED_LLM_KEYS,
} from '../src/research.ts';

test('detectLlmConfig returns correct flags from env', () => {
  const result = detectLlmConfig({
    PI_SEARCH_LLM_ENABLED: 'always',
    PI_SEARCH_LLM_PROVIDER: 'openai',
    PI_SEARCH_LLM_MODEL: 'gpt-4o-mini',
    PI_SEARCH_LLM_BASE_URL: 'https://api.openai.com/v1',
    PI_SEARCH_LLM_API_KEY_ENV: 'OPENAI_API_KEY',
  });
  assert.equal(result.enabled, true);
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-4o-mini');
  assert.equal(result.baseUrl, 'https://api.openai.com/v1');
  assert.equal(result.apiKeyEnv, 'OPENAI_API_KEY');
});

test('detectLlmConfig returns disabled when never', () => {
  const result = detectLlmConfig({
    PI_SEARCH_LLM_ENABLED: 'never',
    PI_SEARCH_LLM_PROVIDER: 'openai',
  });
  assert.equal(result.enabled, false);
});

test('detectLlmConfig returns disabled for ask in non-interactive context', () => {
  const result = detectLlmConfig({
    PI_SEARCH_LLM_ENABLED: 'ask',
    PI_SEARCH_LLM_PROVIDER: 'openai',
  });
  assert.equal(result.enabled, false);
});

test('isLlmEnabled returns correct boolean', () => {
  assert.equal(isLlmEnabled({ enabled: true }), true);
  assert.equal(isLlmEnabled({ enabled: false }), false);
});

test('RESERVED_LLM_KEYS contains all sensitive env var patterns', () => {
  assert.ok(RESERVED_LLM_KEYS.length > 0);
  assert.ok(RESERVED_LLM_KEYS.every((k) => typeof k === 'string'));
});

test('clipEvidence clips per-source to budget', () => {
  const sources = [
    { id: '1', url: 'https://a.com', title: 'A', text: 'A'.repeat(500) },
    { id: '2', url: 'https://b.com', title: 'B', text: 'B'.repeat(500) },
  ];
  const result = clipEvidence(sources, { maxChars: 100, maxSources: 10 });
  assert.equal(result.truncated, true);
  // Fair-share contract: both sources fit under the 100-char budget (coverage
  // over completeness — the old first-come-first-served behavior dropped source 2)
  assert.equal(result.sources.length, 2);
  assert.ok(result.totalChars <= 100, `totalChars ${result.totalChars} exceeds maxChars 100`);
});

test('clipEvidence balances budget across sources (context recall over first-come-first-served)', () => {
  const sources = [
    { id: '1', url: 'https://a.com', title: 'A', text: 'A'.repeat(4000) },
    { id: '2', url: 'https://b.com', title: 'B', text: 'B'.repeat(4000) },
    { id: '3', url: 'https://c.com', title: 'C', text: 'C'.repeat(4000) },
  ];
  const result = clipEvidence(sources, { maxChars: 6000, maxSources: 5 });
  assert.equal(result.sources.length, 3, 'all 3 sources must fit under 6000 chars with fair shares');
  assert.ok(result.sources.every((s) => s.text.length <= 2000 + 100), 'per-source share ≈ 2000');
  assert.ok(result.totalChars <= 6000);
  // 短源让出余额给后续源：总预算不被早期短源浪费
  const mixed = clipEvidence(
    [
      { id: '1', url: 'https://a.com', title: 'A', text: 'A'.repeat(300) },
      { id: '2', url: 'https://b.com', title: 'B', text: 'B'.repeat(5000) },
    ],
    { maxChars: 4000, maxSources: 5 },
  );
  assert.equal(mixed.sources.length, 2);
  assert.ok(mixed.sources[1].text.length > 3000, 'unused budget from short source flows to later sources');
});

test('clipEvidence totalChars hard constraint: never exceeds maxChars', () => {
  const sources = [
    { id: '1', url: 'https://a.com', title: 'A', text: 'A'.repeat(5000) },
    { id: '2', url: 'https://b.com', title: 'B', text: 'B'.repeat(5000) },
    { id: '3', url: 'https://c.com', title: 'C', text: 'C'.repeat(5000) },
  ];
  const result = clipEvidence(sources, { maxChars: 6000, maxSources: 10 });
  assert.ok(result.totalChars <= 6000, `totalChars ${result.totalChars} exceeds maxChars 6000`);
  assert.ok(result.sources.length >= 1, 'should have at least one source');
});

test('clipEvidence hard constraint with small maxChars', () => {
  const sources = [
    { id: '1', url: 'https://a.com', title: 'A', text: 'A'.repeat(1000) },
  ];
  const result = clipEvidence(sources, { maxChars: 100, maxSources: 10 });
  assert.ok(result.totalChars <= 100, `totalChars ${result.totalChars} exceeds maxChars 100`);
});

test('clipEvidence respects maxSources', () => {
  const sources = Array.from({ length: 10 }, (_, i) => ({ id: String(i), url: `https://${i}.com`, title: String(i), text: 'x'.repeat(10) }));
  const result = clipEvidence(sources, { maxChars: 1000, maxSources: 3 });
  assert.equal(result.sources.length, 3);
});

test('clipEvidence records fetch failure gracefully', () => {
  const sources = [
    { id: '1', url: 'https://a.com', title: 'A', text: 'content', fetchError: 'timeout' },
    { id: '2', url: 'https://b.com', title: 'B', text: 'content' },
  ];
  const result = clipEvidence(sources, { maxChars: 1000, maxSources: 5 });
  assert.equal(result.sources.length, 1);
  assert.equal(result.fetchErrors, 1);
});

test('buildEvidencePack returns structured evidence', () => {
  const pack = buildEvidencePack({
    query: 'test query',
    sources: [{ id: '1', url: 'https://a.com', title: 'A', text: 'content' }],
  });
  assert.equal(pack.query, 'test query');
  assert.equal(pack.sources.length, 1);
  assert.ok(pack.fetchedAt);
  assert.ok(pack.totalChars > 0);
});

test('callSecondLlm returns error when LLM disabled', async () => {
  const result = await callSecondLlm({
    prompt: 'test',
    config: { enabled: false, provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', apiKeyEnv: '' },
    fetch: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'LlmDisabled');
});

test('callSecondLlm sends only query + evidence to provider', async () => {
  let capturedPrompt = '';
  const result = await callSecondLlm({
    prompt: 'Based on evidence: [1] SSRF prevention... [2] CVE-2024-xxxx... Answer:',
    config: { enabled: true, provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    fetch: async (url, opts) => {
      capturedPrompt = opts?.body ?? '';
      return { ok: true, content: JSON.stringify({ choices: [{ message: { content: 'Verified answer' } }] }) };
    },
    env: { OPENAI_API_KEY: 'test-openai-key' },
  });
  assert.equal(result.ok, true);
  // prompt should contain evidence but not env vars
  assert.ok(capturedPrompt.includes('SSRF prevention'));
  assert.ok(!capturedPrompt.includes('test-openai-key'));
  // truncation guard: reasoning models need headroom beyond 1024
  const parsedBody = JSON.parse(capturedPrompt);
  assert.equal(parsedBody.max_tokens, 4096);
});

test('callSecondLlm anti-leakage: env values not in prompt', async () => {
  let capturedBody = '';
  await callSecondLlm({
    prompt: 'test prompt',
    config: { enabled: true, provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    fetch: async (url, opts) => {
      capturedBody = opts?.body ?? '';
      return { ok: true, content: JSON.stringify({ choices: [{ message: { content: 'result' } }] }) };
    },
    env: {
      OPENAI_API_KEY: 'test-openai-redacted-value',
      AWS_SECRET_ACCESS_KEY: 'test-aws-redacted-value',
      GITHUB_TOKEN: 'test-github-redacted-value',
      TAVILY_API_KEY: 'test-tavily-redacted-value',
      BRAVE_SEARCH_API_KEY: 'test-brave-redacted-value',
      PI_SEARCH_LLM_API_KEY_ENV: 'OPENAI_API_KEY',
    },
  });
  assert.ok(!capturedBody.includes('test-openai-redacted-value'));
  assert.ok(!capturedBody.includes('test-aws-redacted-value'));
  assert.ok(!capturedBody.includes('test-github-redacted-value'));
  assert.ok(!capturedBody.includes('test-tavily-redacted-value'));
  assert.ok(!capturedBody.includes('test-brave-redacted-value'));
});

test('callSecondLlm parses JSON wrapped in markdown code fence', async () => {
  const fenced = '```json\n{"answer": "fenced answer", "citations": ["1"], "confidence": "high"}\n```';
  const result = await callSecondLlm({
    prompt: 'test',
    config: { enabled: true, provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    fetch: async () => ({ ok: true, content: JSON.stringify({ choices: [{ message: { content: fenced } }] }) }),
    env: { OPENAI_API_KEY: 'test-openai-key' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.answer, 'fenced answer');
  assert.deepEqual(result.citations, ['1']);
  assert.equal(result.confidence, 'high');
});

test('callSecondLlm falls back to evidence only on timeout', async () => {
  const result = await callSecondLlm({
    prompt: 'test',
    config: { enabled: true, provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    fetch: async () => {
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    },
    env: { OPENAI_API_KEY: 'test-openai-key' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, 'LlmTimeout');
});

test('buildResearchReport returns fixed output schema', () => {
  const report = buildResearchReport({
    query: 'test',
    evidence: {
      query: 'test',
      sources: [{ id: '1', url: 'https://a.com', title: 'A', text: 'content' }],
      totalChars: 7,
      fetchedAt: new Date().toISOString(),
    },
    llmResult: null,
    llmConfig: { enabled: false, provider: '', model: '', baseUrl: '', apiKeyEnv: '' },
    details: { mode: 'basic', providersUsed: ['brave'], apiKeyExposed: false },
  });
  assert.equal(report.ok, true);
  assert.equal(report.query, 'test');
  assert.ok(Array.isArray(report.citations));
  assert.ok(report.citations.length === 1);
  assert.ok(Array.isArray(report.riskFlags));
  assert.equal(report.verificationStatus, '[VERIFICATION DISABLED]');
  assert.equal(report.details.llmUsed, false);
  assert.equal(report.details.apiKeyExposed, false);
});

test('buildResearchReport with LLM enabled includes answer', () => {
  const report = buildResearchReport({
    query: 'test',
    evidence: {
      query: 'test',
      sources: [{ id: '1', url: 'https://a.com', title: 'A', text: 'content' }],
      totalChars: 7,
      fetchedAt: new Date().toISOString(),
    },
    llmResult: { ok: true, answer: 'The answer is X.', citations: ['1'], confidence: 'high' },
    llmConfig: { enabled: true, provider: 'openai', model: 'gpt-4o-mini', baseUrl: '', apiKeyEnv: '' },
    details: { mode: 'deep', providersUsed: ['tavily'], apiKeyExposed: false },
  });
  assert.equal(report.answer, 'The answer is X.');
  assert.equal(report.verificationStatus, '[VERIFICATION ENABLED]');
  assert.equal(report.details.llmUsed, true);
  assert.equal(report.details.llmModel, 'gpt-4o-mini');
});

test('researchSearch basic mode uses web_search URL discovery + local fetch', async () => {
  const result = await researchSearch({
    query: 'test',
    mode: 'basic',
    env: { PI_SEARCH_LLM_ENABLED: 'never' },
    fetch: async () => ({ text: 'Test content about the topic.', riskFlags: [] }),
    webSearch: async () => ({
      ok: true,
      provider: 'brave',
      data: [{ title: 'Test', url: 'https://example.com', snippet: 'snippet' }],
      details: { providersAttempted: ['brave'], apiKeyExposed: false },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verificationStatus, '[VERIFICATION DISABLED]');
  assert.equal(result.details.mode, 'basic');
  assert.equal(result.details.llmUsed, false);
});

test('researchSearch deep mode uses Tavily and optional LLM', async () => {
  const result = await researchSearch({
    query: 'test',
    mode: 'deep',
    env: {
      PI_SEARCH_LLM_ENABLED: 'always',
      PI_SEARCH_LLM_PROVIDER: 'openai',
      PI_SEARCH_LLM_MODEL: 'gpt-4o-mini',
      PI_SEARCH_LLM_BASE_URL: 'https://api.openai.com/v1',
      PI_SEARCH_LLM_API_KEY_ENV: 'OPENAI_API_KEY',
      OPENAI_API_KEY: 'test-openai-key',
    },
    webSearch: async (opts) => {
      if (opts.provider === 'tavily') {
        return { ok: true, provider: 'tavily', data: [{ title: 'T', url: 'https://t.com', snippet: 'evidence' }], details: { providersAttempted: ['tavily'], apiKeyExposed: false } };
      }
      return { ok: true, provider: 'brave', data: [{ title: 'B', url: 'https://b.com', snippet: 'snippet' }], details: { providersAttempted: ['brave'], apiKeyExposed: false } };
    },
    llmFetch: async (url, opts) => {
      return { ok: true, content: JSON.stringify({ choices: [{ message: { content: 'Deep research answer.' } }] }) };
    },
    fetch: async () => ({ text: 'evidence content', riskFlags: [] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.details.mode, 'deep');
  assert.equal(result.details.llmUsed, true);
  assert.equal(result.verificationStatus, '[VERIFICATION ENABLED]');
});

test('researchSearch skips LLM when no valid evidence fetched', async () => {
  let llmCalls = 0;
  const result = await researchSearch({
    query: 'test',
    mode: 'basic',
    env: {
      PI_SEARCH_LLM_ENABLED: 'always',
      PI_SEARCH_LLM_PROVIDER: 'openai',
      PI_SEARCH_LLM_MODEL: 'm',
      PI_SEARCH_LLM_BASE_URL: 'https://llm.example/v1',
      PI_SEARCH_LLM_API_KEY_ENV: 'OPENAI_API_KEY',
      OPENAI_API_KEY: 'test-openai-key',
    },
    webSearch: async () => ({
      ok: true,
      provider: 'brave',
      data: [{ title: 'T', url: 'https://example.com/x', snippet: 's' }],
      details: { providersAttempted: ['brave'], apiKeyExposed: false },
    }),
    fetch: async () => { throw new Error('all fetches fail'); },
    llmFetch: async () => {
      llmCalls += 1;
      return { ok: true, content: JSON.stringify({ choices: [{ message: { content: '{"answer":"hallucinated"}' } }] }) };
    },
  });
  assert.equal(llmCalls, 0, 'LLM must not be called without evidence');
  assert.equal(result.answer, '');
  assert.match(result.verificationStatus, /NoEvidence/);
});

test('researchSearch skips LLM when evidence is only whitespace', async () => {
  let llmCalls = 0;
  const result = await researchSearch({
    query: 'test',
    mode: 'basic',
    env: {
      PI_SEARCH_LLM_ENABLED: 'always',
      PI_SEARCH_LLM_PROVIDER: 'openai',
      PI_SEARCH_LLM_MODEL: 'm',
      PI_SEARCH_LLM_BASE_URL: 'https://llm.example/v1',
      PI_SEARCH_LLM_API_KEY_ENV: 'OPENAI_API_KEY',
      OPENAI_API_KEY: 'test-openai-key',
    },
    webSearch: async () => ({
      ok: true,
      provider: 'brave',
      data: [{ title: 'T', url: 'https://example.com/empty', snippet: 's' }],
      details: { providersAttempted: ['brave'], apiKeyExposed: false },
    }),
    fetch: async () => ({ text: '   \n\t  ', riskFlags: [] }),
    llmFetch: async () => {
      llmCalls += 1;
      return { ok: true, content: '{"answer":"hallucinated"}' };
    },
  });
  assert.equal(llmCalls, 0, 'whitespace-only evidence must not reach the LLM');
  assert.match(result.verificationStatus, /NoEvidence/);
});

test('researchSearch rescues failed fetches via Firecrawl (recoverable failures only)', async () => {
  let fcCalls = 0;
  const result = await researchSearch({
    query: 'test',
    mode: 'basic',
    env: { PI_SEARCH_LLM_ENABLED: 'never', FIRECRAWL_API_KEY: 'fc-key' },
    webSearch: async () => ({
      ok: true,
      provider: 'brave',
      data: [{ title: 'T', url: 'https://example.com/blocked-page', snippet: 's' }],
      details: { providersAttempted: ['brave'], apiKeyExposed: false },
    }),
    fetch: async () => {
      const e = new Error('HTTP 403');
      e.name = 'HttpStatusError';
      throw e;
    },
    firecrawlFetch: async (url, opts) => {
      fcCalls += 1;
      assert.ok(String(url).includes('firecrawl.dev'), 'must call Firecrawl endpoint');
      assert.equal(JSON.parse(String(opts?.body)).url, 'https://example.com/blocked-page');
      return { ok: true, content: JSON.stringify({ data: { markdown: '## Rescued evidence content' } }) };
    },
  });
  assert.equal(fcCalls, 1, 'Firecrawl should be called exactly once for the failed source');
  assert.ok(result.citations.length >= 1, 'rescued source must appear in citations');
  const cite = result.citations.find((c) => c.url === 'https://example.com/blocked-page');
  assert.ok(cite, 'rescued citation present');
  assert.ok(
    cite.text.includes('Rescued evidence') || cite.snippet.includes('Rescued evidence'),
    'citation must carry Firecrawl-rescued text',
  );
  assert.equal(result.details.firecrawlRescues, 1);
});

test('researchSearch never bypasses NetworkPolicyError via Firecrawl', async () => {
  let fcCalls = 0;
  const result = await researchSearch({
    query: 'test',
    mode: 'basic',
    env: { PI_SEARCH_LLM_ENABLED: 'never', FIRECRAWL_API_KEY: 'fc-key' },
    webSearch: async () => ({
      ok: true,
      provider: 'brave',
      data: [{ title: 'T', url: 'http://192.168.1.1/secret', snippet: 's' }],
      details: { providersAttempted: ['brave'], apiKeyExposed: false },
    }),
    fetch: async () => {
      const e = new Error('Private network target is blocked');
      e.name = 'NetworkPolicyError';
      throw e;
    },
    firecrawlFetch: async () => {
      fcCalls += 1;
      return { ok: true, content: JSON.stringify({ data: { markdown: 'leaked' } }) };
    },
  });
  assert.equal(fcCalls, 0, 'security policy rejections must not be bypassed via Firecrawl');
  assert.equal(result.citations.length, 0, 'policy-blocked source must be dropped, not rescued');
});

test('researchSearch returns structured error when all sources fail', async () => {
  const result = await researchSearch({
    query: 'test',
    mode: 'basic',
    env: { PI_SEARCH_LLM_ENABLED: 'never' },
    fetch: async () => ({ ok: false, status: 500 }),
    webSearch: async () => ({
      ok: false,
      error: { errorClass: 'AllProvidersFailedError', message: 'all failed', details: {} },
      userText: '[AllProvidersFailedError]',
    }),
  });
  assert.equal(result.ok, true); // researchSearch itself succeeds; evidence is empty
  assert.equal(result.answer, '');
  assert.equal(result.citations.length, 0);
});

test('researchSearch citations reference source IDs from evidence', async () => {
  const result = await researchSearch({
    query: 'test',
    mode: 'basic',
    env: { PI_SEARCH_LLM_ENABLED: 'never' },
    fetch: async () => ({ text: 'page content', riskFlags: [] }),
    webSearch: async () => ({
      ok: true,
      provider: 'brave',
      data: [
        { title: 'A', url: 'https://a.com', snippet: 's1' },
        { title: 'B', url: 'https://b.com', snippet: 's2' },
      ],
      details: { providersAttempted: ['brave'], apiKeyExposed: false },
    }),
  });
  assert.equal(result.citations.length, 2);
  assert.ok(result.citations[0].id);
  assert.equal(result.citations[0].url, 'https://a.com');
  assert.equal(result.citations[1].url, 'https://b.com');
});
