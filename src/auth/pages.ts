export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1a1d21;--muted:#5d6670;--border:#dde1e6;--accent:#1a73e8;--danger:#c5221f;--ok:#188038}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1c1f24;--text:#e8eaed;--muted:#9aa0a6;--border:#30343a;--accent:#8ab4f8;--danger:#f28b82;--ok:#81c995}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:48px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:13px}
label{display:block;margin:12px 0 4px;font-weight:600}
input[type=password]{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:15px}
.check{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--border);border-radius:8px;margin:8px 0;font-weight:400}
.check input{margin-top:4px}.check strong{display:block}
.row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
button{padding:10px 16px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:14px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--danger)}
.err{color:var(--danger);font-weight:600}.ok{color:var(--ok);font-weight:600}
code{font-size:13px;word-break:break-all}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--border);vertical-align:top}
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export interface ConsentView {
  requestId: string;
  clientName: string;
  /** Which MCP endpoint is being connected. */
  mcpTitle: string;
  redirectHost: string;
  writeAvailable: boolean;
  writeRequested: boolean;
  accessMode: string;
  error?: string;
}

export function consentPage(v: ConsentView): string {
  const write = v.writeAvailable
    ? `<label class="check"><input type="checkbox" name="scope_write" value="1" ${v.writeRequested ? 'checked' : ''}>
         <span><strong>Make changes (write)</strong><span class="muted">Submit/delete sitemaps, manage Search Console properties, GA4 admin settings, audiences, data streams and Indexing API requests.</span></span></label>`
    : `<p class="muted">This server runs in <strong>${escapeHtml(v.accessMode)}</strong> mode, so only read access can be granted.</p>`;
  return page(
    'Authorize connection',
    `<div class="card">
      <h1>Authorize ${escapeHtml(v.clientName)}</h1>
      <p class="muted">wants to connect to the <strong>${escapeHtml(v.mcpTitle)}</strong> MCP on your server. After approval you will be returned to <code>${escapeHtml(v.redirectHost)}</code>.</p>
      ${v.error ? `<p class="err">${escapeHtml(v.error)}</p>` : ''}
      <form method="post" action="/oauth/consent">
        <input type="hidden" name="request_id" value="${escapeHtml(v.requestId)}">
        <label class="check"><input type="checkbox" checked disabled>
          <span><strong>Read data</strong><span class="muted">Search performance, URL inspection, sitemaps, GA4 reports and configuration.</span></span></label>
        ${write}
        <label for="password">Admin password</label>
        <input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
        <div class="row">
          <button class="primary" type="submit" name="decision" value="approve">Approve</button>
          <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
        </div>
      </form>
    </div>`,
  );
}

export function loginPage(error?: string): string {
  return page(
    'Server setup',
    `<div class="card"><h1>Server setup</h1><p class="muted">Sign in with the admin password to connect Google and manage connections.</p>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/setup/login">
        <label for="password">Admin password</label>
        <input id="password" type="password" name="password" autocomplete="current-password" required autofocus>
        <div class="row"><button class="primary" type="submit">Sign in</button></div>
      </form></div>`,
  );
}

/**
 * Sent after the consent form is submitted. Navigating with a meta refresh (instead of a 302 from the
 * form POST) keeps the consent page's `form-action 'self'` CSP from blocking the hop to the client.
 */
export function redirectPage(location: string, approved: boolean): string {
  const target = escapeHtml(location);
  const host = escapeHtml(new URL(location).host);
  return page(
    approved ? 'Connection approved' : 'Connection denied',
    `<div class="card"><h1>${approved ? 'Connection approved' : 'Connection denied'}</h1>
      <p>Returning you to <code>${host}</code>…</p>
      <p><a href="${target}">Continue</a> if nothing happens.</p></div>`,
  ).replace('<head>', `<head><meta http-equiv="refresh" content="0;url=${target}">`);
}

export function messagePage(title: string, message: string, ok = false): string {
  return page(
    title,
    `<div class="card"><h1>${escapeHtml(title)}</h1><p class="${ok ? 'ok' : 'err'}">${escapeHtml(message)}</p><p><a href="/setup">Back to setup</a></p></div>`,
  );
}

export interface DashboardView {
  csrf: string;
  /** One card per MCP, each with its own Google connection. */
  connections: Array<{
    url: string;
    tools: string;
    google: {
      connectionId: string;
      title: string;
      mode: string;
      connected: boolean;
      identity?: string;
      missingScopes: string[];
      connectedAt?: string;
      migratedFromShared?: boolean;
      allowedEmails: string[];
    };
  }>;
  accessMode: string;
  writeToolsets: string[];
  clients: Array<{
    clientId: string;
    name: string;
    mcp: string;
    scopes: string;
    lastIssued: string;
  }>;
  audit: Array<{ ts: string; actor: string; tool: string; outcome: string }>;
  flash?: string;
}

export function dashboardPage(v: DashboardView): string {
  const button = (action: string, id: string, label: string, cls = '') =>
    `<form method="post" action="/setup/google/${action}"><input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}"><input type="hidden" name="connection" value="${escapeHtml(id)}"><button${cls ? ` class="${cls}"` : ''} type="submit">${label}</button></form>`;

  const connectionCard = (c: DashboardView['connections'][number]) => {
    const g = c.google;
    let body: string;
    if (g.mode === 'service_account') {
      body = `<p class="ok">Service account <code>${escapeHtml(g.identity)}</code></p>`;
    } else if (g.mode === 'api_key') {
      // Only whether the key is set is shown, never the key itself.
      body = g.connected
        ? '<p class="ok">API key configured</p><p class="muted">This MCP needs no Google sign-in.</p>'
        : '<p class="err">API key missing</p><p class="muted">Set <code>GOOGLE_PLACES_API_KEY</code> on the server and redeploy.</p>';
    } else if (!g.connected) {
      body = `<p class="err">Not connected</p>
        ${g.allowedEmails.length ? `<p class="muted">Allowed: ${g.allowedEmails.map(escapeHtml).join(', ')}</p>` : ''}
        <div class="row">${button('connect', g.connectionId, 'Connect Google', 'primary')}</div>`;
    } else {
      const status = g.missingScopes.length
        ? `<p class="err">Connected as ${escapeHtml(g.identity ?? 'unknown account')}, but missing scopes — reconnect:</p><p class="muted">${g.missingScopes.map(escapeHtml).join('<br>')}</p>`
        : `<p class="ok">Connected as ${escapeHtml(g.identity ?? 'unknown account')}</p>`;
      const shared = g.migratedFromShared
        ? '<p class="muted">Using the shared Google connection from before the upgrade. Reconnect to use a separate account for this MCP.</p>'
        : `<p class="muted">Since ${escapeHtml(g.connectedAt)}</p>`;
      body = `${status}${shared}<div class="row">${button('connect', g.connectionId, 'Reconnect')}${button('disconnect', g.connectionId, 'Disconnect', 'danger')}</div>`;
    }
    return `<div class="card"><h2>${escapeHtml(g.title)}</h2>
      <p>MCP URL: <code>${escapeHtml(c.url)}</code> <span class="muted">(${escapeHtml(c.tools)} tools)</span></p>
      ${body}</div>`;
  };

  const clients = v.clients.length
    ? `<table><tr><th>Client</th><th>MCP</th><th>Scopes</th><th>Last token</th><th></th></tr>${v.clients
        .map(
          (
            c,
          ) => `<tr><td>${escapeHtml(c.name)}<br><span class="muted">${escapeHtml(c.clientId)}</span></td><td>${escapeHtml(c.mcp)}</td><td>${escapeHtml(c.scopes)}</td><td>${escapeHtml(c.lastIssued)}</td>
          <td><form method="post" action="/setup/clients/revoke"><input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}"><input type="hidden" name="client_id" value="${escapeHtml(c.clientId)}"><button class="danger" type="submit">Revoke</button></form></td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No connected clients yet.</p>';

  const audit = v.audit.length
    ? `<table><tr><th>When</th><th>Who</th><th>Tool</th><th>Result</th></tr>${v.audit
        .map(
          (a) =>
            `<tr><td>${escapeHtml(a.ts)}</td><td>${escapeHtml(a.actor)}</td><td>${escapeHtml(a.tool)}</td><td>${escapeHtml(a.outcome)}</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No write actions yet.</p>';

  return page(
    'Server setup',
    `${v.flash ? `<div class="card"><p class="ok">${escapeHtml(v.flash)}</p></div>` : ''}
    <div class="card"><h1>Google Marketing MCP server</h1>
      <p class="muted">Each MCP below has its own Google account. Add each MCP as its own connector in Claude or ChatGPT.</p>
      <p>Access mode: <strong>${escapeHtml(v.accessMode)}</strong>${v.accessMode === 'readwrite' ? ` <span class="muted">(write toolsets: ${v.writeToolsets.map(escapeHtml).join(', ')})</span>` : ''}</p>
      <form method="post" action="/setup/logout"><input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}"><button type="submit">Sign out</button></form></div>
    ${v.connections.map(connectionCard).join('')}
    <div class="card"><h2>Connected clients</h2>${clients}</div>
    <div class="card"><h2>Recent write actions</h2>${audit}</div>`,
  );
}
