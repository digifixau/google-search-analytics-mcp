import { createHash, randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { createAppContext, type AppContext } from '../src/app.js';
import { createHttpApp } from '../src/http/app.js';
import { testConfig } from './helpers.js';

const API_KEY = 'abcdefghijklmnopqrstuvwxyz0123';
let server: Server | undefined;
let app: AppContext;

afterEach(() => {
  server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Starts the real Express app on a free port; PUBLIC_URL is localhost so http is allowed. */
async function start(env: Record<string, string> = {}) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  app = createAppContext(testConfig(baseEnv(base, env)));
  const http = createHttpApp(app);
  server = await new Promise<Server>((resolve) => {
    const s = http.listen(port, '127.0.0.1', () => resolve(s));
  });
  return base;
}

/** Full OAuth flow over HTTP (registration, consent, PKCE token exchange) for one MCP resource. */
async function oauthToken(base: string, resource: string): Promise<string> {
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const reg = (await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
      }),
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource,
  }))
    authorize.searchParams.set(k, v);
  const page = await (await fetch(authorize)).text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(page)![1]!;
  const approved = await (
    await fetch(`${base}/oauth/consent`, {
      method: 'POST',
      body: new URLSearchParams({
        request_id: requestId,
        password: 'correct-horse-battery',
        decision: 'approve',
      }),
    })
  ).text();
  const location = /content="0;url=([^"]+)"/.exec(approved)![1]!.replace(/&amp;/g, '&');
  const tokens = (await (
    await fetch(`${base}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(location).searchParams.get('code')!,
        client_id: reg.client_id,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource,
      }),
    })
  ).json()) as { access_token: string };
  return tokens.access_token;
}

function baseEnv(publicUrl: string, env: Record<string, string>) {
  return {
    TRANSPORT: 'http',
    PUBLIC_URL: publicUrl,
    ADMIN_PASSWORD: 'correct-horse-battery',
    GOOGLE_OWNER_EMAIL: 'owner@example.com',
    ACCESS_MODE: 'readwrite',
    MCP_API_KEYS: `ci=${API_KEY}:read+write`,
    ...env,
  };
}

async function listTools(base: string, path: string, token: string) {
  const call = (method: string, params: object) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  const init = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  });
  const serverName = ((await init.json()) as { result: { serverInfo: { name: string } } }).result
    .serverInfo.name;
  const res = await call('tools/list', {});
  const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
  return { serverName, names: body.result.tools.map((t) => t.name) };
}

describe('HTTP endpoints', () => {
  it('serves each MCP on its own path with its own tools', async () => {
    const base = await start();
    const sa = await listTools(base, '/mcp', API_KEY);
    const gtm = await listTools(base, '/mcp/gtm', API_KEY);
    expect(sa.serverName).toBe('google-search-analytics-mcp');
    expect(gtm.serverName).toBe('google-tag-manager-mcp');
    expect(sa.names).toHaveLength(46);
    expect(gtm.names).toHaveLength(22);
    expect(sa.names.some((n) => n.startsWith('gtm_'))).toBe(false);
  });

  it('advertises protected resource metadata for every endpoint', async () => {
    const base = await start();
    const gtm = (await (
      await fetch(`${base}/.well-known/oauth-protected-resource/mcp/gtm`)
    ).json()) as { resource: string; resource_name: string; authorization_servers: string[] };
    expect(gtm.resource).toBe(`${base}/mcp/gtm`);
    expect(gtm.resource_name).toBe('Google Tag Manager MCP');
    expect(gtm.authorization_servers).toEqual([`${base}/`]);

    const unauth = await fetch(`${base}/mcp/gtm`, { method: 'POST', body: '{}' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/gtm"`,
    );

    const root = (await (await fetch(`${base}/`)).json()) as { mcp: Record<string, string> };
    expect(root.mcp).toEqual({
      'search-analytics': `${base}/mcp`,
      gtm: `${base}/mcp/gtm`,
      youtube: `${base}/mcp/youtube`,
      merchant: `${base}/mcp/merchant`,
    });
  });

  it('removes the GTM endpoint when its service is disabled', async () => {
    const base = await start({ ENABLED_SERVICES: 'gsc,ga4' });
    expect((await fetch(`${base}/mcp/gtm`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await listTools(base, '/mcp', API_KEY)).names).toHaveLength(46);
  });

  it('only accepts a token on the MCP endpoint it was approved for', async () => {
    const base = await start();
    const gtmToken = await oauthToken(base, `${base}/mcp/gtm`);
    // Approved without ticking "Make changes", so only the read tools are exposed.
    expect((await listTools(base, '/mcp/gtm', gtmToken)).names).toHaveLength(10);
    const wrong = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gtmToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toContain('different MCP endpoint');

    const saToken = await oauthToken(base, `${base}/mcp`);
    expect((await listTools(base, '/mcp', saToken)).names).toHaveLength(24);
    expect(
      (
        await fetch(`${base}/mcp/gtm`, {
          method: 'POST',
          headers: { authorization: `Bearer ${saToken}` },
          body: '{}',
        })
      ).status,
    ).toBe(401);
  });
});

/** Signs in to /setup and returns the session cookie plus the CSRF token. */
async function setupSession(base: string) {
  const login = await fetch(`${base}/setup/login`, {
    method: 'POST',
    body: new URLSearchParams({ password: 'correct-horse-battery' }),
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const page = await (await fetch(`${base}/setup`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
  return { cookie, csrf };
}

function setupPost(base: string, path: string, cookie: string, fields: Record<string, string>) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

/** Mocks Google's token endpoint: the authorization code names the account that signed in. */
function mockGoogle(accounts: Record<string, string>) {
  vi.spyOn(OAuth2Client.prototype, 'getToken').mockImplementation((async (opts: {
    code: string;
  }) => ({
    tokens: { refresh_token: `refresh-${opts.code}`, id_token: `id-${opts.code}`, scope: '' },
  })) as never);
  vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation((async (opts: {
    idToken: string;
  }) => ({
    getPayload: () => ({ email: accounts[opts.idToken.slice(3)], email_verified: true }),
  })) as never);
}

describe('/setup Google connections', () => {
  const env = {
    GOOGLE_OWNER_EMAIL: 'owner@example.com',
    GOOGLE_OWNER_EMAIL_GTM: 'tags@example.com',
  };

  it('connects one MCP through Google consent without touching the others', async () => {
    const base = await start(env);
    mockGoogle({ 'code-gtm': 'tags@example.com', 'code-sa': 'owner@example.com' });
    const { cookie, csrf } = await setupSession(base);

    const start1 = await setupPost(base, '/setup/google/connect', cookie, {
      csrf,
      connection: 'gtm',
    });
    expect(start1.status).toBe(303);
    const consent = new URL(start1.headers.get('location')!);
    expect(consent.origin).toBe('https://accounts.google.com');
    const scopes = consent.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual(
      expect.arrayContaining([
        'https://www.googleapis.com/auth/tagmanager.readonly',
        'https://www.googleapis.com/auth/analytics.readonly',
      ]),
    );
    expect(scopes.some((s) => s.includes('webmasters') || s.includes('youtube'))).toBe(false);
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consent.searchParams.get('include_granted_scopes')).toBe('false');
    expect(consent.searchParams.get('login_hint')).toBe('tags@example.com');
    const state = consent.searchParams.get('state')!;

    const callback = `${base}/oauth/google/callback?state=${state}&code=code-gtm`;
    const done = await fetch(callback, { headers: { cookie }, redirect: 'manual' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/setup?connected=1&connection=gtm');
    expect(app.google.get('gtm').status()).toMatchObject({
      connected: true,
      identity: 'tags@example.com',
    });
    for (const id of ['search-analytics', 'youtube', 'merchant'])
      expect(app.google.get(id).status().connected).toBe(false);

    // The state is single use.
    expect((await fetch(callback, { headers: { cookie }, redirect: 'manual' })).status).toBe(400);

    // The dashboard shows a card per MCP and never the token itself.
    const page = await (
      await fetch(`${base}/setup?connected=1&connection=gtm`, { headers: { cookie } })
    ).text();
    expect(page).toContain('Google account connected to the Google Tag Manager MCP.');
    expect(page.match(/name="connection" value="/g)).toHaveLength(5);
    expect(page).toContain('tags@example.com');
    expect(page).not.toContain('refresh-code-gtm');

    // The GTM-only account can't be linked to another MCP.
    const sa = await setupPost(base, '/setup/google/connect', cookie, {
      csrf,
      connection: 'search-analytics',
    });
    const saState = new URL(sa.headers.get('location')!).searchParams.get('state')!;
    const wrong = await fetch(`${base}/oauth/google/callback?state=${saState}&code=code-gtm`, {
      headers: { cookie },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('not allowed');
    expect(app.google.get('search-analytics').status().connected).toBe(false);
  });

  it('rejects callbacks from another session, unknown MCPs and missing CSRF tokens', async () => {
    const base = await start(env);
    mockGoogle({ 'code-gtm': 'tags@example.com' });
    const owner = await setupSession(base);
    const other = await setupSession(base);

    const res = await setupPost(base, '/setup/google/connect', owner.cookie, {
      csrf: owner.csrf,
      connection: 'gtm',
    });
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const url = `${base}/oauth/google/callback?state=${state}&code=code-gtm`;
    expect((await fetch(url, { headers: { cookie: other.cookie } })).status).toBe(400);
    expect((await fetch(url)).status).toBe(400);
    expect(app.google.get('gtm').status().connected).toBe(false);

    expect((await fetch(`${base}/oauth/google/callback?state=forged&code=x`)).status).toBe(400);
    expect(
      (
        await setupPost(base, '/setup/google/connect', owner.cookie, {
          csrf: owner.csrf,
          connection: 'ads',
        })
      ).status,
    ).toBe(400);
    expect(
      (await setupPost(base, '/setup/google/connect', owner.cookie, { connection: 'gtm' })).status,
    ).toBe(403);
    expect(
      (await setupPost(base, '/setup/google/disconnect', owner.cookie, { connection: 'gtm' }))
        .status,
    ).toBe(403);
  });

  it('disconnects only the chosen MCP', async () => {
    const base = await start(env);
    mockGoogle({ a: 'owner@example.com', b: 'tags@example.com' });
    const { cookie, csrf } = await setupSession(base);
    const connect = async (connection: string, code: string) => {
      const res = await setupPost(base, '/setup/google/connect', cookie, { csrf, connection });
      const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
      await fetch(`${base}/oauth/google/callback?state=${state}&code=${code}`, {
        headers: { cookie },
        redirect: 'manual',
      });
    };
    await connect('search-analytics', 'a');
    await connect('gtm', 'b');

    const res = await setupPost(base, '/setup/google/disconnect', cookie, {
      csrf,
      connection: 'gtm',
    });
    expect(res.headers.get('location')).toBe('/setup?disconnected=1&connection=gtm');
    expect(app.google.get('gtm').status().connected).toBe(false);
    expect(app.google.get('search-analytics').status()).toMatchObject({
      connected: true,
      identity: 'owner@example.com',
    });
  });
});
