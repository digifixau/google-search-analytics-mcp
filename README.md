# Google Search Console, GA4 & Tag Manager MCP server

A self-hosted, single-tenant [Model Context Protocol](https://modelcontextprotocol.io) server that gives **Claude** (claude.ai, Claude Desktop, Claude Code) and **ChatGPT** access to your **Google Search Console**, **Google Analytics 4** and **Google Tag Manager**. It runs **read-only** by default. You can enable **read-write** for the connections you choose.

- **One app, several MCPs.** Each product family is its own MCP endpoint, so every connector keeps a short, focused tool list:

  | MCP                               | URL        | Tools                                                                                                                                                 |
  | --------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Google Search Console & Analytics | `/mcp`     | 46: search performance, period comparisons, quick-win finder, URL inspection, sitemaps, GA4 reports, GA4 admin, audiences, data streams, Indexing API |
  | Google Tag Manager                | `/mcp/gtm` | 22: container audit, tags/triggers/variables, workspaces, versions, publishing                                                                        |

  All MCPs share one deployment, one Google sign-in, one approval page and one audit log. More can be added later (e.g. YouTube Analytics at `/mcp/youtube`); see [Adding a new MCP](#adding-a-new-mcp-eg-youtube-analytics). Turn whole products off with `ENABLED_SERVICES`.

- **Remote or local**: a Streamable HTTP endpoint with its own OAuth 2.1 server (works as a custom connector in claude.ai and ChatGPT), or stdio for Claude Desktop and Claude Code.
- **Your credentials stay on your server**: sign in to Google once (OAuth) or use a service account. Refresh tokens are encrypted at rest with AES-256-GCM.
- **Layered access control**: a server-wide mode, a per-connection grant, optional allowlists, and an audit log of every write.

---

**Deploying?** Start with the **[deploy guide](docs/DEPLOY.md)**.

## How read-only and read-write work

Each layer can only narrow access. It can never widen it.

| Layer             | Setting                                                                                    | Effect                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Server mode    | `ACCESS_MODE=readonly` (default) or `readwrite`                                            | In `readonly` mode, write tools are never registered and Google is only asked for read-only scopes (`webmasters.readonly`, `analytics.readonly`).                        |
| 2. Write families | `WRITE_TOOLSETS=gsc,indexing,ga4_admin,ga4_audiences_streams,gtm,gtm_publish`              | Turns individual write families on or off. Google scopes are requested to match.                                                                                         |
| 3. Per connection | Consent screen checkbox "Make changes (write)" / API key scope                             | When a client connects, you approve it with your admin password and choose read or read+write. For example, ChatGPT can be read-only while Claude Desktop is read+write. |
| 4. Allowlists     | `ALLOWED_GSC_SITES`, `ALLOWED_GA4_PROPERTIES`, `ALLOWED_GTM_CONTAINERS`, `WRITE_ALLOWED_*` | Restricts which properties are visible at all, and which can be changed.                                                                                                 |

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

**Tag Manager (read):** `gtm_list_containers`, `gtm_list_workspaces`, `gtm_workspace_status`, `gtm_list_tags`, `gtm_list_triggers`, `gtm_list_variables`, `gtm_get_entity`, `gtm_list_versions`, `gtm_get_live_version`, `gtm_audit_container` (finds tags with no trigger, paused tags, unused triggers and variables, duplicate names, and GA4 measurement IDs that don't match any GA4 property you can see)

**Tag Manager (write, `gtm`):** `gtm_create_workspace`; create, update and delete tags, triggers and variables; `gtm_create_version` (a snapshot, not live)

**Tag Manager publish (write, `gtm_publish`):** `gtm_publish_version` puts a version **live on your website**. As a safety check it requires the container ID (`GTM-XXXX`) to be typed back, and it reports the previously live version so you can roll back by publishing that one again.

> The Indexing API is officially supported only for pages with `JobPosting` or `BroadcastEvent` structured data. The default quota is 200 publishes per day.

---

## 1. Google Cloud setup (one time)

1. Create or choose a project at <https://console.cloud.google.com>.
2. **Enable these APIs:** _Google Search Console API_, _Google Analytics Data API_, _Google Analytics Admin API_, _Tag Manager API_ and, if you will use it, _Web Search Indexing API_.
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
2. Add the service account email as a user in **each** Search Console property (Owner if you want sitemap, site or Indexing API changes) **each** GA4 property (Viewer for read, Editor for write), and **each** GTM container (Read, Edit, or Publish for publishing).
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

Add **each MCP as its own connector** in your AI app; connect only the ones you need:

- Search Console & Analytics: **`https://mcp.example.com/mcp`**
- Tag Manager: **`https://mcp.example.com/mcp/gtm`**

Each connector is approved separately, so you can, for example, give the GTM connector write access while keeping Search Console & Analytics read-only. A connection approved for one MCP can't be used on another. `/setup` lists every MCP URL with its tool count.

### Claude (claude.ai, Desktop and mobile)

**Settings → Connectors → Add custom connector** → paste the MCP URL → **Connect**. You'll see this server's consent page. Enter your admin password and tick **Make changes** only if you want this connection to have write access.

### ChatGPT

Enable **Developer mode** (Settings → Apps & Connectors → Advanced settings), then create a connector with the MCP URL and **OAuth** authentication, and approve it on the consent page. In developer mode ChatGPT can use every tool, including writes, and it asks for confirmation on writes. Outside developer mode, ChatGPT's deep research uses the `search` and `fetch` tools.

### Claude Code

```bash
# OAuth (opens the consent page in your browser)
claude mcp add --transport http google-search-analytics https://mcp.example.com/mcp
claude mcp add --transport http google-tag-manager https://mcp.example.com/mcp/gtm

# or a static API key from MCP_API_KEYS (e.g. MCP_API_KEYS=claude-code=<token>:read+write); API keys work on every MCP
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
    },
    "google-tag-manager": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js", "--connector", "gtm"],
      "env": { "...": "same env as above" }
    }
  }
}
```

In stdio mode each process serves one MCP (`--connector search-analytics` by default, or `--connector gtm`), and the connection gets whatever `ACCESS_MODE` allows.

---

## Configuration reference

| Variable                                                   | Default                      | Description                                                                                           |
| ---------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `TRANSPORT`                                                | `stdio` (`http` in Docker)   | `http` or `stdio`                                                                                     |
| `PUBLIC_URL`                                               | –                            | Required for `http`. Must be https, except for localhost.                                             |
| `PORT` / `HOST`                                            | `3000` / `0.0.0.0`           | Listen address                                                                                        |
| `DATA_DIR`                                                 | `./data` (`/data` in Docker) | SQLite database location                                                                              |
| `ACCESS_MODE`                                              | `readonly`                   | `readonly` or `readwrite`                                                                             |
| `WRITE_TOOLSETS`                                           | all                          | Comma list of `gsc`, `indexing`, `ga4_admin`, `ga4_audiences_streams`, `gtm`, `gtm_publish`           |
| `ENABLED_SERVICES`                                         | all                          | Which products to expose: `gsc`, `ga4`, `gtm`. Fewer services = fewer tools for the AI to choose from |
| `ADMIN_PASSWORD`                                           | –                            | Required for `http`, at least 16 chars. Approves connections and protects `/setup`.                   |
| `ENCRYPTION_KEY`                                           | –                            | Required in oauth mode, at least 32 chars                                                             |
| `MCP_API_KEYS`                                             | –                            | `label=token:read[+write]`, comma separated. Tokens must be at least 24 chars.                        |
| `ACCESS_TOKEN_TTL_SECONDS`                                 | `3600`                       | OAuth access token lifetime                                                                           |
| `REFRESH_TOKEN_TTL_DAYS`                                   | `30`                         | Rotating refresh token lifetime                                                                       |
| `GOOGLE_AUTH_MODE`                                         | `oauth`                      | `oauth` or `service_account`                                                                          |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                | –                            | OAuth client (oauth mode)                                                                             |
| `GOOGLE_OWNER_EMAIL`                                       | –                            | Required for `http` + oauth. Only this (verified) Google account may be connected                     |
| `GOOGLE_SERVICE_ACCOUNT_JSON`                              | –                            | Key JSON, path, or base64 (service account mode)                                                      |
| `ALLOWED_GSC_SITES` / `ALLOWED_GA4_PROPERTIES`             | all                          | Read allowlists                                                                                       |
| `WRITE_ALLOWED_GSC_SITES` / `WRITE_ALLOWED_GA4_PROPERTIES` | read lists                   | Write allowlists                                                                                      |
| `ALLOWED_GTM_CONTAINERS` / `WRITE_ALLOWED_GTM_CONTAINERS`  | all / read list              | GTM containers by public ID (`GTM-ABC123`) or numeric container ID                                    |
| `TRUST_PROXY`                                              | `true`                       | Trust one reverse-proxy hop for client IPs (rate limiting)                                            |

## Security notes

**Who can do what.** Knowing the server URL gets someone nothing on its own:

| Someone with the link tries to…                   | What happens                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Call `/mcp` or `/mcp/gtm` directly                | `401`: every request needs a token issued by this server (or a configured API key).                                  |
| Add it as a connector in their own Claude/ChatGPT | They reach the consent page, but approving needs `ADMIN_PASSWORD`. Without it no token is issued.                    |
| Open `/setup`                                     | Password prompt; nothing is shown before sign-in.                                                                    |
| Connect their own Google account                  | Impossible: Google can only be linked from `/setup`, and only the verified `GOOGLE_OWNER_EMAIL` account is accepted. |

**Password protection.** Wrong passwords are rate-limited at 10 per IP per 15 minutes. After 30 failures from any mix of IPs, all password logins lock for 15 minutes; this also locks you out briefly, which is the trade-off for stopping distributed guessing. Counters survive restarts. Lockouts are logged as `[security]` lines in the container logs.

**Other safeguards**

- Access and refresh tokens are stored only as SHA-256 hashes. Refresh tokens rotate on every use, and a reused refresh token is rejected.
- Dynamic client registration accepts any `https` redirect URI (or `http` on localhost) and is limited to 20 registrations per hour per IP. Registrations that never get approved are deleted after 24 hours.
- Review and revoke connected clients on `/setup`. To revoke Google access entirely, use `/setup → Disconnect` and <https://myaccount.google.com/permissions>.
- Each MCP endpoint is stateless and validates the `Host` header against `PUBLIC_URL`.
- Connections are bound to the MCP they were approved for (OAuth `resource`), so a token approved for Tag Manager is refused on `/mcp`, and the reverse. Static API keys work on every MCP.
- If you suspect the password leaked: change `ADMIN_PASSWORD`, redeploy, and revoke any unknown clients on `/setup`.

## Adding a new MCP (e.g. YouTube Analytics)

Every MCP endpoint is a **connector** in `src/mcp/connectors.ts`. Adding one is mostly additive:

1. **Service and write toolsets.** In `src/config.ts`, add the service to `SERVICES` (e.g. `'youtube'`) and any write toolsets to `WRITE_TOOLSETS`. Map them in `serviceOf()` in `src/tools/registry.ts`.
2. **Google scopes.** In `requiredGoogleScopes()` in `src/google/auth.ts`, add the scopes for read-only and for each write toolset. Existing deployments will see "Reconnect Google" on `/setup`.
3. **API client.** Add the client to `GoogleApis` in `src/google/clients.ts`, e.g. `google.youtubeAnalytics({ version: 'v2' })`.
4. **Tools.** Write `src/tools/youtube.ts` with `defineTool({ toolset: 'youtube', access: 'read' | 'write', ... })` and register it in `src/tools/index.ts`. Read-only gating, `[WRITE]` labels, confirmations and the audit log apply automatically.
5. **Connector.** Add an entry to `CONNECTORS`: `{ id: 'youtube', path: '/mcp/youtube', serverName, title, services: ['youtube'], includeCompat: false, instructions }`.

The HTTP routes, OAuth resource metadata, token binding, consent page, `/setup` listing, `ENABLED_SERVICES` switch and stdio `--connector youtube` all follow from the connector entry.

## Development

```bash
npm ci
npm run dev         # tsx watch (uses .env if present)
npm test            # vitest
npm run lint && npm run typecheck && npm run build
npx @modelcontextprotocol/inspector   # point it at http://localhost:3000/mcp or the stdio command
```

Project layout: `src/tools/*` (tool definitions), `src/mcp/connectors.ts` (MCP endpoints), `src/mcp/server.ts` (per-connector, per-grant tool registration), `src/auth/*` (OAuth server and consent pages), `src/http/app.ts` (Express app), `src/google/*` (Google auth and clients), `src/store/*` (SQLite and encryption).
