import { execFile } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

import { sanitizeHtml, truncateText, wrapUntrusted, uniqueFlags } from './text.ts';

const execFileAsync = promisify(execFile);

export type EnvProfile = 'rg' | 'fetch' | 'provider' | 'llm';

export type ErrorResult = {
  ok: false;
  error: {
    errorClass: string;
    message: string;
    details: Record<string, unknown>;
  };
  userText: string;
};

export type ToolResult<T> =
  | { ok: true; data: T; details: Record<string, unknown> }
  | ErrorResult;

export class PiSearchError extends Error {
  details: Record<string, unknown>;

  constructor(name: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = name;
    this.details = details;
  }
}

const BASE_ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']);
const PROFILE_API_ENV = new Map<EnvProfile, string[]>([
  ['rg', []],
  ['fetch', []],
  ['provider', ['BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'FIRECRAWL_API_KEY']],
  ['llm', []],
]);

const SENSITIVE_KEY_RE = /(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|AUTH|COOKIE|SESSION|SSH|AWS_|OPENAI|ANTHROPIC|GITHUB|NPM|GOOGLE|AZURE)/i;
const SENSITIVE_PATH_PARTS = new Set(['.env', '.ssh', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.netrc']);
const BLOCKED_HOSTS = new Set(['localhost', 'ip6-localhost', 'metadata.google.internal']);
const TEXT_CONTENT_TYPES = [
  'text/plain',
  'text/html',
  'text/markdown',
  'application/xhtml+xml',
  'application/xml',
  'application/json',
];

export function buildSuccessResult<T>(data: T, details: Record<string, unknown> = {}): ToolResult<T> {
  return { ok: true, data, details };
}

export function buildErrorResult(errorClass: string, message: string, details: Record<string, unknown> = {}): ErrorResult {
  const safeDetails: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (/raw|body|secret|token|key|password/i.test(key)) continue;
    safeDetails[key] = value;
  }
  return {
    ok: false,
    error: { errorClass, message, details: safeDetails },
    userText: `[${errorClass}: ${message}]`,
  };
}

export function getMinimalEnv(profile: EnvProfile, source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Record<string, string> {
  if (!PROFILE_API_ENV.has(profile)) {
    throw new PiSearchError('EnvPolicyError', `Unknown env profile: ${String(profile)}`);
  }

  const allowed = new Set(BASE_ENV_ALLOWLIST);
  for (const key of PROFILE_API_ENV.get(profile) ?? []) allowed.add(key);
  if (profile === 'llm' && source.PI_SEARCH_LLM_API_KEY_ENV) allowed.add(source.PI_SEARCH_LLM_API_KEY_ENV);

  const env: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }

  for (const key of Object.keys(env)) {
    const profileAllowsApiKey = (PROFILE_API_ENV.get(profile) ?? []).includes(key) || (profile === 'llm' && key === source.PI_SEARCH_LLM_API_KEY_ENV);
    if (SENSITIVE_KEY_RE.test(key) && !profileAllowsApiKey) delete env[key];
  }
  return env;
}

export async function runCommand(cmd: string, args: string[], options: { profile?: EnvProfile; timeout?: number; cwd?: string } = {}) {
  if (cmd !== 'rg') throw new PiSearchError('CommandPolicyError', `Command not allowed: ${cmd}`);
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: options.cwd ?? process.cwd(),
    timeout: options.timeout ?? 10_000,
    maxBuffer: 1024 * 1024,
    env: getMinimalEnv(options.profile ?? 'rg'),
  });
  return { stdout, stderr };
}

function hasSensitivePathPart(filePath: string): boolean {
  return filePath.split(path.sep).some((part) => SENSITIVE_PATH_PARTS.has(part));
}

export function resolveSafePath(inputPath: string, options: { cwd?: string; env?: Record<string, string | undefined> } = {}): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const resolved = path.resolve(cwd, inputPath || '.');
  if (hasSensitivePathPart(resolved)) {
    throw new PiSearchError('PathPolicyError', 'Sensitive path is blocked', { path: inputPath });
  }
  const outsideCwd = resolved !== cwd && !resolved.startsWith(cwd + path.sep);
  if (outsideCwd && options.env?.PI_SEARCH_ALLOW_OUTSIDE_CWD !== 'always') {
    throw new PiSearchError('PathPolicyError', 'Path outside cwd is blocked', { path: inputPath });
  }
  return resolved;
}

export async function createTempDir(label = 'tmp'): Promise<string> {
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  return mkdtemp(path.join(tmpdir(), `pi-search-${safeLabel}-`));
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((x) => Number(x));
  if (parts.length !== 4 || parts.some((x) => Number.isNaN(x))) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 0
  );
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80') || normalized === '::';
}

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

function getSearxngOrigin(env: Record<string, string | undefined>): string | null {
  if (env.PI_SEARCH_ALLOW_PRIVATE_SEARXNG !== 'always' || !env.PI_SEARCH_SEARXNG_URL) return null;
  try {
    return new URL(env.PI_SEARCH_SEARXNG_URL).origin;
  } catch {
    throw new PiSearchError('NetworkPolicyError', 'Invalid PI_SEARCH_SEARXNG_URL');
  }
}

export async function validateUrl(rawUrl: string, options: {
  env?: Record<string, string | undefined>;
  allowSearxngPrivate?: boolean;
} = {}): Promise<{ url: URL; privateNetworkException?: string }> {
  const env = options.env ?? process.env;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PiSearchError('NetworkPolicyError', 'Invalid URL');
  }
  if (url.username || url.password) throw new PiSearchError('NetworkPolicyError', 'URL credentials are blocked');

  const searxngOrigin = options.allowSearxngPrivate ? getSearxngOrigin(env) : null;
  const isSearxngExactOrigin = Boolean(searxngOrigin && url.origin === searxngOrigin);
  // HTTP allowed: SSRF safety comes from the per-hop IP/private-net checks below,
  // not from the scheme. Plaintext transport is surfaced as a riskFlag instead.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PiSearchError('NetworkPolicyError', 'Only http(s) is supported');
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) && !isSearxngExactOrigin) throw new PiSearchError('NetworkPolicyError', 'Blocked hostname');

  const ips: string[] = [];
  if (isIP(host) || isIP(host.replace(/^\[|\]$/g, ''))) {
    ips.push(host.replace(/^\[|\]$/g, ''));
  } else {
    try {
      const records = await dnsLookup(host, { all: true, verbatim: true });
      ips.push(...records.map((record) => record.address));
    } catch (error) {
      throw new PiSearchError('NetworkPolicyError', 'DNS lookup failed', { host, cause: String(error) });
    }
  }

  const hasProxy = Boolean(env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY);

  for (const ip of ips) {
    if (!hasProxy && isPrivateIp(ip) && !isSearxngExactOrigin) {
      throw new PiSearchError('NetworkPolicyError', 'Private network target is blocked', { host, ip });
    }
  }

  return {
    url,
    privateNetworkException: isSearxngExactOrigin ? 'explicit-searxng-origin' : undefined,
  };
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) throw new PiSearchError('SizeLimitError', 'Response exceeded maxBytes', { maxBytes });
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeResponse(bytes: Uint8Array, encoding: string | null, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.from(bytes);
  const lower = (encoding ?? '').toLowerCase();
  const stream = lower.includes('gzip')
    ? createGunzip()
    : lower.includes('deflate')
      ? createInflate()
      : lower.includes('br')
        ? createBrotliDecompress()
        : null;

  if (!stream) return Promise.resolve(buffer);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        stream.destroy(new PiSearchError('SizeLimitError', 'Decoded response exceeded maxBytes', { maxBytes }));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', () => resolve(buffer)); // proxy may have already decompressed
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.end(buffer);
  });
}

export async function safeFetchText(rawUrl: string, options: {
  env?: Record<string, string | undefined>;
  allowSearxngPrivate?: boolean;
  maxBytes?: number;
  maxChars?: number;
  timeoutMs?: number;
  maxRedirects?: number;
} = {}): Promise<{ url: string; text: string; riskFlags: string[]; truncated: boolean; details: Record<string, unknown> }> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxChars = options.maxChars ?? 20_000;
  const maxRedirects = options.maxRedirects ?? 5;
  let currentUrl = rawUrl;
  let privateNetworkException: string | undefined;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const validation = await validateUrl(currentUrl, {
      env: options.env,
      allowSearxngPrivate: options.allowSearxngPrivate,
    });
    privateNetworkException = validation.privateNetworkException;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await fetch(validation.url, { redirect: 'manual', signal: controller.signal });
    } catch (error) {
      throw new PiSearchError('NetworkError', 'Fetch failed', { cause: String(error) });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new PiSearchError('RedirectError', 'Redirect missing location');
      if (redirectCount === maxRedirects) throw new PiSearchError('RedirectLimitError', 'Too many redirects');
      currentUrl = new URL(location, validation.url).href;
      continue;
    }

    if (!response.ok) throw new PiSearchError('HttpStatusError', `HTTP ${response.status}`, { status: response.status });
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType && !TEXT_CONTENT_TYPES.includes(contentType)) {
      throw new PiSearchError('ContentTypeError', `Unsupported content type: ${contentType}`);
    }
    const compressed = await readLimitedResponse(response, maxBytes);
    const decoded = await decodeResponse(compressed, response.headers.get('content-encoding'), maxBytes);
    if (decoded.byteLength > maxBytes) throw new PiSearchError('SizeLimitError', 'Decoded response exceeded maxBytes', { maxBytes });

    const raw = decoded.toString('utf8');
    const sanitized = sanitizeHtml(raw);
    const clipped = truncateText(sanitized.text, maxChars);
    if (validation.url.protocol === 'http:') {
      sanitized.riskFlags.push('plaintext-http');
    }
    return {
      url: validation.url.href,
      text: wrapUntrusted(clipped.text),
      riskFlags: uniqueFlags(sanitized.riskFlags),
      truncated: clipped.truncated,
      details: {
        contentType,
        maxBytes,
        maxChars,
        privateNetworkException,
      },
    };
  }

  throw new PiSearchError('RedirectLimitError', 'Too many redirects');
}
