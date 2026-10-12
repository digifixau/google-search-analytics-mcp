import type { Config, Service } from '../config.js';

/**
 * A connector is one MCP endpoint (one "server" from the AI app's point of view).
 * All connectors share the app, Google connection, OAuth server, access rules and audit log;
 * each exposes only the tools of its own services, keeping tool lists short.
 *
 * To add a new MCP (e.g. YouTube Analytics): add a service in config.ts, its scopes in
 * google/auth.ts, a client in google/clients.ts, tools in src/tools/, and an entry here.
 */
export interface ConnectorDef {
  id: string;
  /** URL path of the MCP endpoint. */
  path: string;
  /** MCP server name reported to clients. */
  serverName: string;
  /** Human-readable name (consent page, /setup, protected resource metadata). */
  title: string;
  services: Service[];
  /**
   * How this MCP reaches Google: a per-MCP Google account ('google': OAuth or service account), or a
   * server-side API key from the environment ('api_key': no sign-in, nothing to connect on /setup).
   */
  authKind: 'google' | 'api_key';
  /** Include the ChatGPT deep-research `search`/`fetch` tools. */
  includeCompat: boolean;
  instructions: string[];
}

const writeNote = {
  write:
    'This connection has WRITE access. Write tools change live Google configuration: confirm the exact change with the user before calling them.',
  readonlyServer: 'The server runs in READ-ONLY mode: no changes can be made.',
  readonlyGrant: 'This connection was granted read-only access: no changes can be made.',
};

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'search-analytics',
    path: '/mcp',
    serverName: 'google-search-analytics-mcp',
    title: 'Google Search Console & Analytics',
    services: ['gsc', 'ga4'],
    authKind: 'google',
    includeCompat: true,
    instructions: [
      'Google Search Console (GSC) and Google Analytics 4 (GA4) data for the owner of this server.',
      'Start with gsc_list_sites or ga4_list_properties to discover the exact siteUrl / propertyId values.',
      'GSC siteUrl is either a URL-prefix property ("https://example.com/") or a domain property ("sc-domain:example.com").',
      'GSC data lags ~2-3 days; GA4 supports relative dates like "28daysAgo", "yesterday", "today".',
      'For GA4, call ga4_get_metadata to find valid dimension/metric API names (including custom definitions).',
    ],
  },
  {
    id: 'gtm',
    path: '/mcp/gtm',
    serverName: 'google-tag-manager-mcp',
    title: 'Google Tag Manager',
    services: ['gtm'],
    authKind: 'google',
    includeCompat: false,
    instructions: [
      'Google Tag Manager (GTM) containers for the owner of this server.',
      'Start with gtm_list_containers; gtm_audit_container gives a quick health check.',
      'Edits happen in a workspace, gtm_create_version snapshots it, and gtm_publish_version makes it live on the website.',
    ],
  },
  {
    id: 'youtube',
    path: '/mcp/youtube',
    serverName: 'youtube-analytics-mcp',
    title: 'YouTube Analytics',
    services: ['youtube'],
    authKind: 'google',
    includeCompat: false,
    instructions: [
      'YouTube channel and video analytics for the owner of this server.',
      'Start with yt_list_channels to get channel IDs, and yt_list_videos for video IDs.',
      'yt_report runs any YouTube Analytics query; the focused tools (top videos, traffic sources, audience, retention, revenue) cover common questions.',
      'Dates accept YYYY-MM-DD or "28daysAgo"/"yesterday"; YouTube Analytics data is usually 2-3 days behind.',
    ],
  },
  {
    id: 'merchant',
    path: '/mcp/merchant',
    serverName: 'google-merchant-center-mcp',
    title: 'Google Merchant Center',
    services: ['merchant'],
    authKind: 'google',
    includeCompat: false,
    instructions: [
      'Google Merchant Center (shopping feeds) for the owner of this server.',
      'Start with merchant_list_accounts. merchant_account_issues and merchant_product_issues explain disapprovals; merchant_performance_report shows clicks and impressions from free and paid listings.',
      'If calls fail with "not registered", the Google Cloud project must be registered once per account (merchant_register_gcp_project).',
    ],
  },
  {
    id: 'places',
    path: '/mcp/places',
    serverName: 'google-places-mcp',
    title: 'Google Places',
    services: ['places'],
    authKind: 'api_key',
    includeCompat: false,
    instructions: [
      'Google Places (businesses, addresses, ratings, reviews and photos). Read-only.',
      'Use places_search_text for "what is there / who ranks for X in Y" questions and places_search_nearby around a point; both return place IDs for places_get_place, places_get_reviews and places_get_photo.',
      'Every call is billed by Google. The detail level (basic, standard, full) decides which fields are requested, so start with the smallest level that answers the question.',
    ],
  },
];

export function connectorInstructions(
  connector: ConnectorDef,
  config: Config,
  canWrite: boolean,
): string {
  const tail = canWrite
    ? writeNote.write
    : config.accessMode === 'readonly'
      ? writeNote.readonlyServer
      : writeNote.readonlyGrant;
  return [...connector.instructions, tail].join('\n');
}

/** Connectors with at least one enabled service. */
export function enabledConnectors(config: Config): ConnectorDef[] {
  return CONNECTORS.filter((c) => c.services.some((s) => config.enabledServices.includes(s)));
}

export function getConnector(id: string): ConnectorDef {
  const connector = CONNECTORS.find((c) => c.id === id);
  if (!connector) {
    throw new Error(
      `Unknown MCP connector "${id}". Valid: ${CONNECTORS.map((c) => c.id).join(', ')}`,
    );
  }
  return connector;
}

export function connectorUrl(connector: ConnectorDef, publicUrl: URL): URL {
  return new URL(connector.path, publicUrl);
}

/** Normalises a resource URL for comparison (no fragment, no trailing slash). */
export function comparableResource(value: URL | string): string {
  const url = new URL(String(value));
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

/** Finds the connector a resource URL (RFC 8707 `resource`) refers to. */
export function connectorForResource(
  resource: URL | string | undefined,
  config: Config,
): ConnectorDef | undefined {
  if (!resource || !config.publicUrl) return undefined;
  const target = comparableResource(resource);
  return enabledConnectors(config).find(
    (c) => comparableResource(connectorUrl(c, config.publicUrl!)) === target,
  );
}
