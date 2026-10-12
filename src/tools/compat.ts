import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolInputError } from '../util/errors.js';
import { markdownTable, pct, round } from '../util/output.js';
import { reportRows } from './ga4.js';
import { querySearchAnalytics } from './gsc.js';
import { defineTool } from './registry.js';

/**
 * `search` + `fetch` follow the shape ChatGPT expects for deep research / company knowledge connectors.
 * Documents are "gsc:<siteUrl>" and "ga4:<propertyId>"; fetching one returns a 28-day performance brief.
 */

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

const gscUrl = (site: string) =>
  `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(site)}`;
const ga4Url = (id: string) =>
  `https://analytics.google.com/analytics/web/#/p${id}/reports/intelligenthome`;

export const searchTool = defineTool({
  name: 'search',
  title: 'Search sites and properties',
  description:
    'Searches the Search Console sites and GA4 properties available on this server by name or URL. Returns document IDs to pass to fetch, which returns a 28-day performance brief.',
  access: 'read',
  toolset: 'compat',
  inputSchema: {
    query: z
      .string()
      .describe('Words to match against site URLs and property names. Empty returns everything.'),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text: string) =>
      terms.length === 0 || terms.some((t) => text.toLowerCase().includes(t));
    const results: Array<{ id: string; title: string; url: string }> = [];

    const enabled = ctx.config.enabledServices;
    const [sites, accounts] = await Promise.allSettled([
      enabled.includes('gsc')
        ? apis.searchconsole.sites.list()
        : Promise.reject(new Error('disabled')),
      enabled.includes('ga4')
        ? apis.analyticsAdmin.accountSummaries.list({ pageSize: 200 })
        : Promise.reject(new Error('disabled')),
    ]);
    if (sites.status === 'fulfilled') {
      for (const s of sites.value.data.siteEntry ?? []) {
        if (s.siteUrl && ctx.policy.siteAllowed(s.siteUrl) && matches(s.siteUrl)) {
          results.push({
            id: `gsc:${s.siteUrl}`,
            title: `Search Console: ${s.siteUrl}`,
            url: gscUrl(s.siteUrl),
          });
        }
      }
    }
    if (accounts.status === 'fulfilled') {
      for (const a of accounts.value.data.accountSummaries ?? []) {
        for (const p of a.propertySummaries ?? []) {
          const id = p.property?.replace('properties/', '');
          if (!id || !ctx.policy.propertyAllowed(id)) continue;
          if (matches(`${p.displayName} ${a.displayName} ${id}`)) {
            results.push({
              id: `ga4:${id}`,
              title: `GA4: ${p.displayName} (${a.displayName})`,
              url: ga4Url(id),
            });
          }
        }
      }
    }
    return json({ results });
  },
});

export const fetchTool = defineTool({
  name: 'fetch',
  title: 'Fetch performance brief',
  description:
    'Fetches a 28-day performance brief for a document ID returned by search ("gsc:<siteUrl>" or "ga4:<propertyId>").',
  access: 'read',
  toolset: 'compat',
  inputSchema: { id: z.string() },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    if (args.id.startsWith('gsc:')) {
      const siteUrl = args.id.slice(4);
      ctx.policy.assertSite(siteUrl);
      const range = { siteUrl, startDate: '30daysAgo', endDate: '3daysAgo' };
      const [total, queries, pages] = await Promise.all([
        querySearchAnalytics(apis, { ...range, dimensions: [], rowLimit: 1 }),
        querySearchAnalytics(apis, { ...range, dimensions: ['query'], rowLimit: 25 }),
        querySearchAnalytics(apis, { ...range, dimensions: ['page'], rowLimit: 25 }),
      ]);
      const t = total.rows[0];
      const fmt = (rows: typeof queries.rows, dim: string) =>
        markdownTable(
          rows.map((r) => ({
            [dim]: r.keys[0],
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: pct(r.ctr),
            position: round(r.position, 1),
          })),
        );
      const text = [
        `# Search Console brief: ${siteUrl} (last 28 complete days)`,
        t
          ? `Clicks ${t.clicks}, impressions ${t.impressions}, CTR ${pct(t.ctr)}, avg position ${round(t.position, 1)}.`
          : 'No data.',
        '## Top queries',
        fmt(queries.rows, 'query'),
        '## Top pages',
        fmt(pages.rows, 'page'),
      ].join('\n\n');
      return json({
        id: args.id,
        title: `Search Console: ${siteUrl}`,
        text,
        url: gscUrl(siteUrl),
        metadata: { source: 'gsc' },
      });
    }
    if (args.id.startsWith('ga4:')) {
      const id = ctx.policy.assertProperty(args.id.slice(4));
      const property = `properties/${id}`;
      const dateRanges = [{ startDate: '28daysAgo', endDate: 'yesterday' }];
      const run = (dimensions: string[], metrics: string[], limit: number) =>
        apis.analyticsData.properties.runReport({
          property,
          requestBody: {
            dateRanges,
            dimensions: dimensions.map((name) => ({ name })),
            metrics: metrics.map((name) => ({ name })),
            orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
            limit: String(limit),
          },
        });
      const [totals, channels, pages] = await Promise.all([
        run([], ['activeUsers', 'sessions', 'engagementRate', 'keyEvents', 'totalRevenue'], 1),
        run(
          ['sessionDefaultChannelGroup'],
          ['sessions', 'activeUsers', 'keyEvents', 'engagementRate'],
          15,
        ),
        run(['landingPagePlusQueryString'], ['sessions', 'keyEvents', 'engagementRate'], 25),
      ]);
      const text = [
        `# GA4 brief: property ${id} (last 28 days)`,
        markdownTable(reportRows(totals.data)),
        '## Channels',
        markdownTable(reportRows(channels.data)),
        '## Top landing pages',
        markdownTable(reportRows(pages.data)),
      ].join('\n\n');
      return json({
        id: args.id,
        title: `GA4 property ${id}`,
        text,
        url: ga4Url(id),
        metadata: { source: 'ga4' },
      });
    }
    throw new ToolInputError(
      'Unknown document id. Use an id returned by search, e.g. "gsc:sc-domain:example.com" or "ga4:123456".',
    );
  },
});

export const compatTools = [searchTool, fetchTool];
