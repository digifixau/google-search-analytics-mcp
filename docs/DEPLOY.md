# Deploy guide

This guide takes you from nothing to a running server that Claude and ChatGPT can connect to. It takes about 30 minutes.

The main path uses **Coolify**. If you use another host, [section 7](#7-other-hosts-plain-docker) covers plain Docker.

**What you'll end up with**

```
Claude / ChatGPT ──HTTPS──▶ https://mcp.example.com/mcp ──▶ Google Search Console + GA4
                             (your Coolify server)          (as your Google account)
```

---

## 0. Before you start

You need:

- [ ] A Coolify instance with a server that can serve HTTPS (Coolify's built-in proxy handles certificates).
- [ ] A subdomain for the MCP server, e.g. `mcp.example.com`, with a DNS **A record** pointing at your Coolify server.
- [ ] A Google account that can see your Search Console properties and GA4 properties.
- [ ] Access to this GitHub repo from Coolify. For a private repo, connect Coolify to GitHub with its GitHub App, or add a deploy key.

Pick two settings now:

| Setting            | Choose                | When                                                                                                                         |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ACCESS_MODE`      | `readonly` (default)  | Reporting and analysis only. No changes are possible.                                                                        |
|                    | `readwrite`           | You want the AI to submit sitemaps, edit GA4 settings and so on. You still choose per connection whether writes are allowed. |
| `GOOGLE_AUTH_MODE` | `oauth` (recommended) | Sign in once as yourself; the server sees everything you can see.                                                            |
|                    | `service_account`     | You'd rather give a robot account access to specific properties.                                                             |

---

## 1. Generate your secrets

Run these on any machine with `openssl`. Store the output in a password manager.

```bash
openssl rand -base64 24   # ADMIN_PASSWORD  – you type this when approving connections
openssl rand -hex 32      # ENCRYPTION_KEY  – encrypts the stored Google token; never change it later
```

> **Never change `ENCRYPTION_KEY` after first use.** If it changes, the stored Google token can't be decrypted and you'll have to reconnect Google. Changing `ADMIN_PASSWORD` is safe at any time.

---

## 2. Google Cloud setup

Open <https://console.cloud.google.com> and create a project, e.g. "MCP Server", or pick an existing one.

### 2.1 Enable the APIs

**APIs & Services → Library**, search for each of these and click **Enable**:

- Google Search Console API
- Google Analytics Data API
- Google Analytics Admin API
- Tag Manager API
- Web Search Indexing API (only if you'll use `indexing_publish`)

### 2.2a OAuth mode (recommended)

1. **APIs & Services → OAuth consent screen** (shown as "Google Auth Platform" in newer consoles):
   - User type: **External**. If your Google account belongs to a Workspace organisation, use **Internal**.
   - App name, support email, developer email: anything sensible.
   - Scopes: you can skip this; the server requests them itself.
   - **Audience / Publishing status:** click **Publish app**. In _Testing_ status Google expires your sign-in every 7 days. For a single-owner app, publishing doesn't need Google verification. You'll see an "unverified app" warning once when you connect, so click **Advanced → Go to … (unsafe)**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorised redirect URI: `https://mcp.example.com/oauth/google/callback`
   - Click **Create** and copy the **Client ID** and **Client secret**.

### 2.2b Service account mode (alternative)

1. **IAM & Admin → Service accounts → Create service account**. Then open it and go to **Keys → Add key → JSON**, which downloads a file.
2. Copy the service account email (`name@project.iam.gserviceaccount.com`) and grant it access:
   - **Search Console** → each property → Settings → Users and permissions → Add user. Use **Full** for reading. Use **Owner** if you want sitemap, site or Indexing API changes.
   - **GA4** → Admin → Property access management → **+** → add the email. Use **Viewer** for reading, **Editor** for writes.
   - **Tag Manager** → Admin → Container → User Management → **+** → add the email. Use **Read** for auditing, **Edit** for changes, **Publish** to let it publish.
3. Encode the key for the env var: `base64 -w0 key.json` (macOS: `base64 -i key.json`).

---

## 3. Create the app in Coolify

1. **Projects** → choose or create a project → **+ New** → **Resource**.
2. Pick **Private Repository (with GitHub App)** or **Public Repository**, then select this repo and branch **`main`**.
3. **Build Pack:** `Dockerfile` (base directory `/`, Dockerfile location `/Dockerfile`).
4. **Domains:** `https://mcp.example.com`. Include `https://`; Coolify issues the certificate.
5. **Ports Exposes:** `3000`.

### 3.1 Persistent storage (required)

**Persistent Storage → + Add → Volume Mount**

- Name: `gsa-mcp-data`
- Destination path: `/data`

This volume holds the SQLite database: the encrypted Google token, connected clients and the audit log. Without it, every redeploy loses your Google connection and all client approvals.

### 3.2 Environment variables

**Environment Variables → Developer view**, then paste and fill in:

```env
PUBLIC_URL=https://mcp.example.com
ACCESS_MODE=readonly
ADMIN_PASSWORD=<from step 1>
ENCRYPTION_KEY=<from step 1>

# OAuth mode
GOOGLE_AUTH_MODE=oauth
GOOGLE_CLIENT_ID=<from step 2.2a>
GOOGLE_CLIENT_SECRET=<from step 2.2a>
GOOGLE_OWNER_EMAIL=you@example.com

# …or service account mode (instead of the four lines above)
# GOOGLE_AUTH_MODE=service_account
# GOOGLE_SERVICE_ACCOUNT_JSON=<base64 from step 2.2b>
```

The Docker image already sets `TRANSPORT=http`, `PORT=3000` and `DATA_DIR=/data`; don't override them. For optional settings (allowlists, `WRITE_TOOLSETS`, API keys, token lifetimes), see the [configuration reference](../README.md#configuration-reference).

Leave **"Build Variable"** unticked for all of these; they're only needed at runtime.

### 3.3 Deploy

Click **Deploy** and watch **Logs**. A healthy start ends with:

```
[gsa-mcp] HTTP server listening on 0.0.0.0:3000 — MCP endpoint https://mcp.example.com/mcp (readonly)
[gsa-mcp] Google is not connected yet: open https://mcp.example.com/setup
```

If the container exits immediately, the log line starts with `Configuration error:` and tells you exactly which variable is wrong.

---

## 4. Connect Google (oauth mode)

1. Open `https://mcp.example.com/setup` and sign in with `ADMIN_PASSWORD`.
2. Click **Connect Google**, then pick the account matching `GOOGLE_OWNER_EMAIL` and allow access.
3. You land back on `/setup`, which shows **Connected as you@example.com**.

In service-account mode, `/setup` shows the service account email instead and there's nothing to click.

---

## 5. Connect your AI apps

MCP URL: **`https://mcp.example.com/mcp`**

| App                               | Steps                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude** (web, desktop, mobile) | Settings → Connectors → **Add custom connector** → paste the URL → **Connect**.                                                         |
| **ChatGPT**                       | Settings → Apps & Connectors → Advanced → enable **Developer mode**. Then create a connector with the URL and authentication **OAuth**. |
| **Claude Code**                   | `claude mcp add --transport http google-search-analytics https://mcp.example.com/mcp`, then run `/mcp` in Claude Code to sign in.       |

Each one opens **your server's approval page**:

1. Check the app name and the return address shown on the page.
2. Tick **Make changes (write)** only if you want this app to be able to change things. The box appears only in `readwrite` mode.
3. Enter `ADMIN_PASSWORD` and click **Approve**.

You can review and revoke approved apps on `/setup` at any time.

---

## 6. Check it works

Ask your AI app:

> "List my Search Console sites and GA4 properties."

Then try:

> "Compare the last 28 days of organic search clicks for &lt;site&gt; with the previous period and show the biggest losing queries."

If you get an error, see [Troubleshooting](#troubleshooting).

---

## 7. Other hosts (plain Docker)

On any server with Docker and a domain:

```bash
git clone https://github.com/digifixau/google-search-analytics-mcp.git
cd google-search-analytics-mcp
cp .env.example .env        # fill in as in step 3.2
docker compose up -d --build
```

The container listens on port 3000. Put a TLS reverse proxy in front of it. With Caddy, for example:

```
mcp.example.com {
    reverse_proxy localhost:3000
}
```

Then continue from [step 4](#4-connect-google-oauth-mode).

---

## Day-2 operations

**Updating.** Push to `main` and Coolify redeploys. If you used the GitHub App, auto-deploy is on by default; otherwise click **Redeploy**. Data in `/data` survives.

**After an upgrade that adds a Google product (e.g. Tag Manager).** `/setup` lists the missing Google scopes. Enable the new API in Google Cloud (step 2.1), then click **Reconnect Google**. Until you do, the existing tools keep working and the new ones return a "reconnect Google" message. Don't want the new product? Set `ENABLED_SERVICES` to the ones you use (e.g. `gsc,ga4`).

**Tag Manager publishing.** In read-write mode the AI can publish GTM versions to your live site (it must type the `GTM-XXXX` ID back to confirm, and every publish is in the audit log). To allow editing but keep publishing for yourself, set `WRITE_TOOLSETS` without `gtm_publish`.

**Switching to read-write.** Set `ACCESS_MODE=readwrite`, optionally narrow `WRITE_TOOLSETS`, and redeploy. Then:

1. On `/setup`, click **Reconnect Google** so Google grants the extra scopes. The page shows which scopes are missing.
2. Reconnect each AI app that should be able to write, and tick **Make changes** this time. Existing connections stay read-only until you do.

**Switching back to read-only.** Set `ACCESS_MODE=readonly` and redeploy. Write tools disappear for every connection immediately.

**Backups.** Back up the `/data` volume; Coolify can schedule volume backups. Losing it only means reconnecting Google and re-approving your apps. Your Google data is never stored there.

**Rotating the admin password.** Change `ADMIN_PASSWORD` and redeploy. Existing connections keep working; the new password is needed for the next approval. To cut off every app at once, revoke them on `/setup`.

**Audit trail.** Every write attempt appears on `/setup` and in the container logs as `[audit] {...}`. Failed-login lockouts appear as `[security] ...`.

---

## Troubleshooting

| Symptom                                                   | Fix                                                                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container exits with `Configuration error: …`             | Fix the named variable. Common causes: `PUBLIC_URL` not https, `ADMIN_PASSWORD` under 16 characters, missing `GOOGLE_OWNER_EMAIL`.                                         |
| Google says `redirect_uri_mismatch`                       | The OAuth client's redirect URI must be exactly `https://<your domain>/oauth/google/callback`.                                                                             |
| "Signed in as …, but GOOGLE_OWNER_EMAIL is …"             | You picked a different Google account. Choose the owner account, or fix the variable.                                                                                      |
| "Google did not return a refresh token"                   | Remove the app at <https://myaccount.google.com/permissions> and click Connect Google again.                                                                               |
| Works for a week, then "refresh token revoked or expired" | The OAuth consent screen is still in _Testing_. Publish it (step 2.2a) and reconnect.                                                                                      |
| "A required Google API is disabled"                       | Enable the API named in the message (step 2.1), wait a minute, retry.                                                                                                      |
| 403 "did not grant the scope this tool needs"             | You switched to `readwrite` or changed `WRITE_TOOLSETS`. Click **Reconnect Google** on `/setup`.                                                                           |
| 403 "does not have sufficient permission"                 | The Google account or service account lacks access to that property in Search Console or GA4.                                                                              |
| Claude/ChatGPT can't connect or loops on login            | Check that `PUBLIC_URL` exactly matches the domain the app uses (no trailing path), and that `https://<domain>/.well-known/oauth-authorization-server` loads in a browser. |
| "Too many attempts" on the approval page                  | Brute-force lockout. Wait 15 minutes. The logs show `[security]` lines with the source IPs.                                                                                |
| Every redeploy asks to connect Google again               | The `/data` persistent volume is missing (step 3.1), or `ENCRYPTION_KEY` changed.                                                                                          |
| Write tools don't appear in the app                       | `ACCESS_MODE` is `readonly`, or that connection was approved without **Make changes**. Reconnect it and tick the box.                                                      |
