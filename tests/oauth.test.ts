import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OwnerOAuthProvider } from '../src/auth/provider.js';
import { openDb, type Db } from '../src/store/db.js';
import { testConfig } from './helpers.js';

function setup(mode: 'readonly' | 'readwrite' = 'readwrite', db: Db = openDb(':memory:')) {
  const config = testConfig({
    TRANSPORT: 'http',
    PUBLIC_URL: 'https://mcp.example.com',
    ADMIN_PASSWORD: 'correct-horse-battery',
    GOOGLE_OWNER_EMAIL: 'owner@example.com',
    ACCESS_MODE: mode,
    MCP_API_KEYS: 'ci=abcdefghijklmnopqrstuvwxyz0123:read',
  });
  const provider = new OwnerOAuthProvider(config, db);
  const client = provider.clientsStore.registerClient({
    client_id: 'client-1',
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
  } as OAuthClientInformationFull);
  return { provider, client, db };
}

function fakeRes() {
  const res = {
    body: '',
    status: () => res,
    set: () => res,
    send: (b: string) => ((res.body = b), res),
  };
  return res as unknown as Response & { body: string };
}

async function startAuth(
  provider: OwnerOAuthProvider,
  client: OAuthClientInformationFull,
  scopes: string[] = [],
) {
  const res = fakeRes();
  const verifier = 'v'.repeat(50);
  const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
  await provider.authorize(
    client,
    { scopes, codeChallenge, redirectUri: client.redirect_uris[0]!.toString(), state: 's1' },
    res,
  );
  const requestId = /name="request_id" value="([^"]+)"/.exec(res.body)![1]!;
  return { requestId, html: res.body, codeChallenge };
}

describe('OwnerOAuthProvider', () => {
  it('rejects non-https redirect URIs at registration', () => {
    const { provider } = setup();
    expect(() =>
      provider.clientsStore.registerClient({
        client_id: 'x',
        redirect_uris: ['http://evil.com/cb'],
      } as unknown as OAuthClientInformationFull),
    ).toThrow(/https/);
  });

  it('issues read-only tokens unless the owner ticks write', async () => {
    const { provider, client } = setup();
    const { requestId, codeChallenge, html } = await startAuth(provider, client);
    expect(html).toContain('Make changes (write)');

    const wrong = provider.handleConsent(
      { request_id: requestId, password: 'nope', decision: 'approve' },
      '1.1.1.1',
    );
    expect(wrong.kind).toBe('page');

    const ok = provider.handleConsent(
      { request_id: requestId, password: 'correct-horse-battery', decision: 'approve' },
      '1.1.1.1',
    );
    expect(ok.kind).toBe('redirect');
    const location = new URL((ok as { location: string }).location);
    expect(location.searchParams.get('state')).toBe('s1');
    const code = location.searchParams.get('code')!;

    expect(await provider.challengeForAuthorizationCode(client, code)).toBe(codeChallenge);
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.scope).toBe('mcp:read');
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow(/Invalid/);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.scopes).toEqual(['mcp:read']);
    expect(info.resource?.href).toBe('https://mcp.example.com/mcp');

    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow(
      /Invalid/,
    );
    await expect(
      provider.exchangeRefreshToken(client, refreshed.refresh_token!, ['mcp:read', 'mcp:write']),
    ).rejects.toThrow(/exceed/);
  });

  it('grants write when ticked on a read-write server, never on a read-only one', async () => {
    for (const [mode, expected] of [
      ['readwrite', 'mcp:read mcp:write'],
      ['readonly', 'mcp:read'],
    ] as const) {
      const { provider, client } = setup(mode);
      const { requestId, html } = await startAuth(provider, client, ['mcp:read', 'mcp:write']);
      expect(html.includes('Make changes (write)')).toBe(mode === 'readwrite');
      const ok = provider.handleConsent(
        {
          request_id: requestId,
          password: 'correct-horse-battery',
          decision: 'approve',
          scope_write: '1',
        },
        'ip',
      );
      const code = new URL((ok as { location: string }).location).searchParams.get('code')!;
      expect((await provider.exchangeAuthorizationCode(client, code)).scope).toBe(expected);
    }
  });

  it('redirects with access_denied when the owner denies', async () => {
    const { provider, client } = setup();
    const { requestId } = await startAuth(provider, client);
    const out = provider.handleConsent({ request_id: requestId, decision: 'deny' }, 'ip');
    expect((out as { location: string }).location).toContain('error=access_denied');
  });

  it('rejects foreign resources and unknown scopes', async () => {
    const { provider, client } = setup();
    await expect(
      provider.authorize(
        client,
        {
          codeChallenge: 'c',
          redirectUri: 'https://claude.ai/api/mcp/auth_callback',
          resource: new URL('https://other.com/mcp'),
        },
        fakeRes(),
      ),
    ).rejects.toThrow(/resource/);
    await expect(startAuth(provider, client, ['admin'])).rejects.toThrow(/Unsupported scope/);
  });

  it('accepts static API keys and rate-limits password guessing', async () => {
    const { provider } = setup();
    expect((await provider.verifyAccessToken('abcdefghijklmnopqrstuvwxyz0123')).clientId).toBe(
      'api-key:ci',
    );
    await expect(provider.verifyAccessToken('nope')).rejects.toThrow();
    for (let i = 0; i < 10; i++) provider.recordFailure('9.9.9.9');
    expect(provider.checkRateLimit('9.9.9.9')).toBe(false);
    expect(provider.checkRateLimit('8.8.8.8')).toBe(true);
  });

  describe('password lockout', () => {
    afterEach(() => vi.useRealTimers());

    it('locks every IP after 30 failures spread across many IPs, then recovers', () => {
      vi.useFakeTimers();
      const { provider } = setup();
      const spam = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (let i = 0; i < 30; i++) provider.recordFailure(`10.0.0.${i}`);
      expect(provider.checkRateLimit('203.0.113.7')).toBe(false);
      expect(spam).toHaveBeenCalledWith(expect.stringContaining('[security]'));
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      expect(provider.checkRateLimit('203.0.113.7')).toBe(true);
      spam.mockRestore();
    });

    it('blocks the correct password on the consent page while locked', async () => {
      const { provider, client } = setup();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      for (let i = 0; i < 30; i++) provider.recordFailure(`10.0.1.${i}`);
      const { requestId } = await startAuth(provider, client);
      const out = provider.handleConsent(
        { request_id: requestId, password: 'correct-horse-battery', decision: 'approve' },
        '198.51.100.1',
      );
      expect(out).toMatchObject({ kind: 'page', status: 429 });
      vi.mocked(console.error).mockRestore();
    });

    it('keeps counters across restarts', () => {
      const db = openDb(':memory:');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const first = setup('readwrite', db).provider;
      for (let i = 0; i < 10; i++) first.recordFailure('9.9.9.9');
      const restarted = new OwnerOAuthProvider(
        testConfig({
          TRANSPORT: 'http',
          PUBLIC_URL: 'https://mcp.example.com',
          ADMIN_PASSWORD: 'correct-horse-battery',
          GOOGLE_OWNER_EMAIL: 'owner@example.com',
        }),
        db,
      );
      expect(restarted.checkRateLimit('9.9.9.9')).toBe(false);
      vi.mocked(console.error).mockRestore();
    });
  });

  it('forgets registrations that never got approved after 24h', async () => {
    const { provider, client, db } = setup();
    const unused = provider.clientsStore.registerClient({
      client_id: 'spam',
      redirect_uris: ['https://spam.example/cb'],
    } as OAuthClientInformationFull);
    // Approve client-1 so it holds tokens.
    const { requestId } = await startAuth(provider, client);
    const ok = provider.handleConsent(
      { request_id: requestId, password: 'correct-horse-battery', decision: 'approve' },
      'ip',
    );
    const code = new URL((ok as { location: string }).location).searchParams.get('code')!;
    await provider.exchangeAuthorizationCode(client, code);

    db.prepare('UPDATE oauth_clients SET created_at = ?').run(Date.now() - 25 * 60 * 60 * 1000);
    await startAuth(provider, client); // authorize() runs the sweep
    expect(provider.clientsStore.getClient(unused.client_id)).toBeUndefined();
    expect(provider.clientsStore.getClient(client.client_id)).toBeDefined();
  });
});
