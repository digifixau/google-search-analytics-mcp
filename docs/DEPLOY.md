# Deploy guide

This guide takes you from nothing to a running server that Claude and ChatGPT can connect to. It takes about 30 minutes.

The main path uses **Coolify**. If you use another host, [section 7](#7-other-hosts-plain-docker) covers plain Docker.

**What you'll end up with**

```
Claude / ChatGPT ──HTTPS──▶ https://mcp.example.com/mcp      ──▶ Google Search Console + GA4
                 ├─HTTPS──▶ https://mcp.example.com/mcp/gtm      ──▶ Google Tag Manager
                 ├─HTTPS──▶ https://mcp.example.com/mcp/youtube  ──▶ YouTube Analytics
                 ├─HTTPS──▶ https://mcp.example.com/mcp/merchant ──▶ Google Merchant Center
                 └─HTTPS──▶ https://mcp.example.com/mcp/places   ──▶ Google Places
                             (your Coolify server)          (as your Google account(s); Places uses an API key)
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
- YouTube Analytics API and YouTube Data API v3
- Merchant API
- Places API (New), and billing must be enabled on the project (Places is billed per call)
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
   - **Merchant Center** → Settings → People and access → add the email with **Standard** access (Admin is needed once for `merchant_register_gcp_project`).
   - **YouTube** doesn't support service accounts. Use OAuth mode if you need the YouTube MCP, or set `ENABLED_SERVICES` without `youtube`.
3. Encode the key for the env var: `base64 -w0 key.json` (macOS: `base64 -i key.json`).

### 2.3 Places API key (only for the Places MCP)

Places doesn't use a Google sign-in or service account. It uses an API key that stays on your server.

1. **APIs & Services → Credentials → Create credentials → API key**.
2. Open the key and restrict it:
   - **API restrictions → Restrict key → Places API (New)** only.
   - **Application restrictions → IP addresses**, if your server has a fixed outbound IP (leave as _None_ otherwise; HTTP-referrer restrictions don't work for a server).
3. Copy the key for step 3.2 (`GOOGLE_PLACES_API_KEY`).
4. To cap spending, open **APIs & Services → Places API (New) → Quotas & System Limits** and lower the daily request limits, and add a budget alert under **Billing → Budgets & alerts**.

Skip this step if you don't want the Places MCP (set `ENABLED_SERVICES` without `places`, or just leave the key unset: the Places card then says "API key missing" and the other MCPs are unaffected).

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

This volume holds the SQLite database: the encrypted Google tokens (one per MCP), connected clients and the audit log. Without it, every redeploy loses your Google connections and all client approvals.

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
# Optional: a different Google account for one MCP (replaces GOOGLE_OWNER_EMAIL for it)
# GOOGLE_OWNER_EMAIL_GTM=tags@client.com
# GOOGLE_OWNER_EMAIL_YOUTUBE=brand@example.com
# GOOGLE_OWNER_EMAIL_MERCHANT=shop@client.com
# GOOGLE_OWNER_EMAIL_SEARCH_ANALYTICS=seo@example.com

# Places MCP (API key from step 2.3)
GOOGLE_PLACES_API_KEY=<from step 2.3>

# …or service account mode (instead of the four lines above)
# GOOGLE_AUTH_MODE=service_account
# GOOGLE_SERVICE_ACCOUNT_JSON=<base64 from step 2.2b>
```

The Docker image already sets `TRANSPORT=http`, `PORT=3000` and `DATA_DIR=/data`; don't override them. For optional settings (allowlists, `WRITE_TOOLSETS`, API keys, token lifetimes), see the [configuration reference](../README.md#configuration-reference).

Leave **"Build Variable"** unticked for all of these; they're only needed at runtime.

### 3.3 Deploy

Click **Deploy** and watch **Logs**. A healthy start ends with:

```
[gsa-mcp] HTTP server listening on 0.0.0.0:3000 (readonly)
[gsa-mcp]   Google Search Console & Analytics MCP: https://mcp.example.com/mcp — Google NOT connected
[gsa-mcp]   Google Tag Manager MCP: https://mcp.example.com/mcp/gtm — Google NOT connected
[gsa-mcp]   YouTube Analytics MCP: https://mcp.example.com/mcp/youtube — Google NOT connected
[gsa-mcp]   Google Merchant Center MCP: https://mcp.example.com/mcp/merchant — Google NOT connected
[gsa-mcp]   Google Places MCP: https://mcp.example.com/mcp/places — API key configured
[gsa-mcp] Connect Google accounts at https://mcp.example.com/setup
```

If the container exits immediately, the log line starts with `Configuration error:` and tells you exactly which variable is wrong.

---

## 4. Connect Google (oauth mode)

Each MCP has its own Google connection, so each can use a different Google account.

1. Open `https://mcp.example.com/setup` and sign in with `ADMIN_PASSWORD`. You see one card per MCP: Search Console & Analytics, Tag Manager, YouTube and Merchant Center.
2. On a card, click **Connect**. Pick an account allowed for that MCP (`GOOGLE_OWNER_EMAIL`, or that MCP's `GOOGLE_OWNER_EMAIL_<MCP>`) and allow access. Google only asks for that MCP's permissions.
3. You land back on `/setup`, where that card shows **Connected as …**. The other cards are unchanged.
4. Repeat for every MCP you use. Using the same account for several MCPs is fine; each still keeps its own token.

Each card also has **Reconnect** (switch account or grant new permissions) and **Disconnect**. Disconnect only removes that MCP's stored token. It doesn't revoke access at Google, because that would also break other MCPs on the same account. To revoke completely, remove the app at <https://myaccount.google.com/permissions>, which affects **every** MCP connected with that account.

The **Google Places** card has nothing to connect. It says **API key configured** or **API key missing** (set `GOOGLE_PLACES_API_KEY` in step 3.2 and redeploy).

In service-account mode, each card shows the service account email instead and there's nothing to click. `GOOGLE_SERVICE_ACCOUNT_JSON_<MCP>` gives one MCP its own service account.

---

## 5. Connect your AI apps

The app serves several MCPs. Add **each one you want as a separate connector**:

| MCP                               | URL                                    |
| --------------------------------- | -------------------------------------- |
| Google Search Console & Analytics | `https://mcp.example.com/mcp`          |
| Google Tag Manager                | `https://mcp.example.com/mcp/gtm`      |
| YouTube Analytics                 | `https://mcp.example.com/mcp/youtube`  |
| Google Merchant Center            | `https://mcp.example.com/mcp/merchant` |
| Google Places                     | `https://mcp.example.com/mcp/places`   |

| App                               | Steps                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude** (web, desktop, mobile) | Settings → Connectors → **Add custom connector** → paste the URL → **Connect**.                                                                                        |
| **ChatGPT**                       | Settings → Apps & Connectors → Advanced → enable **Developer mode**. Then create a connector with the URL and authentication **OAuth**.                                |
| **Claude Code**                   | `claude mcp add --transport http google-search-analytics https://mcp.example.com/mcp` (and `google-tag-manager …/mcp/gtm`), then run `/mcp` in Claude Code to sign in. |

Each one opens **your server's approval page**:

1. Check the app name and the return address shown on the page.
2. Tick **Make changes (write)** only if you want this app to be able to change things. The box appears only in `readwrite` mode.
3. Enter `ADMIN_PASSWORD` and click **Approve**.

Repeat for each MCP. Every connector is approved on its own, so read/write can differ per MCP (e.g. GTM read-only, Search Console & Analytics read+write). You can review and revoke approved apps on `/setup` at any time; the table shows which MCP each one uses.

---

### 5.1 One-time setup per product

- **YouTube:** when you click **Connect** on the YouTube card, Google asks which channel to use if your account manages several (personal or Brand Account). The YouTube MCP sees that channel. To switch, click **Reconnect** on that card and pick the other one.
- **Merchant Center:** Google requires the Cloud project to be registered with each Merchant Center account before the API answers. Connect the Merchant MCP with **Make changes** ticked (read-write mode), then ask the AI:

  > "Register this server's Google Cloud project with Merchant Center account 123456789 using developer email you@example.com."

  This runs `merchant_register_gcp_project` once. Afterwards the connection can be read-only if you prefer.

- **Places:** nothing to connect on `/setup`. Places is read-only and every request is billed by Google, so keep the quota cap from step 2.3 in place. Google gives each billed item its own free monthly allowance (about 1,000 free for the detail-rich search and photo items, 5,000 for the cheapest search item; check Google's pricing page, as prices change). The cheapest way to research several places is **one search with detail "full"** (details and photo references for every result in one request; add `includeReviews` for reviews), then fetch only the photos you need. For example, 10 runs a day of "5 places in a suburb, with details and 1 photo each" is about 300 searches (inside the free allowance) plus 1,500 photos (1,000 free), roughly $3.50 a month. Doing a search and then a details call per place costs roughly $16 a month, and about $54 if you also fetch reviews per place.

## 6. Check it works

Ask your AI app:

> "List my Search Console sites and GA4 properties."

Then try:

> "Which of my Merchant Center products are disapproved, and why?" (Merchant MCP)
>
> "Find the 10 best-rated fridge repair businesses in Melbourne and give me their websites and phone numbers." (Places MCP)
>
> "What were my top 10 YouTube videos by watch time last month, and where did their traffic come from?" (YouTube MCP)
>
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

**After an upgrade that adds a Google product (e.g. Tag Manager).** The new MCP's card on `/setup` lists its missing Google scopes. Enable the new API in Google Cloud (step 2.1), then click **Reconnect** on that card. Until you do, the other MCPs keep working and the new one returns a "reconnect" message. Don't want the new product? Set `ENABLED_SERVICES` to the ones you use (e.g. `gsc,ga4`).

**Tag Manager publishing.** In read-write mode the AI can publish GTM versions to your live site (it must type the `GTM-XXXX` ID back to confirm, and every publish is in the audit log). To allow editing but keep publishing for yourself, set `WRITE_TOOLSETS` without `gtm_publish`.

**Switching to read-write.** Set `ACCESS_MODE=readwrite`, optionally narrow `WRITE_TOOLSETS`, and redeploy. Then:

1. On `/setup`, click **Reconnect** on each MCP card that shows missing scopes, so Google grants the extra scopes.
2. Reconnect each AI app that should be able to write, and tick **Make changes** this time. Existing connections stay read-only until you do.

**Switching back to read-only.** Set `ACCESS_MODE=readonly` and redeploy. Write tools disappear for every connection immediately.

**Backups.** Back up the `/data` volume; Coolify can schedule volume backups. Losing it only means reconnecting Google on each card and re-approving your apps. Your Google data is never stored there.

**Rotating the admin password.** Change `ADMIN_PASSWORD` and redeploy. Existing connections keep working; the new password is needed for the next approval. To cut off every app at once, revoke them on `/setup`.

### Upgrading to one Google account per MCP

Versions before this one had a single Google connection shared by every MCP. Upgrading is automatic and keeps everything working:

1. **Before deploying**, make sure `GOOGLE_OWNER_EMAIL` lists every account you plan to use (comma separated), or add `GOOGLE_OWNER_EMAIL_<MCP>` for the MCPs that should use a different account. One address still works exactly as before.
2. Deploy. On first start the log shows `[google] migrated the shared Google connection to: search-analytics, gtm, youtube, merchant`. The old connection is **copied** to every MCP, so all tools keep working immediately with the same account. Each card says "Using the shared Google connection from before the upgrade".
3. When you're ready, click **Reconnect** on any card to move that MCP to another account. The other MCPs are not affected.

An MCP you pin with `GOOGLE_OWNER_EMAIL_<MCP>` to accounts that don't include the old one is **not** given the old connection. The log says `[google] not migrated …`, and you connect it on its card.

What the migration does **not** do: it never deletes, rewrites or revokes the original connection (stored under the `google.oauth` key). It never overwrites an MCP that already has its own connection. It never re-imports into an MCP you disconnected. Running it again is a no-op.

**Rolling back.** Redeploy the previous image (in Coolify: **Deployments → pick the earlier deployment → Redeploy**, or point the app at the previous commit). There is no database migration to undo. The old version reads the untouched original connection and works as before. Connections you made per MCP after the upgrade are ignored by the old version, and come back if you upgrade again. Two caveats:

- The old version expects a single address in `GOOGLE_OWNER_EMAIL`. Set it back to one address before rolling back, and remove the `GOOGLE_OWNER_EMAIL_<MCP>` lines (the old version ignores them anyway).
- If you removed the app at <https://myaccount.google.com/permissions> for the original account in the meantime, the original connection is revoked too. After rolling back, click **Reconnect Google** once.

**Audit trail.** Every write attempt appears on `/setup` and in the container logs as `[audit] {...}`. Failed-login lockouts appear as `[security] ...`.

---

## Troubleshooting

| Symptom                                                          | Fix                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Places tools say "no API key" or the card says "API key missing" | Set `GOOGLE_PLACES_API_KEY` (step 2.3) in Coolify and redeploy.                                                                                                                                                                                                   |
| Places: "Google rejected the Places API key"                     | The key is wrong, deleted or expired. Create a new one (step 2.3) and update `GOOGLE_PLACES_API_KEY`.                                                                                                                                                             |
| Places: "key's restrictions block this server"                   | In Google Cloud, set the key's API restriction to _Places API (New)_ and its application restriction to _None_ or your server's outbound IP.                                                                                                                      |
| Places: "Places API (New) has not been used" or "billing"        | Enable **Places API (New)** and billing on the Cloud project (step 2.1), wait a minute, retry.                                                                                                                                                                    |
| Merchant tools say "not registered"                              | Run `merchant_register_gcp_project` once per Merchant Center account (section 5.1).                                                                                                                                                                               |
| YouTube shows the wrong channel, or "No YouTube channel found"   | Click **Reconnect** on the YouTube card and choose the channel (or Brand Account) at Google's prompt.                                                                                                                                                             |
| Container exits with `Configuration error: …`                    | Fix the named variable. Common causes: `PUBLIC_URL` not https, `ADMIN_PASSWORD` under 16 characters, missing `GOOGLE_OWNER_EMAIL`, an MCP left without an allowed account (`GOOGLE_OWNER_EMAIL_<MCP>` for: …), or a misspelled `GOOGLE_OWNER_EMAIL_<MCP>` suffix. |
| Google says `redirect_uri_mismatch`                              | The OAuth client's redirect URI must be exactly `https://<your domain>/oauth/google/callback`.                                                                                                                                                                    |
| "Signed in as …, which is not allowed for the … MCP"             | You picked an account not listed for that MCP. Choose an allowed account, or add it to `GOOGLE_OWNER_EMAIL` / `GOOGLE_OWNER_EMAIL_<MCP>` and redeploy.                                                                                                            |
| "The … MCP has no Google account connected yet"                  | Click **Connect** on that MCP's card on `/setup`. Each MCP is connected separately.                                                                                                                                                                               |
| "Finish the Google sign-in in the same browser session…"         | Start the connection from `/setup` and finish it in the same browser, within 10 minutes. Don't reuse an old Google tab.                                                                                                                                           |
| Disconnected one MCP but the account still shows at Google       | Expected: Disconnect only deletes this server's token for that MCP. Revoke at <https://myaccount.google.com/permissions> (affects every MCP on that account).                                                                                                     |
| "Google did not return a refresh token"                          | Remove the app at <https://myaccount.google.com/permissions> and click **Connect** on the card again (then reconnect other MCPs that used that account).                                                                                                          |
| "Google rejected this MCP's stored refresh token"                | That MCP's token was revoked or expired. Click **Reconnect** on its card. If the consent screen is still in _Testing_, publish it (step 2.2a) first, or this repeats weekly.                                                                                      |
| "A required Google API is disabled"                              | Enable the API named in the message (step 2.1), wait a minute, retry.                                                                                                                                                                                             |
| 403 "did not grant the scope this tool needs"                    | You switched to `readwrite` or changed `WRITE_TOOLSETS`. Click **Reconnect** on that MCP's card on `/setup`.                                                                                                                                                      |
| 403 "does not have sufficient permission"                        | The Google account or service account lacks access to that property in Search Console or GA4.                                                                                                                                                                     |
| Claude/ChatGPT can't connect or loops on login                   | Check that `PUBLIC_URL` exactly matches the domain the app uses (no trailing path), and that `https://<domain>/.well-known/oauth-authorization-server` loads in a browser.                                                                                        |
| "Too many attempts" on the approval page                         | Brute-force lockout. Wait 15 minutes. The logs show `[security]` lines with the source IPs.                                                                                                                                                                       |
| Every redeploy asks to connect Google again                      | The `/data` persistent volume is missing (step 3.1), or `ENCRYPTION_KEY` changed.                                                                                                                                                                                 |
| Write tools don't appear in the app                              | `ACCESS_MODE` is `readonly`, or that connection was approved without **Make changes**. Reconnect it and tick the box.                                                                                                                                             |
