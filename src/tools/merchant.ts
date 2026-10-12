import { z } from 'zod';
import type { merchantapi_products_v1 } from 'googleapis';
import type { GoogleApis } from '../google/clients.js';
import { DATE_HELP, isValidDateExpression, resolveDate } from '../util/dates.js';
import { ToolInputError } from '../util/errors.js';
import {
  jsonResult,
  markdownTable,
  round,
  tableResult,
  textResult,
  type Row,
} from '../util/output.js';
import { defineTool, type ToolContext } from './registry.js';

type Product = merchantapi_products_v1.Schema$Product;

export const accountSchema = z
  .string()
  .regex(/^(accounts\/)?\d+$/, 'Expected a Merchant Center account ID like 123456789')
  .describe('Merchant Center account ID, e.g. "123456789" (see merchant_list_accounts).');

const dateExpr = (fallback: string, what: string) =>
  z
    .string()
    .default(fallback)
    .refine(isValidDateExpression, { message: `Use ${DATE_HELP}` })
    .describe(`${what}: ${DATE_HELP}. Default "${fallback}".`);

function parent(ctx: ToolContext, account: string, mode: 'read' | 'write' = 'read'): string {
  return `accounts/${ctx.policy.assertMerchantAccount(account, mode)}`;
}

/** Account ID from a resource name like accounts/123/products/xyz. */
function accountOf(name: string): string {
  const m = /^accounts\/(\d+)\//.exec(name);
  if (!m)
    throw new ToolInputError(`"${name}" is not a Merchant resource name (accounts/{id}/...).`);
  return m[1]!;
}

export function money(
  price: { amountMicros?: string | null; currencyCode?: string | null } | null | undefined,
): string {
  if (!price?.amountMicros) return '';
  return `${round(Number(price.amountMicros) / 1_000_000, 2)} ${price.currencyCode ?? ''}`.trim();
}

/** Decimal amount → Merchant API Price (micros). */
function toPrice(amount: number, currencyCode: string) {
  return {
    amountMicros: String(Math.round(amount * 1_000_000)),
    currencyCode: currencyCode.toUpperCase(),
  };
}

/** Flattens a report view row: Price → "12.34 AUD", Date → YYYY-MM-DD, other objects → JSON. */
export function flattenReportRow(view: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(view)) {
    if (value && typeof value === 'object' && 'amountMicros' in value) {
      out[key] = money(value as { amountMicros?: string; currencyCode?: string });
    } else if (value && typeof value === 'object' && 'year' in value && 'month' in value) {
      const d = value as { year: number; month: number; day?: number };
      out[key] =
        `${d.year}-${String(d.month).padStart(2, '0')}${d.day ? `-${String(d.day).padStart(2, '0')}` : ''}`;
    } else if (typeof value === 'number' && !Number.isInteger(value)) {
      out[key] = round(value, 4);
    } else {
      out[key] = value as unknown;
    }
  }
  return out;
}

async function searchReport(
  apis: GoogleApis,
  account: string,
  query: string,
  maxRows: number,
): Promise<Row[]> {
  const rows: Row[] = [];
  let pageToken: string | undefined;
  do {
    const res = await apis.merchantReports.accounts.reports.search({
      parent: account,
      requestBody: { query, pageSize: Math.min(1000, maxRows - rows.length), pageToken },
    });
    for (const r of res.data.results ?? []) {
      const view = Object.values(r).find((v) => v && typeof v === 'object') as
        Record<string, unknown> | undefined;
      if (view) rows.push(flattenReportRow(view));
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && rows.length < maxRows);
  return rows;
}

function statusSummary(p: Product): string {
  const parts = (p.productStatus?.destinationStatuses ?? []).map((d) => {
    const bits = [
      d.approvedCountries?.length ? `✓${d.approvedCountries.length}` : '',
      d.pendingCountries?.length ? `…${d.pendingCountries.length}` : '',
      d.disapprovedCountries?.length ? `✗${d.disapprovedCountries.length}` : '',
    ].filter(Boolean);
    return `${d.reportingContext}:${bits.join('/')}`;
  });
  return parts.join(' ');
}

async function listProducts(apis: GoogleApis, account: string, max: number, pageToken?: string) {
  const products: Product[] = [];
  let token = pageToken;
  do {
    const res = await apis.merchantProducts.accounts.products.list({
      parent: account,
      pageSize: Math.min(1000, max - products.length),
      pageToken: token,
    });
    products.push(...(res.data.products ?? []));
    token = res.data.nextPageToken ?? undefined;
  } while (token && products.length < max);
  return { products, nextPageToken: token };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export const merchantListAccounts = defineTool({
  name: 'merchant_list_accounts',
  title: 'List Merchant Center accounts',
  description:
    'Lists the Merchant Center accounts the connected Google identity can access (including sub-accounts of an advanced account).',
  access: 'read',
  toolset: 'merchant',
  inputSchema: {},
  handler: async (_args, ctx) => {
    const apis = await ctx.apis();
    const res = await apis.merchantAccounts.accounts.list({ pageSize: 250 });
    const rows = (res.data.accounts ?? [])
      .filter((a) => ctx.policy.merchantAccountAllowed(a.accountId ?? a.name ?? ''))
      .map((a) => ({
        accountId: a.accountId,
        name: a.accountName,
        language: a.languageCode,
        timeZone: a.timeZone?.id,
        testAccount: a.testAccount ? 'yes' : '',
      }));
    return tableResult(`Merchant Center accounts (${rows.length})`, rows);
  },
});

export const merchantAccountIssues = defineTool({
  name: 'merchant_account_issues',
  title: 'Merchant account health',
  description:
    'Account-level issues (suspensions, policy, setup problems) plus a summary of product approval status per destination and country (approved / pending / disapproved / expiring).',
  access: 'read',
  toolset: 'merchant',
  inputSchema: { account: accountSchema },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account);
    const apis = await ctx.apis();
    const [issues, statuses] = await Promise.all([
      apis.merchantAccounts.accounts.issues.list({ parent: p, pageSize: 100 }),
      apis.merchantIssues.accounts.aggregateProductStatuses.list({ parent: p, pageSize: 250 }),
    ]);
    const issueRows = (issues.data.accountIssues ?? []).map((i) => ({
      severity: i.severity,
      title: i.title,
      impact: (i.impactedDestinations ?? [])
        .map(
          (d) => `${d.reportingContext}: ${(d.impacts ?? []).map((x) => x.regionCode).join(',')}`,
        )
        .join('; '),
      details: i.detail,
    }));
    const statusRows = (statuses.data.aggregateProductStatuses ?? []).map((s) => ({
      destination: s.reportingContext,
      country: s.country,
      active: s.stats?.activeCount,
      pending: s.stats?.pendingCount,
      disapproved: s.stats?.disapprovedCount,
      expiring: s.stats?.expiringCount,
      topIssues: (s.itemLevelIssues ?? [])
        .slice(0, 3)
        .map((i) => `${i.code} (${i.productCount})`)
        .join(', '),
    }));
    return textResult(
      [
        `# Merchant account ${p} health`,
        `## Account issues (${issueRows.length})`,
        markdownTable(issueRows),
        `## Product status by destination & country`,
        markdownTable(statusRows),
      ].join('\n\n'),
    );
  },
});

export const merchantListDataSources = defineTool({
  name: 'merchant_list_data_sources',
  title: 'List Merchant data sources',
  description:
    'Lists product data sources (feeds). Product writes need an API data source (input = API); file/scheduled-fetch feeds can only be overridden through a supplemental API data source.',
  access: 'read',
  toolset: 'merchant',
  inputSchema: { account: accountSchema },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account);
    const apis = await ctx.apis();
    const res = await apis.merchantDataSources.accounts.dataSources.list({
      parent: p,
      pageSize: 250,
    });
    const rows = (res.data.dataSources ?? []).map((d) => ({
      name: d.name,
      displayName: d.displayName,
      input: d.input,
      type: d.primaryProductDataSource
        ? 'primary products'
        : d.supplementalProductDataSource
          ? 'supplemental products'
          : d.promotionDataSource
            ? 'promotions'
            : d.localInventoryDataSource || d.regionalInventoryDataSource
              ? 'inventory'
              : 'other',
      feedLabel:
        d.primaryProductDataSource?.feedLabel ?? d.supplementalProductDataSource?.feedLabel ?? '',
      language:
        d.primaryProductDataSource?.contentLanguage ??
        d.supplementalProductDataSource?.contentLanguage ??
        '',
    }));
    return tableResult(`Data sources for ${p} (${rows.length})`, rows);
  },
});

export const merchantListProducts = defineTool({
  name: 'merchant_list_products',
  title: 'List Merchant products',
  description:
    'Lists products with offer ID, title, price, availability and approval status per destination (✓ approved / … pending / ✗ disapproved country counts).',
  access: 'read',
  toolset: 'merchant',
  inputSchema: {
    account: accountSchema,
    search: z
      .string()
      .optional()
      .describe('Case-insensitive text matched against title and offer ID.'),
    onlyWithIssues: z.boolean().default(false),
    limit: z.number().int().min(1).max(1000).default(50),
    pageToken: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account);
    const apis = await ctx.apis();
    const filtering = Boolean(args.search || args.onlyWithIssues);
    const { products, nextPageToken } = await listProducts(
      apis,
      p,
      filtering ? 5000 : args.limit,
      args.pageToken,
    );
    const q = args.search?.toLowerCase();
    const rows = products
      .filter((x) => !args.onlyWithIssues || (x.productStatus?.itemLevelIssues?.length ?? 0) > 0)
      .filter((x) => !q || `${x.productAttributes?.title} ${x.offerId}`.toLowerCase().includes(q))
      .slice(0, args.limit)
      .map((x) => ({
        offerId: x.offerId,
        title: x.productAttributes?.title,
        price: money(x.productAttributes?.salePrice ?? x.productAttributes?.price),
        availability: x.productAttributes?.availability,
        status: statusSummary(x),
        issues: x.productStatus?.itemLevelIssues?.length ?? 0,
        name: x.name,
      }));
    return tableResult(`Products in ${p} (${rows.length})`, rows, {
      notes:
        nextPageToken && !filtering
          ? [`More products: call again with pageToken="${nextPageToken}".`]
          : [],
    });
  },
});

export const merchantGetProduct = defineTool({
  name: 'merchant_get_product',
  title: 'Get Merchant product',
  description:
    'Full product details including all attributes, status per destination and every item-level issue with its resolution.',
  access: 'read',
  toolset: 'merchant',
  inputSchema: {
    name: z
      .string()
      .describe(
        'Product resource name from merchant_list_products, e.g. "accounts/123/products/en~AU~sku123".',
      ),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertMerchantAccount(accountOf(args.name));
    const apis = await ctx.apis();
    const res = await apis.merchantProducts.accounts.products.get({ name: args.name });
    return jsonResult(`Product ${args.name}`, res.data);
  },
});

export const merchantProductIssues = defineTool({
  name: 'merchant_product_issues',
  title: 'Merchant product issues',
  description:
    'Groups every item-level issue across the catalogue by issue code: severity, affected destinations, number of products, example offers and how to fix it. Start here to fix disapprovals.',
  access: 'read',
  toolset: 'merchant',
  inputSchema: {
    account: accountSchema,
    maxProducts: z
      .number()
      .int()
      .min(1)
      .max(20000)
      .default(5000)
      .describe('How many products to scan.'),
  },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account);
    const apis = await ctx.apis();
    const { products } = await listProducts(apis, p, args.maxProducts);
    const groups = new Map<
      string,
      {
        severity: string;
        description: string;
        resolution: string;
        contexts: Set<string>;
        offers: string[];
        count: number;
      }
    >();
    for (const prod of products) {
      for (const issue of prod.productStatus?.itemLevelIssues ?? []) {
        const key = `${issue.code}|${issue.attribute ?? ''}`;
        const g = groups.get(key) ?? {
          severity: issue.severity ?? '',
          description: issue.description ?? '',
          resolution: issue.resolution ?? '',
          contexts: new Set<string>(),
          offers: [],
          count: 0,
        };
        g.count++;
        if (issue.reportingContext) g.contexts.add(issue.reportingContext);
        if (g.offers.length < 3 && prod.offerId && !g.offers.includes(prod.offerId))
          g.offers.push(prod.offerId);
        groups.set(key, g);
      }
    }
    const severityRank: Record<string, number> = { DISAPPROVED: 0, DEMOTED: 1, NOT_IMPACTED: 2 };
    const rows = [...groups.entries()]
      .sort(
        ([, a], [, b]) =>
          (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3) || b.count - a.count,
      )
      .map(([key, g]) => ({
        issue: key.replace(/\|$/, ''),
        severity: g.severity,
        products: g.count,
        destinations: [...g.contexts].join(', '),
        examples: g.offers.join(', '),
        description: g.description,
        fix: g.resolution,
      }));
    return tableResult(
      `Product issues in ${p}: ${rows.length} issue types across ${products.length} products scanned`,
      rows,
    );
  },
});

const PERFORMANCE_DIMENSIONS = {
  offer: ['offer_id', 'title'],
  date: ['date'],
  country: ['customer_country_code'],
  marketing_method: ['marketing_method'],
  brand: ['brand'],
  category: ['category_l1'],
} as const;

export function performanceQuery(
  dimension: keyof typeof PERFORMANCE_DIMENSIONS,
  start: string,
  end: string,
  limit: number,
): string {
  const dims = PERFORMANCE_DIMENSIONS[dimension];
  const order = dimension === 'date' ? 'date ASC' : 'clicks DESC';
  return `SELECT ${[...dims, 'impressions', 'clicks', 'click_through_rate', 'conversions', 'conversion_value'].join(', ')} FROM product_performance_view WHERE date BETWEEN '${start}' AND '${end}' ORDER BY ${order} LIMIT ${limit}`;
}

export const merchantPerformanceReport = defineTool({
  name: 'merchant_performance_report',
  title: 'Merchant performance report',
  description:
    'Clicks, impressions, CTR, conversions and conversion value from Google Shopping (free listings and ads), grouped by product, date, country, marketing method (organic vs ads), brand or category.',
  access: 'read',
  toolset: 'merchant',
  inputSchema: {
    account: accountSchema,
    groupBy: z
      .enum(['offer', 'date', 'country', 'marketing_method', 'brand', 'category'])
      .default('offer'),
    startDate: dateExpr('30daysAgo', 'Start date'),
    endDate: dateExpr('yesterday', 'End date'),
    limit: z.number().int().min(1).max(5000).default(50),
  },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account);
    const apis = await ctx.apis();
    const start = resolveDate(args.startDate);
    const end = resolveDate(args.endDate);
    const rows = await searchReport(
      apis,
      p,
      performanceQuery(args.groupBy, start, end, args.limit),
      args.limit,
    );
    return tableResult(`Shopping performance by ${args.groupBy}, ${start} → ${end}`, rows);
  },
});

export const merchantPriceCompetitiveness = defineTool({
  name: 'merchant_price_competitiveness',
  title: 'Merchant price competitiveness',
  description:
    'Compares your product prices with the benchmark price other merchants charge for the same product (price_competitiveness_product_view).',
  access: 'read',
  toolset: 'merchant',
  inputSchema: {
    account: accountSchema,
    country: z.string().length(2).optional().describe('ISO country code, e.g. "AU".'),
    limit: z.number().int().min(1).max(5000).default(50),
  },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account);
    const apis = await ctx.apis();
    const where = args.country
      ? ` WHERE report_country_code = '${args.country.toUpperCase()}'`
      : '';
    const query = `SELECT offer_id, title, brand, report_country_code, price, benchmark_price FROM price_competitiveness_product_view${where} LIMIT ${args.limit}`;
    const rows = await searchReport(apis, p, query, args.limit);
    return tableResult(`Price vs benchmark (${rows.length} products)`, rows, {
      notes: ['Only products with enough market data have a benchmark price.'],
    });
  },
});

export const merchantReportQuery = defineTool({
  name: 'merchant_report_query',
  title: 'Merchant report query (MCQL)',
  description:
    "Runs a raw Merchant Center Query Language query. Views include product_performance_view, product_view, price_competitiveness_product_view, price_insights_product_view, best_sellers_product_cluster_view, best_sellers_brand_view, competitive_visibility_competitor_view. Example: SELECT report_category_id, title, brand, rank FROM best_sellers_product_cluster_view WHERE report_country_code = 'AU' AND report_granularity = 'WEEKLY' LIMIT 50",
  access: 'read',
  toolset: 'merchant',
  inputSchema: {
    account: accountSchema,
    query: z.string().regex(/^\s*SELECT\s/i, 'Only SELECT queries are supported'),
    maxRows: z.number().int().min(1).max(5000).default(200),
  },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account);
    const apis = await ctx.apis();
    const rows = await searchReport(apis, p, args.query, args.maxRows);
    return tableResult(`Query results (${rows.length} rows)`, rows);
  },
});

export const merchantListPromotions = defineTool({
  name: 'merchant_list_promotions',
  title: 'List Merchant promotions',
  description:
    'Lists promotions with their offer type, effective dates, destinations and approval status.',
  access: 'read',
  toolset: 'merchant',
  inputSchema: { account: accountSchema },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account);
    const apis = await ctx.apis();
    const res = await apis.merchantPromotions.accounts.promotions.list({
      parent: p,
      pageSize: 250,
    });
    const rows = (res.data.promotions ?? []).map((x) => ({
      promotionId: x.promotionId,
      title: x.attributes?.longTitle,
      type: x.attributes?.couponValueType,
      code: x.attributes?.genericRedemptionCode ?? '',
      start: x.attributes?.promotionEffectiveTimePeriod?.startTime?.slice(0, 10),
      end: x.attributes?.promotionEffectiveTimePeriod?.endTime?.slice(0, 10),
      status: (x.promotionStatus?.destinationStatuses ?? [])
        .map((d) => `${d.reportingContext}:${d.status}`)
        .join(' '),
    }));
    return tableResult(`Promotions in ${p} (${rows.length})`, rows);
  },
});

// ---------------------------------------------------------------------------
// Write tools (toolset "merchant")
// ---------------------------------------------------------------------------

const dataSourceSchema = z
  .string()
  .regex(/^accounts\/\d+\/dataSources\/\d+$/)
  .describe(
    'API data source, e.g. "accounts/123/dataSources/456" (see merchant_list_data_sources; input must be API).',
  );

const attributesSchema = z
  .object({
    title: z.string().max(150).optional(),
    description: z.string().max(5000).optional(),
    link: z.string().url().optional(),
    imageLink: z.string().url().optional(),
    price: z.number().positive().optional().describe('Decimal amount, e.g. 49.95.'),
    salePrice: z.number().positive().optional(),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe('Required with price/salePrice, e.g. "AUD".'),
    availability: z.enum(['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'BACKORDER']).optional(),
    condition: z.enum(['NEW', 'USED', 'REFURBISHED']).optional(),
    brand: z.string().optional(),
    gtins: z.array(z.string()).optional(),
    mpn: z.string().optional(),
    googleProductCategory: z.string().optional(),
    productTypes: z.array(z.string()).optional(),
  })
  .passthrough()
  .describe(
    'Product attributes. Any other Merchant API productAttributes field can be passed as-is.',
  );

type Attributes = z.infer<typeof attributesSchema>;

export function toProductAttributes(attrs: Attributes): Record<string, unknown> {
  const { price, salePrice, currency, ...rest } = attrs;
  const out: Record<string, unknown> = { ...rest };
  if (price !== undefined || salePrice !== undefined) {
    if (!currency)
      throw new ToolInputError('currency is required when setting price or salePrice.');
    if (price !== undefined) out.price = toPrice(price, currency);
    if (salePrice !== undefined) out.salePrice = toPrice(salePrice, currency);
  }
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
}

const productInputName = (
  account: string,
  contentLanguage: string,
  feedLabel: string,
  offerId: string,
) =>
  `accounts/${account}/productInputs/${Buffer.from(`${contentLanguage}~${feedLabel}~${offerId}`).toString('base64url')}`;

const productKey = {
  account: accountSchema,
  dataSource: dataSourceSchema,
  offerId: z.string().min(1).max(50),
  contentLanguage: z.string().min(2).max(5).default('en').describe('e.g. "en".'),
  feedLabel: z.string().min(1).describe('Usually the target country, e.g. "AU".'),
};

export const merchantUpsertProduct = defineTool({
  name: 'merchant_upsert_product',
  title: 'Create or replace Merchant product',
  description:
    'Inserts a product (or fully replaces it if it exists) in an API data source. For products that come from a file or scheduled feed, use a supplemental API data source to override individual attributes. Changes take a few minutes to process.',
  access: 'write',
  toolset: 'merchant',
  idempotent: true,
  inputSchema: { ...productKey, attributes: attributesSchema },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account, 'write');
    if (accountOf(`${args.dataSource}/`) !== p.slice(9))
      throw new ToolInputError('dataSource belongs to a different account.');
    const apis = await ctx.apis();
    const res = await apis.merchantProducts.accounts.productInputs.insert({
      parent: p,
      dataSource: args.dataSource,
      requestBody: {
        offerId: args.offerId,
        contentLanguage: args.contentLanguage,
        feedLabel: args.feedLabel,
        productAttributes: toProductAttributes(args.attributes),
      },
    });
    return jsonResult(
      `Upserted product ${args.offerId} (processing can take a few minutes)`,
      res.data,
    );
  },
});

export const merchantUpdateProduct = defineTool({
  name: 'merchant_update_product',
  title: 'Update Merchant product',
  description:
    'Updates only the given attributes of a product in an API (or supplemental API) data source; everything else is untouched.',
  access: 'write',
  toolset: 'merchant',
  idempotent: true,
  inputSchema: { ...productKey, attributes: attributesSchema },
  handler: async (args, ctx) => {
    const account = parent(ctx, args.account, 'write').slice(9);
    const productAttributes = toProductAttributes(args.attributes);
    const fields = Object.keys(productAttributes);
    if (fields.length === 0) throw new ToolInputError('Provide at least one attribute to update.');
    const apis = await ctx.apis();
    const res = await apis.merchantProducts.accounts.productInputs.patch({
      name: productInputName(account, args.contentLanguage, args.feedLabel, args.offerId),
      dataSource: args.dataSource,
      // No updateMask: the API then updates exactly the populated fields, leaving the rest untouched.
      requestBody: {
        offerId: args.offerId,
        contentLanguage: args.contentLanguage,
        feedLabel: args.feedLabel,
        productAttributes,
      },
    });
    return jsonResult(`Updated ${fields.join(', ')} on ${args.offerId}`, res.data);
  },
});

export const merchantDeleteProduct = defineTool({
  name: 'merchant_delete_product',
  title: 'Delete Merchant product',
  description:
    'Deletes a product from an API data source (or removes its supplemental overrides when a supplemental data source is given). The product stops showing on Google once processed.',
  access: 'write',
  toolset: 'merchant',
  destructive: true,
  idempotent: true,
  inputSchema: {
    account: accountSchema,
    dataSource: dataSourceSchema,
    offerId: z.string().min(1).max(50),
    contentLanguage: z.string().min(2).max(5).default('en'),
    feedLabel: z.string().min(1),
  },
  handler: async (args, ctx) => {
    const account = parent(ctx, args.account, 'write').slice(9);
    const apis = await ctx.apis();
    await apis.merchantProducts.accounts.productInputs.delete({
      name: productInputName(account, args.contentLanguage, args.feedLabel, args.offerId),
      dataSource: args.dataSource,
    });
    return textResult(
      `Deleted product ${args.offerId} (${args.contentLanguage}/${args.feedLabel}) from ${args.dataSource}.`,
    );
  },
});

export const merchantRegisterGcpProject = defineTool({
  name: 'merchant_register_gcp_project',
  title: 'Register Google Cloud project with Merchant',
  description:
    'One-time setup: registers this server\'s Google Cloud project with a Merchant Center account so the Merchant API accepts its calls. Run it once per account if other merchant_* tools fail with "not registered".',
  access: 'write',
  toolset: 'merchant',
  idempotent: true,
  inputSchema: {
    account: accountSchema,
    developerEmail: z
      .string()
      .email()
      .describe('Contact email for API announcements (usually yours).'),
  },
  handler: async (args, ctx) => {
    const p = parent(ctx, args.account, 'write');
    const apis = await ctx.apis();
    const res = await apis.merchantAccounts.accounts.developerRegistration.registerGcp({
      name: `${p}/developerRegistration`,
      requestBody: { developerEmail: args.developerEmail },
    });
    return jsonResult(`Registered the Google Cloud project with ${p}`, res.data);
  },
});

export const merchantTools = [
  merchantListAccounts,
  merchantAccountIssues,
  merchantListDataSources,
  merchantListProducts,
  merchantGetProduct,
  merchantProductIssues,
  merchantPerformanceReport,
  merchantPriceCompetitiveness,
  merchantReportQuery,
  merchantListPromotions,
  merchantUpsertProduct,
  merchantUpdateProduct,
  merchantDeleteProduct,
  merchantRegisterGcpProject,
];
