import { z } from 'zod';
import type { analyticsdata_v1beta } from 'googleapis';
import { DATE_HELP, isValidDateExpression } from '../util/dates.js';
import { ToolInputError } from '../util/errors.js';
import { jsonResult, round, tableResult, type Row } from '../util/output.js';
import { defineTool } from './registry.js';

type FilterExpression = analyticsdata_v1beta.Schema$FilterExpression;

export const propertyIdSchema = z
  .string()
  .min(1)
  .describe(
    'GA4 property ID, e.g. "123456789" or "properties/123456789" (see ga4_list_properties).',
  );

const dateExpr = z.string().refine(isValidDateExpression, { message: `Use ${DATE_HELP}` });

const dateRangeSchema = z.object({
  startDate: dateExpr.describe(`Start date: ${DATE_HELP}`),
  endDate: dateExpr.describe(`End date: ${DATE_HELP}`),
  name: z
    .string()
    .optional()
    .describe('Optional label; adds a "dateRange" column when several ranges are given.'),
});

const STRING_OPS = {
  exact: 'EXACT',
  begins_with: 'BEGINS_WITH',
  ends_with: 'ENDS_WITH',
  contains: 'CONTAINS',
  full_regex: 'FULL_REGEXP',
  partial_regex: 'PARTIAL_REGEXP',
} as const;
const NUMERIC_OPS = {
  eq: 'EQUAL',
  gt: 'GREATER_THAN',
  gte: 'GREATER_THAN_OR_EQUAL',
  lt: 'LESS_THAN',
  lte: 'LESS_THAN_OR_EQUAL',
} as const;

const simpleFilterSchema = z.object({
  field: z
    .string()
    .describe('Dimension or metric API name, e.g. "sessionDefaultChannelGroup" or "sessions".'),
  operator: z.enum([
    ...(Object.keys(STRING_OPS) as [keyof typeof STRING_OPS]),
    'in_list',
    ...(Object.keys(NUMERIC_OPS) as [keyof typeof NUMERIC_OPS]),
  ]),
  value: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Value for string or numeric operators.'),
  values: z.array(z.string()).optional().describe('Values for in_list.'),
  caseSensitive: z.boolean().default(false),
  not: z.boolean().default(false).describe('Negate this filter.'),
});
type SimpleFilter = z.infer<typeof simpleFilterSchema>;

const rawFilterSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Advanced: a raw GA4 FilterExpression (andGroup/orGroup/notExpression/filter). Overrides the simple filters.',
  );

export function toFilterExpression(
  filters: SimpleFilter[] | undefined,
): FilterExpression | undefined {
  if (!filters?.length) return undefined;
  const expressions = filters.map((f): FilterExpression => {
    let filter: analyticsdata_v1beta.Schema$Filter;
    if (f.operator === 'in_list') {
      if (!f.values?.length)
        throw new ToolInputError(`in_list filter on ${f.field} needs "values"`);
      filter = {
        fieldName: f.field,
        inListFilter: { values: f.values, caseSensitive: f.caseSensitive },
      };
    } else if (f.operator in NUMERIC_OPS) {
      const n = Number(f.value);
      if (f.value === undefined || Number.isNaN(n))
        throw new ToolInputError(`${f.operator} filter on ${f.field} needs a numeric "value"`);
      filter = {
        fieldName: f.field,
        numericFilter: {
          operation: NUMERIC_OPS[f.operator as keyof typeof NUMERIC_OPS],
          value: Number.isInteger(n) ? { int64Value: String(n) } : { doubleValue: n },
        },
      };
    } else {
      if (f.value === undefined)
        throw new ToolInputError(`${f.operator} filter on ${f.field} needs "value"`);
      filter = {
        fieldName: f.field,
        stringFilter: {
          matchType: STRING_OPS[f.operator as keyof typeof STRING_OPS],
          value: String(f.value),
          caseSensitive: f.caseSensitive,
        },
      };
    }
    return f.not ? { notExpression: { filter } } : { filter };
  });
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

const orderBySchema = z.object({
  field: z.string(),
  desc: z.boolean().default(true),
  type: z
    .enum(['metric', 'dimension'])
    .optional()
    .describe('Inferred from the requested metrics when omitted.'),
});

function toOrderBys(
  orderBys: z.infer<typeof orderBySchema>[] | undefined,
  metrics: string[],
): analyticsdata_v1beta.Schema$OrderBy[] | undefined {
  return orderBys?.map((o) => {
    const isMetric = o.type ? o.type === 'metric' : metrics.includes(o.field);
    return isMetric
      ? { metric: { metricName: o.field }, desc: o.desc }
      : { dimension: { dimensionName: o.field }, desc: o.desc };
  });
}

function parseMetric(
  value: string | null | undefined,
  type: string | null | undefined,
): number | string | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  if (type === 'TYPE_INTEGER') return n;
  return round(n, 4);
}

interface ReportLike {
  dimensionHeaders?: analyticsdata_v1beta.Schema$DimensionHeader[];
  metricHeaders?: analyticsdata_v1beta.Schema$MetricHeader[];
  rows?: analyticsdata_v1beta.Schema$Row[];
}

export function reportRows(report: ReportLike): Row[] {
  const dims = (report.dimensionHeaders ?? []).map((h) => h.name ?? '');
  const mets = report.metricHeaders ?? [];
  return (report.rows ?? []).map((r) => {
    const out: Row = {};
    dims.forEach((d, i) => (out[d] = r.dimensionValues?.[i]?.value ?? ''));
    mets.forEach(
      (m, i) => (out[m.name ?? `metric${i}`] = parseMetric(r.metricValues?.[i]?.value, m.type)),
    );
    return out;
  });
}

function reportNotes(
  res: analyticsdata_v1beta.Schema$RunReportResponse,
  limit?: number,
  offset = 0,
): string[] {
  const notes: string[] = [];
  const shown = res.rows?.length ?? 0;
  if (res.rowCount !== undefined && res.rowCount !== null) {
    notes.push(`rowCount: ${res.rowCount} (showing ${shown}).`);
    if (limit && offset + shown < res.rowCount)
      notes.push(`More rows available: call again with offset=${offset + shown}.`);
  }
  const totals = res.totals?.[0];
  if (totals?.metricValues?.length) {
    const t = (res.metricHeaders ?? []).map(
      (m, i) => `${m.name}=${parseMetric(totals.metricValues?.[i]?.value, m.type)}`,
    );
    notes.push(`Totals: ${t.join(', ')}`);
  }
  const md = res.metadata;
  if (md?.subjectToThresholding)
    notes.push('Data is subject to thresholding (low counts may be withheld).');
  if (md?.dataLossFromOtherRow)
    notes.push('Some rows were rolled into "(other)" due to high cardinality.');
  if (md?.samplingMetadatas?.length) notes.push('Report is sampled.');
  if (md?.currencyCode) notes.push(`Currency: ${md.currencyCode}; time zone: ${md.timeZone}.`);
  return notes;
}

function propertyName(
  ctx: { policy: { assertProperty: (p: string) => string } },
  property: string,
): string {
  return `properties/${ctx.policy.assertProperty(property)}`;
}

async function listAll<T>(
  fetchPage: (pageToken?: string) => Promise<{ items?: T[]; nextPageToken?: string | null }>,
  max = 2000,
): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    items.push(...(page.items ?? []));
    token = page.nextPageToken ?? undefined;
  } while (token && items.length < max);
  return items;
}

export const ga4ListProperties = defineTool({
  name: 'ga4_list_properties',
  title: 'List GA4 properties',
  description:
    'Lists all GA4 accounts and properties the connected identity can access. Use the propertyId with other ga4_* tools.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: {},
  handler: async (_args, ctx) => {
    const apis = await ctx.apis();
    const summaries = await listAll(async (pageToken) => {
      const res = await apis.analyticsAdmin.accountSummaries.list({ pageSize: 200, pageToken });
      return { items: res.data.accountSummaries, nextPageToken: res.data.nextPageToken };
    });
    const rows = summaries.flatMap((a) =>
      (a.propertySummaries ?? [])
        .map((p) => ({
          account: `${a.displayName} (${a.account?.replace('accounts/', '')})`,
          propertyId: p.property?.replace('properties/', ''),
          propertyName: p.displayName,
          propertyType: p.propertyType?.replace('PROPERTY_TYPE_', '').toLowerCase(),
        }))
        .filter((p) => p.propertyId && ctx.policy.propertyAllowed(p.propertyId)),
    );
    return tableResult(`GA4 properties (${rows.length})`, rows);
  },
});

export const ga4GetProperty = defineTool({
  name: 'ga4_get_property',
  title: 'Get GA4 property',
  description:
    'Returns GA4 property settings: time zone, currency, industry, service level, create time.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: { propertyId: propertyIdSchema },
  handler: async (args, ctx) => {
    const name = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.get({ name });
    return jsonResult(`GA4 property ${name}`, res.data);
  },
});

export const ga4GetMetadata = defineTool({
  name: 'ga4_get_metadata',
  title: 'GA4 dimensions & metrics',
  description:
    'Lists the dimension and metric API names available for a property (including custom definitions). Use search to narrow results, e.g. "session", "revenue", "customEvent".',
  access: 'read',
  toolset: 'ga4',
  inputSchema: {
    propertyId: propertyIdSchema,
    kind: z.enum(['dimensions', 'metrics', 'both']).default('both'),
    search: z
      .string()
      .optional()
      .describe('Case-insensitive substring matched against API name, UI name and category.'),
    customOnly: z.boolean().default(false),
  },
  handler: async (args, ctx) => {
    const name = `${propertyName(ctx, args.propertyId)}/metadata`;
    const apis = await ctx.apis();
    const res = await apis.analyticsData.properties.getMetadata({ name });
    const q = args.search?.toLowerCase();
    const match = (item: {
      apiName?: string | null;
      uiName?: string | null;
      category?: string | null;
      customDefinition?: boolean | null;
    }) =>
      (!args.customOnly || item.customDefinition) &&
      (!q || [item.apiName, item.uiName, item.category].some((v) => v?.toLowerCase().includes(q)));
    const rows: Row[] = [];
    if (args.kind !== 'metrics') {
      for (const d of (res.data.dimensions ?? []).filter(match)) {
        rows.push({
          kind: 'dimension',
          apiName: d.apiName,
          uiName: d.uiName,
          category: d.category,
          custom: d.customDefinition ?? false,
        });
      }
    }
    if (args.kind !== 'dimensions') {
      for (const m of (res.data.metrics ?? []).filter(match)) {
        rows.push({
          kind: 'metric',
          apiName: m.apiName,
          uiName: m.uiName,
          category: m.category,
          type: m.type,
          custom: m.customDefinition ?? false,
        });
      }
    }
    return tableResult(`GA4 metadata for ${args.propertyId} (${rows.length})`, rows);
  },
});

export const ga4RunReport = defineTool({
  name: 'ga4_run_report',
  title: 'Run GA4 report',
  description:
    'Runs a GA4 Data API report. Common metrics: activeUsers, sessions, engagedSessions, engagementRate, screenPageViews, conversions/keyEvents, totalRevenue, purchaseRevenue. Common dimensions: date, sessionDefaultChannelGroup, sessionSource, sessionMedium, sessionCampaignName, landingPagePlusQueryString, pagePath, deviceCategory, country, eventName. Use ga4_get_metadata for the full list.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: {
    propertyId: propertyIdSchema,
    metrics: z.array(z.string()).min(1).max(10),
    dimensions: z.array(z.string()).max(9).default([]),
    startDate: dateExpr
      .default('28daysAgo')
      .describe(`Start date (${DATE_HELP}). Ignored if dateRanges is set.`),
    endDate: dateExpr
      .default('yesterday')
      .describe(`End date (${DATE_HELP}). Ignored if dateRanges is set.`),
    dateRanges: z
      .array(dateRangeSchema)
      .max(4)
      .optional()
      .describe('Multiple ranges for comparisons.'),
    dimensionFilters: z
      .array(simpleFilterSchema)
      .optional()
      .describe('Dimension filters combined with AND.'),
    metricFilters: z
      .array(simpleFilterSchema)
      .optional()
      .describe('Metric filters (applied after aggregation), AND.'),
    dimensionFilter: rawFilterSchema,
    metricFilter: rawFilterSchema,
    orderBys: z.array(orderBySchema).optional().describe('Default: first metric descending.'),
    limit: z.number().int().min(1).max(100000).default(100),
    offset: z.number().int().min(0).default(0),
    keepEmptyRows: z.boolean().default(false),
    includeTotals: z.boolean().default(true),
    currencyCode: z.string().length(3).optional(),
  },
  handler: async (args, ctx) => {
    const property = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const requestBody: analyticsdata_v1beta.Schema$RunReportRequest = {
      dateRanges: args.dateRanges ?? [{ startDate: args.startDate, endDate: args.endDate }],
      dimensions: args.dimensions.map((name) => ({ name })),
      metrics: args.metrics.map((name) => ({ name })),
      dimensionFilter:
        (args.dimensionFilter as FilterExpression | undefined) ??
        toFilterExpression(args.dimensionFilters),
      metricFilter:
        (args.metricFilter as FilterExpression | undefined) ??
        toFilterExpression(args.metricFilters),
      orderBys: toOrderBys(args.orderBys, args.metrics) ?? [
        { metric: { metricName: args.metrics[0] }, desc: true },
      ],
      limit: String(args.limit),
      offset: String(args.offset),
      keepEmptyRows: args.keepEmptyRows,
      metricAggregations: args.includeTotals ? ['TOTAL'] : undefined,
      currencyCode: args.currencyCode,
    };
    const res = await apis.analyticsData.properties.runReport({ property, requestBody });
    const ranges = requestBody.dateRanges!.map((r) => `${r.startDate} → ${r.endDate}`).join(', ');
    return tableResult(`GA4 report for ${property} (${ranges})`, reportRows(res.data), {
      notes: reportNotes(res.data, args.limit, args.offset),
    });
  },
});

export const ga4RunRealtimeReport = defineTool({
  name: 'ga4_run_realtime_report',
  title: 'Run GA4 realtime report',
  description:
    'Realtime GA4 data for the last 30 minutes (60 on GA4 360). Metrics: activeUsers, eventCount, screenPageViews, keyEvents. Dimensions: unifiedScreenName, country, city, deviceCategory, eventName, minutesAgo, platform.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: {
    propertyId: propertyIdSchema,
    metrics: z.array(z.string()).min(1).max(10).default(['activeUsers']),
    dimensions: z.array(z.string()).max(4).default([]),
    dimensionFilters: z.array(simpleFilterSchema).optional(),
    minuteRanges: z
      .array(
        z.object({
          startMinutesAgo: z.number().int().min(0).max(59),
          endMinutesAgo: z.number().int().min(0).max(59),
          name: z.string().optional(),
        }),
      )
      .max(2)
      .optional(),
    limit: z.number().int().min(1).max(10000).default(50),
  },
  handler: async (args, ctx) => {
    const property = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const res = await apis.analyticsData.properties.runRealtimeReport({
      property,
      requestBody: {
        dimensions: args.dimensions.map((name) => ({ name })),
        metrics: args.metrics.map((name) => ({ name })),
        dimensionFilter: toFilterExpression(args.dimensionFilters),
        minuteRanges: args.minuteRanges,
        limit: String(args.limit),
        metricAggregations: ['TOTAL'],
      },
    });
    return tableResult(`GA4 realtime report for ${property}`, reportRows(res.data), {
      notes: reportNotes(res.data as analyticsdata_v1beta.Schema$RunReportResponse),
    });
  },
});

export const ga4RunPivotReport = defineTool({
  name: 'ga4_run_pivot_report',
  title: 'Run GA4 pivot report',
  description:
    'Runs a GA4 pivot report (cross-tab). Provide pivots as GA4 Pivot objects, e.g. [{"fieldNames":["deviceCategory"],"limit":5},{"fieldNames":["sessionDefaultChannelGroup"],"limit":10}]. Every pivot field must also appear in dimensions. Rows are returned flat.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: {
    propertyId: propertyIdSchema,
    metrics: z.array(z.string()).min(1).max(10),
    dimensions: z.array(z.string()).min(1).max(9),
    pivots: z.array(z.record(z.string(), z.unknown())).min(1).max(4),
    startDate: dateExpr.default('28daysAgo'),
    endDate: dateExpr.default('yesterday'),
    dimensionFilters: z.array(simpleFilterSchema).optional(),
  },
  handler: async (args, ctx) => {
    const property = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const res = await apis.analyticsData.properties.runPivotReport({
      property,
      requestBody: {
        dateRanges: [{ startDate: args.startDate, endDate: args.endDate }],
        dimensions: args.dimensions.map((name) => ({ name })),
        metrics: args.metrics.map((name) => ({ name })),
        dimensionFilter: toFilterExpression(args.dimensionFilters),
        pivots: args.pivots as analyticsdata_v1beta.Schema$Pivot[],
      },
    });
    return tableResult(`GA4 pivot report for ${property}`, reportRows(res.data));
  },
});

export const ga4CheckCompatibility = defineTool({
  name: 'ga4_check_compatibility',
  title: 'Check GA4 field compatibility',
  description:
    'Checks which of the given dimensions and metrics can be combined in one GA4 report. Use when a report fails with an incompatibility error.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: {
    propertyId: propertyIdSchema,
    dimensions: z.array(z.string()).default([]),
    metrics: z.array(z.string()).default([]),
  },
  handler: async (args, ctx) => {
    const property = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const res = await apis.analyticsData.properties.checkCompatibility({
      property,
      requestBody: {
        dimensions: args.dimensions.map((name) => ({ name })),
        metrics: args.metrics.map((name) => ({ name })),
      },
    });
    const rows: Row[] = [
      ...(res.data.dimensionCompatibilities ?? []).map((d) => ({
        kind: 'dimension',
        apiName: d.dimensionMetadata?.apiName,
        compatibility: d.compatibility,
      })),
      ...(res.data.metricCompatibilities ?? []).map((m) => ({
        kind: 'metric',
        apiName: m.metricMetadata?.apiName,
        compatibility: m.compatibility,
      })),
    ];
    return tableResult(`Compatibility for ${property}`, rows);
  },
});

export const ga4ListCustomDimensions = defineTool({
  name: 'ga4_list_custom_dimensions',
  title: 'List GA4 custom dimensions',
  description: 'Lists custom dimensions registered on a GA4 property.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: { propertyId: propertyIdSchema },
  handler: async (args, ctx) => {
    const parent = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const items = await listAll(async (pageToken) => {
      const res = await apis.analyticsAdmin.properties.customDimensions.list({
        parent,
        pageSize: 200,
        pageToken,
      });
      return { items: res.data.customDimensions, nextPageToken: res.data.nextPageToken };
    });
    return tableResult(
      `Custom dimensions for ${parent} (${items.length})`,
      items.map((d) => ({
        name: d.name,
        parameterName: d.parameterName,
        displayName: d.displayName,
        scope: d.scope,
        description: d.description,
      })),
    );
  },
});

export const ga4ListCustomMetrics = defineTool({
  name: 'ga4_list_custom_metrics',
  title: 'List GA4 custom metrics',
  description: 'Lists custom metrics registered on a GA4 property.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: { propertyId: propertyIdSchema },
  handler: async (args, ctx) => {
    const parent = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const items = await listAll(async (pageToken) => {
      const res = await apis.analyticsAdmin.properties.customMetrics.list({
        parent,
        pageSize: 200,
        pageToken,
      });
      return { items: res.data.customMetrics, nextPageToken: res.data.nextPageToken };
    });
    return tableResult(
      `Custom metrics for ${parent} (${items.length})`,
      items.map((m) => ({
        name: m.name,
        parameterName: m.parameterName,
        displayName: m.displayName,
        unit: m.measurementUnit,
        scope: m.scope,
      })),
    );
  },
});

export const ga4ListKeyEvents = defineTool({
  name: 'ga4_list_key_events',
  title: 'List GA4 key events',
  description: 'Lists key events (formerly conversions) on a GA4 property.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: { propertyId: propertyIdSchema },
  handler: async (args, ctx) => {
    const parent = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const items = await listAll(async (pageToken) => {
      const res = await apis.analyticsAdmin.properties.keyEvents.list({
        parent,
        pageSize: 200,
        pageToken,
      });
      return { items: res.data.keyEvents, nextPageToken: res.data.nextPageToken };
    });
    return tableResult(
      `Key events for ${parent} (${items.length})`,
      items.map((k) => ({
        name: k.name,
        eventName: k.eventName,
        countingMethod: k.countingMethod,
        defaultValue: k.defaultValue
          ? `${k.defaultValue.numericValue} ${k.defaultValue.currencyCode}`
          : '',
        custom: k.custom,
        deletable: k.deletable,
      })),
    );
  },
});

export const ga4ListDataStreams = defineTool({
  name: 'ga4_list_data_streams',
  title: 'List GA4 data streams',
  description:
    'Lists web/app data streams with measurement ID, default URI, package name or bundle ID.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: { propertyId: propertyIdSchema },
  handler: async (args, ctx) => {
    const parent = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const items = await listAll(async (pageToken) => {
      const res = await apis.analyticsAdmin.properties.dataStreams.list({
        parent,
        pageSize: 200,
        pageToken,
      });
      return { items: res.data.dataStreams, nextPageToken: res.data.nextPageToken };
    });
    return tableResult(
      `Data streams for ${parent} (${items.length})`,
      items.map((s) => ({
        name: s.name,
        type: s.type,
        displayName: s.displayName,
        measurementId: s.webStreamData?.measurementId ?? '',
        uri:
          s.webStreamData?.defaultUri ??
          s.androidAppStreamData?.packageName ??
          s.iosAppStreamData?.bundleId ??
          '',
      })),
    );
  },
});

export const ga4ListAudiences = defineTool({
  name: 'ga4_list_audiences',
  title: 'List GA4 audiences',
  description: 'Lists audiences defined on a GA4 property (Admin API v1alpha).',
  access: 'read',
  toolset: 'ga4',
  inputSchema: {
    propertyId: propertyIdSchema,
    includeDefinitions: z
      .boolean()
      .default(false)
      .describe('Include the full filter clauses of each audience.'),
  },
  handler: async (args, ctx) => {
    const parent = propertyName(ctx, args.propertyId);
    const apis = await ctx.apis();
    const items = await listAll(async (pageToken) => {
      const res = await apis.analyticsAdminAlpha.properties.audiences.list({
        parent,
        pageSize: 200,
        pageToken,
      });
      return { items: res.data.audiences, nextPageToken: res.data.nextPageToken };
    });
    if (args.includeDefinitions)
      return jsonResult(`Audiences for ${parent} (${items.length})`, items);
    return tableResult(
      `Audiences for ${parent} (${items.length})`,
      items.map((a) => ({
        name: a.name,
        displayName: a.displayName,
        description: a.description,
        membershipDurationDays: a.membershipDurationDays,
        adsPersonalizationEnabled: a.adsPersonalizationEnabled,
      })),
    );
  },
});

export const ga4GetDataRetention = defineTool({
  name: 'ga4_get_data_retention',
  title: 'Get GA4 data retention',
  description: 'Returns event- and user-level data retention settings for a GA4 property.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: { propertyId: propertyIdSchema },
  handler: async (args, ctx) => {
    const name = `${propertyName(ctx, args.propertyId)}/dataRetentionSettings`;
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.getDataRetentionSettings({ name });
    return jsonResult(`Data retention for ${args.propertyId}`, res.data);
  },
});

export const ga4ListMeasurementProtocolSecrets = defineTool({
  name: 'ga4_list_measurement_protocol_secrets',
  title: 'List Measurement Protocol secrets',
  description:
    'Lists Measurement Protocol API secrets for a web/app data stream. Secret values are hidden unless includeValues is true.',
  access: 'read',
  toolset: 'ga4',
  inputSchema: {
    streamName: z
      .string()
      .describe(
        'Data stream resource name, e.g. "properties/123/dataStreams/456" (see ga4_list_data_streams).',
      ),
    includeValues: z.boolean().default(false).describe('Reveal secret values (sensitive).'),
  },
  handler: async (args, ctx) => {
    const parent = ctx.policy.assertResourceName(args.streamName);
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.dataStreams.measurementProtocolSecrets.list({
      parent,
      pageSize: 200,
    });
    return tableResult(
      `Measurement Protocol secrets for ${parent}`,
      (res.data.measurementProtocolSecrets ?? []).map((s) => ({
        name: s.name,
        displayName: s.displayName,
        secretValue: args.includeValues ? s.secretValue : '(hidden)',
      })),
    );
  },
});

export const ga4ReadTools = [
  ga4ListProperties,
  ga4GetProperty,
  ga4GetMetadata,
  ga4RunReport,
  ga4RunRealtimeReport,
  ga4RunPivotReport,
  ga4CheckCompatibility,
  ga4ListCustomDimensions,
  ga4ListCustomMetrics,
  ga4ListKeyEvents,
  ga4ListDataStreams,
  ga4ListAudiences,
  ga4GetDataRetention,
  ga4ListMeasurementProtocolSecrets,
];
