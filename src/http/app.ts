import express, { type NextFunction, type Request, type Response } from 'express';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from '../app.js';
import { MCP_SCOPES } from '../config.js';
import { OwnerOAuthProvider } from '../auth/provider.js';
import { dashboardPage, loginPage, messagePage, redirectPage } from '../auth/pages.js';
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from '../mcp/server.js';
import { randomToken } from '../store/crypto.js';

const SESSION_COOKIE = 'gsa_setup';
const SESSION_TTL_MS = 30 * 60 * 1000;

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
};

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function createHttpApp(app: AppContext): express.Express {
  const { config } = app;
  const publicUrl = config.publicUrl!;
  const provider = new OwnerOAuthProvider(config, app.db);
  const mcpUrl = new URL('/mcp', publicUrl);
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();
  const googleStates = new Map<string, number>();

  const server = express();
  server.disable('x-powered-by');
  server.set('trust proxy', config.trustProxy ? 1 : false);

  const html = (res: Response, status: number, body: string) =>
    res.status(status).set(HTML_HEADERS).send(body);

  server.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION });
  });

  server.get('/', (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mcp: mcpUrl.href,
      accessMode: config.accessMode,
      setup: new URL('/setup', publicUrl).href,
    });
  });

  // OAuth 2.1 authorization server + protected resource metadata (RFC 8414 / RFC 9728).
  server.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported:
        config.accessMode === 'readwrite' ? [MCP_SCOPES.read, MCP_SCOPES.write] : [MCP_SCOPES.read],
      resourceName: 'Google Search Console & Analytics MCP',
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );

  const form = express.urlencoded({ extended: false, limit: '16kb' });

  server.post('/oauth/consent', form, (req, res) => {
    const outcome = provider.handleConsent(req.body ?? {}, req.ip ?? 'unknown');
    if (outcome.kind === 'redirect') {
      html(res, 200, redirectPage(outcome.location, outcome.approved));
    } else {
      html(res, outcome.status, outcome.html);
    }
  });

  // ---- MCP endpoint (stateless Streamable HTTP) ----
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [MCP_SCOPES.read],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  const hostCheck = hostHeaderValidation([publicUrl.hostname, 'localhost', '127.0.0.1']);

  server.post('/mcp', hostCheck, bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const auth = req.auth!;
    const mcp = buildMcpServer(app, { scopes: auth.scopes, actor: auth.clientId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[mcp] request failed', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed (stateless server)' },
        id: null,
      });
  };
  server.get('/mcp', methodNotAllowed);
  server.delete('/mcp', methodNotAllowed);

  // ---- Owner setup dashboard ----
  const getSession = (req: Request) => {
    const id = readCookie(req, SESSION_COOKIE);
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.expiresAt < Date.now()) return undefined;
    return { id: id!, ...session };
  };
  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const session = getSession(req);
    if (!session || req.body?.csrf !== session.csrf) {
      html(res, 403, messagePage('Session expired', 'Please sign in again.'));
      return;
    }
    next();
  };
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${publicUrl.protocol === 'https:' ? '; Secure' : ''}`;

  server.get('/setup', (req, res) => {
    const session = getSession(req);
    if (!session) return html(res, 200, loginPage());
    const status = app.googleAuth.status();
    const flash =
      req.query.connected === '1'
        ? 'Google account connected.'
        : req.query.revoked === '1'
          ? 'Client access revoked.'
          : undefined;
    html(
      res,
      200,
      dashboardPage({
        csrf: session.csrf,
        mcpUrl: mcpUrl.href,
        accessMode: config.accessMode,
        writeToolsets: config.writeToolsets,
        google: status,
        clients: provider.listClients(),
        audit: app.audit.recent(20).map((a) => ({ ...a, ts: new Date(a.ts).toISOString() })),
        flash,
      }),
    );
  });

  server.post('/setup/login', form, (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (!provider.checkRateLimit(ip))
      return html(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'));
    if (!provider.verifyPassword(req.body?.password)) {
      provider.recordFailure(ip);
      return html(res, 401, loginPage('Incorrect password.'));
    }
    const id = randomToken(32);
    sessions.set(id, { csrf: randomToken(24), expiresAt: Date.now() + SESSION_TTL_MS });
    res
      .set(
        'Set-Cookie',
        `${SESSION_COOKIE}=${id}; ${cookieAttrs}; Max-Age=${SESSION_TTL_MS / 1000}`,
      )
      .redirect(303, '/setup');
  });

  server.post('/setup/logout', form, requireSession, (req, res) => {
    const session = getSession(req);
    if (session) sessions.delete(session.id);
    res.set('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttrs}; Max-Age=0`).redirect(303, '/setup');
  });

  const googleRedirectUri = new URL('/oauth/google/callback', publicUrl).href;

  server.post('/setup/google/connect', form, requireSession, (_req, res) => {
    if (config.google.authMode !== 'oauth')
      return html(res, 400, messagePage('Not available', 'Service account mode needs no consent.'));
    const state = randomToken(24);
    googleStates.set(state, Date.now() + 10 * 60 * 1000);
    res.redirect(303, app.googleAuth.buildConsentUrl(googleRedirectUri, state));
  });

  server.get('/oauth/google/callback', async (req, res) => {
    const state = String(req.query.state ?? '');
    const expiry = googleStates.get(state);
    googleStates.delete(state);
    if (!expiry || expiry < Date.now()) {
      return html(
        res,
        400,
        messagePage(
          'Google connection failed',
          'The request expired or was not started from /setup.',
        ),
      );
    }
    if (req.query.error) {
      return html(
        res,
        400,
        messagePage('Google connection failed', `Google returned: ${String(req.query.error)}`),
      );
    }
    try {
      await app.googleAuth.completeConsent(String(req.query.code ?? ''), googleRedirectUri);
      res.redirect(303, '/setup?connected=1');
    } catch (error) {
      html(res, 400, messagePage('Google connection failed', (error as Error).message));
    }
  });

  server.post('/setup/google/disconnect', form, requireSession, (_req, res) => {
    app.googleAuth.disconnect();
    res.redirect(303, '/setup');
  });

  server.post('/setup/clients/revoke', form, requireSession, (req, res) => {
    provider.revokeClient(String(req.body.client_id ?? ''));
    res.redirect(303, '/setup?revoked=1');
  });

  return server;
}

export async function startHttp(app: AppContext): Promise<void> {
  const server = createHttpApp(app);
  await new Promise<void>((resolve) => {
    server.listen(app.config.port, app.config.host, () => resolve());
  });
  const status = app.googleAuth.status();
  console.error(
    `[gsa-mcp] HTTP server listening on ${app.config.host}:${app.config.port} — MCP endpoint ${new URL('/mcp', app.config.publicUrl).href} (${app.config.accessMode})`,
  );
  if (!status.connected) {
    console.error(
      `[gsa-mcp] Google is not connected yet: open ${new URL('/setup', app.config.publicUrl).href}`,
    );
  } else if (status.missingScopes.length) {
    console.error(
      `[gsa-mcp] Google grant is missing scopes for ${app.config.accessMode} mode; reconnect at /setup`,
    );
  }
}
