import { z } from 'zod';
import type { searchconsole_v1 } from 'googleapis';
import type { GoogleApis } from '../google/clients.js';
import { DATE_HELP, isValidDateExpression, previousPeriod, resolveDate } from '../util/dates.js';
import { jsonResult, pct, round, tableResult, type Row } from '../util/output.js';
import type { AccessPolicy } from '../util/policy.js';
import { defineTool } from './registry.js';

export const siteUrlSchema = z
  .string()
  .min(1)
  .describe(
    'Search Console property exactly as listed by gsc_list_sites, e.g. "https://www.example.com/" or "sc-domain:example.com".',
  );

const dateExpr = (fallback: string, what: string) =>
  z
    .string()
    .default(fallback)
    .refine(isValidDateExpression, { message: `Use ${DATE_HELP}` })
    .describe(`${what}: ${DATE_HELP}. Default "${fallback}".`);

const DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'date',
  'searchAppearance',
  'hour',
] as const;
const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;

const filterSchema = z.object({
  dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
  operator: z
    .enum(['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'])
    .default('equals'),
  expression: z
    .string()
    .describe(
      'Value to match. Country uses ISO 3166-1 alpha-3 (e.g. "aus"); device is DESKTOP, MOBILE or TABLET.',
    ),
});

const filtersSchema = z
  .array(filterSchema)
  .max(20)
  .optional()
  .describe('Dimension filters, combined with AND. Regex uses RE2 syntax.');

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQuery {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: string[];
  filters?: z.infer<typeof filterSchema>[];
  type?: string;
  dataState?: string;
  aggregationType?: string;
  rowLimit?: number;
  startRow?: number;
}

export async function querySearchAnalytics(
  apis: GoogleApis,
  q: GscQuery,
): Promise<{
  rows: GscRow[];
  responseAggregationType?: string | null;
  metadata?: searchconsole_v1.Schema$Metadata;
}> {
  const requestBody: searchconsole_v1.Schema$SearchAnalyticsQueryRequest = {
    startDate: resolveDate(q.startDate),
    endDate: resolveDate(q.endDate),
    dimensions: q.dimensions,
    type: q.type,
    dataState: q.dataState,
    aggregationType: q.aggregationType,
    rowLimit: q.rowLimit,
    startRow: q.startRow,
  };
  if (q.filters?.length) {
    requestBody.dimensionFilterGroups = [{ groupType: 'and', filters: q.filters }];
  }
  const res = await apis.searchconsole.searchanalytics.query({ siteUrl: q.siteUrl, requestBody });
  const rows = (res.data.rows ?? []).map((r) => ({
    keys: r.keys ?? [],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
  return {
    rows,
    responseAggregationType: res.data.responseAggregationType,
    metadata: res.data.metadata,
  };
}

function formatRows(rows: GscRow[], dimensions: string[]): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    dimensions.forEach((d, i) => (out[d] = r.keys[i]));
    out.clicks = r.clicks;
    out.impressions = r.impressions;
    out.ctr = pct(r.ctr);
    out.position = round(r.position, 1);
    return out;
  });
}

async function totals(apis: GoogleApis, q: GscQuery): Promise<GscRow> {
  const { rows } = await querySearchAnalytics(apis, {
    ...q,
    dimensions: [],
    rowLimit: 1,
    startRow: 0,
  });
  return rows[0] ?? { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

function filterSites(policy: AccessPolicy, entries: searchconsole_v1.Schema$WmxSite[]) {
  return entries.filter((s) => s.siteUrl && policy.siteAllowed(s.siteUrl));
}

export const gscListSites = defineTool({
  name: 'gsc_list_sites',
  title: 'List Search Console properties',
  description:
    'Lists the Google Search Console properties (sites) this server can access, with permission level. Use the returned siteUrl values in other gsc_* tools.',
  access: 'read',
  toolset: 'gsc',
  inputSchema: {},
  handler: async (_args, ctx) => {
    const apis = await ctx.apis();
    const res = await apis.searchconsole.sites.list();
    const sites = filterSites(ctx.policy, res.data.siteEntry ?? []);
    return tableResult(
      `Search Console properties (${sites.length})`,
      sites.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel })),
    );
  },
});

export const gscSearchAnalytics = defineTool({
  name: 'gsc_search_analytics',
  title: 'Search Console performance report',
  description:
    'Queries Search Console search analytics (clicks, impressions, CTR, average position) grouped by any of query, page, country, device, date, searchAppearance or hour. Rows are sorted by clicks descending. Supports filters, search type (web, image, video, news, discover, googleNews) and pagination up to 25,000 rows per call.',
  access: 'read',
  toolset: 'gsc',
  inputSchema: {
    siteUrl: siteUrlSchema,
    startDate: dateExpr('30daysAgo', 'Start date'),
    endDate: dateExpr('3daysAgo', 'End date (GSC data is usually complete up to 3 days ago)'),
    dimensions: z
      .array(z.enum(DIMENSIONS))
      .max(5)
      .default(['query'])
      .describe('Group-by dimensions. [] returns site totals.'),
    filters: filtersSchema,
    type: z.enum(SEARCH_TYPES).default('web'),
    dataState: z
      .enum(['final', 'all', 'hourly_all'])
      .default('final')
      .describe(
        '"all" includes fresh (incomplete) data; "hourly_all" is required with the hour dimension.',
      ),
    aggregationType: z
      .enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'])
      .default('auto'),
    rowLimit: z.number().int().min(1).max(25000).default(100),
    startRow: z.number().int().min(0).default(0).describe('Offset for pagination.'),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl);
    const apis = await ctx.apis();
    const { rows, responseAggregationType, metadata } = await querySearchAnalytics(apis, args);
    const notes = [
      `Range ${resolveDate(args.startDate)} → ${resolveDate(args.endDate)}, type ${args.type}, aggregation ${responseAggregationType ?? args.aggregationType}.`,
    ];
    if (rows.length === args.rowLimit) {
      notes.push(
        `Row limit reached; call again with startRow=${args.startRow + args.rowLimit} for more.`,
      );
    }
    if (metadata?.firstIncompleteDate)
      notes.push(`Data from ${metadata.firstIncompleteDate} is incomplete.`);
    return tableResult(
      `Search analytics for ${args.siteUrl} — ${rows.length} rows`,
      formatRows(rows, args.dimensions),
      { notes },
    );
  },
});

export const gscComparePeriods = defineTool({
  name: 'gsc_compare_periods',
  title: 'Compare Search Console periods',
  description:
    'Compares two date ranges (default: last 28 complete days vs the 28 days before) for a site, returning totals and the biggest winners/losers by query, page, country or device. Ideal for "what changed?" questions and traffic drop analysis.',
  access: 'read',
  toolset: 'gsc',
  inputSchema: {
    siteUrl: siteUrlSchema,
    startDate: dateExpr('30daysAgo', 'Current period start'),
    endDate: dateExpr('3daysAgo', 'Current period end'),
    previousStartDate: z
      .string()
      .optional()
      .describe('Previous period start (default: same-length period immediately before).'),
    previousEndDate: z.string().optional().describe('Previous period end.'),
    dimension: z.enum(['query', 'page', 'country', 'device']).default('query'),
    filters: filtersSchema,
    type: z.enum(SEARCH_TYPES).default('web'),
    sortBy: z
      .enum(['clicks_change', 'impressions_change', 'position_change'])
      .default('clicks_change')
      .describe('Rank rows by absolute change in this metric.'),
    limit: z.number().int().min(1).max(500).default(50),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl);
    const apis = await ctx.apis();
    const current = { startDate: resolveDate(args.startDate), endDate: resolveDate(args.endDate) };
    const previous =
      args.previousStartDate && args.previousEndDate
        ? {
            startDate: resolveDate(args.previousStartDate),
            endDate: resolveDate(args.previousEndDate),
          }
        : previousPeriod(current.startDate, current.endDate);
    const base = { siteUrl: args.siteUrl, filters: args.filters, type: args.type };
    const [curTotals, prevTotals, cur, prev] = await Promise.all([
      totals(apis, { ...base, ...current }),
      totals(apis, { ...base, ...previous }),
      querySearchAnalytics(apis, {
        ...base,
        ...current,
        dimensions: [args.dimension],
        rowLimit: 5000,
      }),
      querySearchAnalytics(apis, {
        ...base,
        ...previous,
        dimensions: [args.dimension],
        rowLimit: 5000,
      }),
    ]);

    const empty: GscRow = { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const prevMap = new Map(prev.rows.map((r) => [r.keys[0], r]));
    const keys = new Set([...cur.rows.map((r) => r.keys[0]), ...prev.rows.map((r) => r.keys[0])]);
    const curMap = new Map(cur.rows.map((r) => [r.keys[0], r]));
    const diffs = [...keys].map((key) => {
      const c = curMap.get(key) ?? empty;
      const p = prevMap.get(key) ?? empty;
      return {
        key,
        c,
        p,
        clicks_change: c.clicks - p.clicks,
        impressions_change: c.impressions - p.impressions,
        // Positive = improved (moved up). Only meaningful when present in both periods.
        position_change: c.position && p.position ? p.position - c.position : 0,
      };
    });
    diffs.sort((a, b) => Math.abs(b[args.sortBy]) - Math.abs(a[args.sortBy]));

    const rows = diffs.slice(0, args.limit).map((d) => ({
      [args.dimension]: d.key,
      clicks: d.c.clicks,
      clicks_prev: d.p.clicks,
      clicks_change: d.clicks_change,
      impressions: d.c.impressions,
      impressions_prev: d.p.impressions,
      position: d.c.position ? round(d.c.position, 1) : '',
      position_prev: d.p.position ? round(d.p.position, 1) : '',
      position_change: round(d.position_change, 1),
    }));

    const change = (a: number, b: number) =>
      b === 0 ? 'n/a' : `${round(((a - b) / b) * 100, 1)}%`;
    const summary = [
      `Current ${current.startDate} → ${current.endDate} vs previous ${previous.startDate} → ${previous.endDate}`,
      `Clicks: ${curTotals.clicks} vs ${prevTotals.clicks} (${change(curTotals.clicks, prevTotals.clicks)})`,
      `Impressions: ${curTotals.impressions} vs ${prevTotals.impressions} (${change(curTotals.impressions, prevTotals.impressions)})`,
      `CTR: ${pct(curTotals.ctr)} vs ${pct(prevTotals.ctr)}`,
      `Avg position: ${round(curTotals.position, 1)} vs ${round(prevTotals.position, 1)} (positive position_change = moved up)`,
    ];
    return tableResult(
      `Period comparison for ${args.siteUrl} by ${args.dimension}\n\n${summary.join('\n')}`,
      rows,
    );
  },
});

/** Rough organic CTR by position, used only to estimate upside. */
const CTR_CURVE = [0, 0.28, 0.16, 0.11, 0.08, 0.06, 0.05, 0.04, 0.035, 0.03, 0.025];

export const gscOpportunities = defineTool({
  name: 'gsc_opportunities',
  title: 'Find Search Console quick wins',
  description:
    'Finds "striking distance" opportunities: queries or pages ranking in positions 4-20 (configurable) with high impressions, ranked by estimated extra clicks if they reached a target position. Great for prioritising content and on-page SEO work.',
  access: 'read',
  toolset: 'gsc',
  inputSchema: {
    siteUrl: siteUrlSchema,
    startDate: dateExpr('30daysAgo', 'Start date'),
    endDate: dateExpr('3daysAgo', 'End date'),
    dimension: z.enum(['query', 'page']).default('query'),
    filters: filtersSchema,
    minImpressions: z.number().int().min(0).default(100),
    minPosition: z.number().min(1).default(4),
    maxPosition: z.number().min(1).default(20),
    targetPosition: z.number().int().min(1).max(10).default(3),
    limit: z.number().int().min(1).max(500).default(50),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl);
    const apis = await ctx.apis();
    const { rows } = await querySearchAnalytics(apis, {
      siteUrl: args.siteUrl,
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: [args.dimension],
      filters: args.filters,
      rowLimit: 25000,
    });
    const targetCtr = CTR_CURVE[args.targetPosition] ?? 0.1;
    const opportunities = rows
      .filter(
        (r) =>
          r.impressions >= args.minImpressions &&
          r.position >= args.minPosition &&
          r.position <= args.maxPosition,
      )
      .map((r) => ({ r, upside: Math.max(0, Math.round(r.impressions * (targetCtr - r.ctr))) }))
      .sort((a, b) => b.upside - a.upside)
      .slice(0, args.limit)
      .map(({ r, upside }) => ({
        [args.dimension]: r.keys[0],
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: pct(r.ctr),
        position: round(r.position, 1),
        est_extra_clicks: upside,
      }));
    return tableResult(
      `Opportunities for ${args.siteUrl}: ${opportunities.length} ${args.dimension}s in positions ${args.minPosition}-${args.maxPosition}`,
      opportunities,
      {
        notes: [
          `est_extra_clicks assumes reaching position ${args.targetPosition} (~${pct(targetCtr, 0)} CTR); it is a directional estimate, not a forecast.`,
        ],
      },
    );
  },
});

export const gscListSitemaps = defineTool({
  name: 'gsc_list_sitemaps',
  title: 'List sitemaps',
  description:
    'Lists sitemaps submitted for a Search Console property with status, errors, warnings and indexed counts.',
  access: 'read',
  toolset: 'gsc',
  inputSchema: { siteUrl: siteUrlSchema },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl);
    const apis = await ctx.apis();
    const res = await apis.searchconsole.sitemaps.list({ siteUrl: args.siteUrl });
    const rows = (res.data.sitemap ?? []).map((s) => ({
      path: s.path,
      type: s.type,
      lastSubmitted: s.lastSubmitted,
      lastDownloaded: s.lastDownloaded,
      isPending: s.isPending,
      errors: s.errors,
      warnings: s.warnings,
      submitted: s.contents?.map((c) => `${c.type}:${c.submitted}`).join(', '),
    }));
    return tableResult(`Sitemaps for ${args.siteUrl} (${rows.length})`, rows);
  },
});

export const gscGetSitemap = defineTool({
  name: 'gsc_get_sitemap',
  title: 'Get sitemap details',
  description: 'Returns full details for one submitted sitemap.',
  access: 'read',
  toolset: 'gsc',
  inputSchema: {
    siteUrl: siteUrlSchema,
    feedpath: z
      .string()
      .url()
      .describe('Full sitemap URL, e.g. https://www.example.com/sitemap.xml'),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl);
    const apis = await ctx.apis();
    const res = await apis.searchconsole.sitemaps.get({
      siteUrl: args.siteUrl,
      feedpath: args.feedpath,
    });
    return jsonResult(`Sitemap ${args.feedpath}`, res.data);
  },
});

export const gscInspectUrl = defineTool({
  name: 'gsc_inspect_url',
  title: 'Inspect URL in Google index',
  description:
    'Runs the URL Inspection API for a page: index verdict, coverage state, last crawl, canonical (Google vs user), robots.txt, rich results and mobile usability. Quota ~2,000/day per property.',
  access: 'read',
  toolset: 'gsc',
  inputSchema: {
    siteUrl: siteUrlSchema,
    inspectionUrl: z.string().url().describe('Fully-qualified URL inside the property.'),
    languageCode: z.string().default('en-US'),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl);
    const apis = await ctx.apis();
    const res = await apis.searchconsole.urlInspection.index.inspect({
      requestBody: {
        inspectionUrl: args.inspectionUrl,
        siteUrl: args.siteUrl,
        languageCode: args.languageCode,
      },
    });
    return jsonResult(`URL inspection for ${args.inspectionUrl}`, res.data.inspectionResult ?? {});
  },
});

export const gscReadTools = [
  gscListSites,
  gscSearchAnalytics,
  gscComparePeriods,
  gscOpportunities,
  gscListSitemaps,
  gscGetSitemap,
  gscInspectUrl,
];
