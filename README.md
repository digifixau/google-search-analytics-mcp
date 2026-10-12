# Google Search Console + GA4 MCP server

A self-hosted, single-tenant [Model Context Protocol](https://modelcontextprotocol.io) server that gives **Claude** (claude.ai, Claude Desktop, Claude Code) and **ChatGPT** access to your **Google Search Console** and **Google Analytics 4** data. It runs **read-only** by default. You can enable **read-write** for the connections you choose.

- **46 tools**: search performance, period comparisons, quick-win finder, URL inspection, sitemaps, GA4 reports (standard, realtime, pivot), GA4 admin, audiences, data streams, and the Indexing API.
- **Remote or local**: a Streamable HTTP endpoint with its own OAuth 2.1 server (works as a custom connector in claude.ai and ChatGPT), or stdio for Claude Desktop and Claude Code.
- **Your credentials stay on your server**: sign in to Google once (OAuth) or use a service account. Refresh tokens are encrypted at rest with AES-256-GCM.
- **Layered access control**: a server-wide mode, a per-connection grant, optional allowlists, and an audit log of every write.

---

**Deploying?** Start with the **[deploy guide](docs/DEPLOY.md)**.

## How read-only and read-write work

Each layer can only narrow access. It can never widen it.

| Layer             | Setting                                                          | Effect                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Server mode    | `ACCESS_MODE=readonly` (default) or `readwrite`                  | In `readonly` mode, write tools are never registered and Google is only asked for read-only scopes (`webmasters.readonly`, `analytics.readonly`).                        |
| 2. Write families | `WRITE_TOOLSETS=gsc,indexing,ga4_admin,ga4_audiences_streams`    | Turns individual write families on or off. Google scopes are requested to match.                                                                                         |
| 3. Per connection | Consent screen checkbox "Make changes (write)" / API key scope   | When a client connects, you approve it with your admin password and choose read or read+write. For example, ChatGPT can be read-only while Claude Desktop is read+write. |
| 4. Allowlists     | `ALLOWED_GSC_SITES`, `ALLOWED_GA4_PROPERTIES`, `WRITE_ALLOWED_*` | Restricts which properties are visible at all, and which can be changed.                                                                                                 |

Write tools are annotated with `readOnlyHint: false`, and with `destructiveHint` where it applies, so Claude and ChatGPT ask you to confirm before running them. Their descriptions start with `[WRITE]`. Every write attempt, successful or not, is written to the `audit_log` table and to the container logs. The 20 most recent appear on `/setup`.

---

## Tools

**Search Console (read):** `gsc_list_sites`, `gsc_search_analytics`, `gsc_compare_periods`, `gsc_opportunities`, `gsc_list_sitemaps`, `gsc_get_sitemap`, `gsc_inspect_url`

**GA4 (read):** `ga4_list_properties`, `ga4_get_property`, `ga4_get_metadata`, `ga4_run_report`, `ga4_run_realtime_report`, `ga4_run_pivot_report`, `ga4_check_compatibility`, `ga4_list_custom_dimensions`, `ga4_list_custom_metrics`, `ga4_list_key_events`, `ga4_list_data_streams`, `ga4_list_audiences`, `ga4_get_data_retention`, `ga4_list_measurement_protocol_secrets`

**ChatGPT deep-research compatibility (read):** `search`, `fetch`. These return 28-day performance briefs per site or property.

**Indexing API:** `indexing_get_status` (read; only available in read-write mode because it needs the `indexing` scope), `indexing_publish` (write)

**Search Console (write, `gsc`):** `gsc_submit_sitemap`, `gsc_delete_sitemap`, `gsc_add_site`, `gsc_delete_site`

**GA4 admin (write, `ga4_admin`):** create, update and archive custom dimensions and custom metrics; create and delete key events; update data retention

**GA4 audiences & streams (write, `ga4_audiences_streams`):** create, update and archive audiences; create, update and delete data streams; create and delete Measurement Protocol secrets

> The Indexing API is officially supported only for pages with `JobPosting` or `BroadcastEvent` structured data. The default quota is 200 publishes per day.

---

## 1. Google Cloud setup (one time)

1. Create or choose a project at <https://console.cloud.google.com>.
2. **Enable these APIs:** _Google Search Console API_, _Google Analytics Data API_, _Google Analytics Admin API_ and, if you will use it, _Web Search Indexing API_.
3. Pick an auth mode:

### Option A: OAuth as yourself (recommended)

1. In **APIs & Services → OAuth consent screen**, configure the app and add yourself as a test user (or publish it).
2. In **APIs & Services → Credentials → Create credentials → OAuth client ID**, choose **Web application** and add these redirect URIs:
   - `https://YOUR-DOMAIN/oauth/google/callback` (remote server)
   - `http://localhost:53682/oauth/google/callback` (only if you use the local `google-auth` command)
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_OWNER_EMAIL` (your Google address; required for remote deployments, so no other Google account can ever be connected).

> If the consent screen is in **Testing** status, Google expires refresh tokens after 7 days. Publish the app (internal apps in a Workspace org are fine) to avoid having to reconnect weekly.

### Option B: Service account

1. Create a service account and a JSON key.
2. Add the service account email as a user in **each** Search Console property (Owner if you want sitemap, site or Indexing API changes) and **each** GA4 property (Viewer for read, Editor for write).
3. Set `GOOGLE_AUTH_MODE=service_account` and `GOOGLE_SERVICE_ACCOUNT_JSON` (raw JSON, a file path, or base64).

---

## 2. Deploy on Coolify

> **New here?** Follow the step-by-step **[deploy guide](docs/DEPLOY.md)**. It covers Google Cloud, Coolify, connecting your AI apps, day-2 operations and troubleshooting. Below is the short version.

1. **New Resource → Public/Private Repository** → this repo, **Build Pack: Dockerfile**. (The **Docker Compose** pack with `docker-compose.yml` also works.)
2. **Ports Exposes:** `3000`. Assign your domain, e.g. `https://mcp.example.com`.
3. **Persistent Storage:** add a volume mounted at `/data`. It holds the SQLite DB with the encrypted Google token and OAuth clients.
4. **Environment variables** (see `.env.example`):
   ```env
   PUBLIC_URL=https://mcp.example.com
   ACCESS_MODE=readonly            # or readwrite
   ADMIN_PASSWORD=<openssl rand -base64 24>
   ENCRYPTION_KEY=<openssl rand -hex 32>
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_OWNER_EMAIL=you@example.com
   ```
5. Deploy. The image has a built-in health check on `/healthz`.
6. Open **`https://mcp.example.com/setup`**, sign in with `ADMIN_PASSWORD`, and click **Connect Google**.

If you change `ACCESS_MODE` or `WRITE_TOOLSETS` later, click **Reconnect Google** on `/setup` so Google grants the new scopes. The page warns you when scopes are missing.

Any other Docker host works the same way: `cp .env.example .env`, edit it, then run `docker compose up -d` behind a TLS reverse proxy.

---

## 3. Connect your AI clients

The MCP URL is **`https://mcp.example.com/mcp`**.

### Claude (claude.ai, Desktop and mobile)

**Settings → Connectors → Add custom connector** → paste the MCP URL → **Connect**. You'll see this server's consent page. Enter your admin password and tick **Make changes** only if you want this connection to have write access.

### ChatGPT

Enable **Developer mode** (Settings → Apps & Connectors → Advanced settings), then create a connector with the MCP URL and **OAuth** authentication, and approve it on the consent page. In developer mode ChatGPT can use every tool, including writes, and it asks for confirmation on writes. Outside developer mode, ChatGPT's deep research uses the `search` and `fetch` tools.

### Claude Code

```bash
# OAuth (opens the consent page in your browser)
claude mcp add --transport http google-search-analytics https://mcp.example.com/mcp

# or a static API key from MCP_API_KEYS (e.g. MCP_API_KEYS=claude-code=<token>:read+write)
claude mcp add --transport http google-search-analytics https://mcp.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

### Claude Desktop (local stdio, no server needed)

```bash
npm ci && npm run build
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... ENCRYPTION_KEY=... DATA_DIR=~/.gsa-mcp \
  node dist/index.js google-auth      # one-time Google sign-in
```

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-search-analytics": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "ACCESS_MODE": "readonly",
        "DATA_DIR": "/Users/you/.gsa-mcp",
        "ENCRYPTION_KEY": "...",
        "GOOGLE_CLIENT_ID": "...",
        "GOOGLE_CLIENT_SECRET": "..."
      }
    }
  }
}
```

In stdio mode, the connection gets whatever `ACCESS_MODE` allows.

---

## Configuration reference

| Variable                                                   | Default                      | Description                                                                         |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `TRANSPORT`                                                | `stdio` (`http` in Docker)   | `http` or `stdio`                                                                   |
| `PUBLIC_URL`                                               | –                            | Required for `http`. Must be https, except for localhost.                           |
| `PORT` / `HOST`                                            | `3000` / `0.0.0.0`           | Listen address                                                                      |
| `DATA_DIR`                                                 | `./data` (`/data` in Docker) | SQLite database location                                                            |
| `ACCESS_MODE`                                              | `readonly`                   | `readonly` or `readwrite`                                                           |
| `WRITE_TOOLSETS`                                           | all                          | Comma list of `gsc`, `indexing`, `ga4_admin`, `ga4_audiences_streams`               |
| `ADMIN_PASSWORD`                                           | –                            | Required for `http`, at least 16 chars. Approves connections and protects `/setup`. |
| `ENCRYPTION_KEY`                                           | –                            | Required in oauth mode, at least 32 chars                                           |
| `MCP_API_KEYS`                                             | –                            | `label=token:read[+write]`, comma separated. Tokens must be at least 24 chars.      |
| `ACCESS_TOKEN_TTL_SECONDS`                                 | `3600`                       | OAuth access token lifetime                                                         |
| `REFRESH_TOKEN_TTL_DAYS`                                   | `30`                         | Rotating refresh token lifetime                                                     |
| `GOOGLE_AUTH_MODE`                                         | `oauth`                      | `oauth` or `service_account`                                                        |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                | –                            | OAuth client (oauth mode)                                                           |
| `GOOGLE_OWNER_EMAIL`                                       | –                            | Required for `http` + oauth. Only this (verified) Google account may be connected   |
| `GOOGLE_SERVICE_ACCOUNT_JSON`                              | –                            | Key JSON, path, or base64 (service account mode)                                    |
| `ALLOWED_GSC_SITES` / `ALLOWED_GA4_PROPERTIES`             | all                          | Read allowlists                                                                     |
| `WRITE_ALLOWED_GSC_SITES` / `WRITE_ALLOWED_GA4_PROPERTIES` | read lists                   | Write allowlists                                                                    |
| `TRUST_PROXY`                                              | `true`                       | Trust one reverse-proxy hop for client IPs (rate limiting)                          |

## Security notes

**Who can do what.** Knowing the server URL gets someone nothing on its own:

| Someone with the link tries to…                   | What happens                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Call `/mcp` directly                              | `401`: every request needs a token issued by this server (or a configured API key).                                  |
| Add it as a connector in their own Claude/ChatGPT | They reach the consent page, but approving needs `ADMIN_PASSWORD`. Without it no token is issued.                    |
| Open `/setup`                                     | Password prompt; nothing is shown before sign-in.                                                                    |
| Connect their own Google account                  | Impossible: Google can only be linked from `/setup`, and only the verified `GOOGLE_OWNER_EMAIL` account is accepted. |

**Password protection.** Wrong passwords are rate-limited at 10 per IP per 15 minutes. After 30 failures from any mix of IPs, all password logins lock for 15 minutes; this also locks you out briefly, which is the trade-off for stopping distributed guessing. Counters survive restarts. Lockouts are logged as `[security]` lines in the container logs.

**Other safeguards**

- Access and refresh tokens are stored only as SHA-256 hashes. Refresh tokens rotate on every use, and a reused refresh token is rejected.
- Dynamic client registration accepts any `https` redirect URI (or `http` on localhost) and is limited to 20 registrations per hour per IP. Registrations that never get approved are deleted after 24 hours.
- Review and revoke connected clients on `/setup`. To revoke Google access entirely, use `/setup → Disconnect` and <https://myaccount.google.com/permissions>.
- The `/mcp` endpoint is stateless and validates the `Host` header against `PUBLIC_URL`.
- If you suspect the password leaked: change `ADMIN_PASSWORD`, redeploy, and revoke any unknown clients on `/setup`.

## Development

```bash
npm ci
npm run dev         # tsx watch (uses .env if present)
npm test            # vitest
npm run lint && npm run typecheck && npm run build
npx @modelcontextprotocol/inspector   # point it at http://localhost:3000/mcp or the stdio command
```

Project layout: `src/tools/*` (tool definitions), `src/mcp/server.ts` (per-grant tool registration), `src/auth/*` (OAuth server and consent pages), `src/http/app.ts` (Express app), `src/google/*` (Google auth and clients), `src/store/*` (SQLite and encryption).
