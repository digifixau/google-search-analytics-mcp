import { describe, expect, it, vi } from 'vitest';
import type { GoogleApis } from '../src/google/clients.js';
import { toFilterExpression } from '../src/tools/ga4.js';
import { connectClient, testConfig, text } from './helpers.js';

const READ = ['mcp:read'];
const RW = ['mcp:read', 'mcp:write'];

async function toolNames(env: Record<string, string>, scopes: string[]) {
  const { client } = await connectClient(testConfig(env), scopes);
  return (await client.listTools()).tools;
}

describe('tool exposure', () => {
  it('read-only server exposes no write tools even to a write token', async () => {
    const tools = await toolNames({ ACCESS_MODE: 'readonly' }, RW);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain('indexing_get_status');
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['gsc_search_analytics', 'ga4_run_report', 'search', 'fetch']),
    );
  });

  it('read-write server hides write tools from read-only tokens', async () => {
    const tools = await toolNames({ ACCESS_MODE: 'readwrite' }, READ);
    expect(tools.some((t) => !t.annotations?.readOnlyHint)).toBe(false);
  });

  it('read-write server exposes write tools to write tokens, limited by WRITE_TOOLSETS', async () => {
    const all = await toolNames({ ACCESS_MODE: 'readwrite' }, RW);
    const writes = all.filter((t) => !t.annotations?.readOnlyHint);
    expect(writes.length).toBe(22);
    expect(writes.every((t) => t.description?.startsWith('[WRITE]'))).toBe(true);
    expect(all.find((t) => t.name === 'gsc_delete_site')?.annotations?.destructiveHint).toBe(true);

    const gscOnly = await toolNames({ ACCESS_MODE: 'readwrite', WRITE_TOOLSETS: 'gsc' }, RW);
    expect(
      gscOnly
        .filter((t) => !t.annotations?.readOnlyHint)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['gsc_add_site', 'gsc_delete_site', 'gsc_delete_sitemap', 'gsc_submit_sitemap']);
  });

  it('tokens without mcp:read get nothing', async () => {
    expect(await toolNames({ ACCESS_MODE: 'readwrite' }, ['mcp:write'])).toHaveLength(0);
  });
});

describe('gsc tools', () => {
  it('formats search analytics rows', async () => {
    const query = vi.fn().mockResolvedValue({
      data: {
        rows: [
          { keys: ['plumber melbourne'], clicks: 10, impressions: 200, ctr: 0.05, position: 4.26 },
        ],
        responseAggregationType: 'byProperty',
      },
    });
    const apis = { searchconsole: { searchanalytics: { query } } } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis);
    const res = await client.callTool({
      name: 'gsc_search_analytics',
      arguments: {
        siteUrl: 'sc-domain:example.com',
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        rowLimit: 1,
      },
    });
    expect(query).toHaveBeenCalledWith({
      siteUrl: 'sc-domain:example.com',
      requestBody: expect.objectContaining({
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        dimensions: ['query'],
        type: 'web',
        rowLimit: 1,
      }),
    });
    const out = text(res);
    expect(out).toContain('| plumber melbourne | 10 | 200 | 5% | 4.3 |');
    expect(out).toContain('startRow=1');
  });

  it('ranks striking-distance opportunities', async () => {
    const query = vi.fn().mockResolvedValue({
      data: {
        rows: [
          { keys: ['a'], clicks: 1, impressions: 1000, ctr: 0.001, position: 8 },
          { keys: ['b'], clicks: 50, impressions: 5000, ctr: 0.01, position: 12 },
          { keys: ['top'], clicks: 500, impressions: 2000, ctr: 0.25, position: 1.2 },
          { keys: ['rare'], clicks: 0, impressions: 10, ctr: 0, position: 6 },
        ],
      },
    });
    const apis = { searchconsole: { searchanalytics: { query } } } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis);
    const out = text(
      await client.callTool({
        name: 'gsc_opportunities',
        arguments: { siteUrl: 'sc-domain:example.com' },
      }),
    );
    const lines = out
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| query') && !l.startsWith('| ---'));
    expect(lines.map((l) => l.split('|')[1]!.trim())).toEqual(['b', 'a']);
  });

  it('maps Google errors to actionable messages', async () => {
    const query = vi
      .fn()
      .mockRejectedValue({
        response: {
          status: 403,
          data: { error: { message: 'User does not have sufficient permission for site' } },
        },
      });
    const apis = { searchconsole: { searchanalytics: { query } } } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis);
    const res = await client.callTool({
      name: 'gsc_search_analytics',
      arguments: { siteUrl: 'sc-domain:example.com' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Google denied access \(403\)/);
  });
});

describe('write tools', () => {
  it('audits successful and blocked writes', async () => {
    const submit = vi.fn().mockResolvedValue({ data: {} });
    const apis = { searchconsole: { sitemaps: { submit } } } as unknown as GoogleApis;
    const config = testConfig({
      ACCESS_MODE: 'readwrite',
      WRITE_ALLOWED_GSC_SITES: 'sc-domain:example.com',
    });
    const { client, audit } = await connectClient(config, RW, apis);
    const ok = await client.callTool({
      name: 'gsc_submit_sitemap',
      arguments: { siteUrl: 'sc-domain:example.com', feedpath: 'https://example.com/sitemap.xml' },
    });
    expect(ok.isError).toBeFalsy();
    const denied = await client.callTool({
      name: 'gsc_submit_sitemap',
      arguments: { siteUrl: 'sc-domain:other.com', feedpath: 'https://other.com/sitemap.xml' },
    });
    expect(denied.isError).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(audit.recent().map((a) => a.outcome)).toEqual(['error', 'ok']);
  });

  it('patches only provided fields', async () => {
    const patch = vi.fn().mockResolvedValue({ data: { name: 'properties/1/customDimensions/2' } });
    const apis = {
      analyticsAdmin: { properties: { customDimensions: { patch } } },
    } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig({ ACCESS_MODE: 'readwrite' }), RW, apis);
    await client.callTool({
      name: 'ga4_update_custom_dimension',
      arguments: { name: 'properties/1/customDimensions/2', displayName: 'Plan' },
    });
    expect(patch).toHaveBeenCalledWith({
      name: 'properties/1/customDimensions/2',
      updateMask: 'displayName',
      requestBody: { displayName: 'Plan' },
    });
  });
});

describe('ga4 filters', () => {
  it('builds filter expressions', () => {
    expect(
      toFilterExpression([
        {
          field: 'country',
          operator: 'exact',
          value: 'Australia',
          caseSensitive: false,
          not: false,
        },
      ]),
    ).toEqual({
      filter: {
        fieldName: 'country',
        stringFilter: { matchType: 'EXACT', value: 'Australia', caseSensitive: false },
      },
    });
    const and = toFilterExpression([
      { field: 'sessions', operator: 'gt', value: 10, caseSensitive: false, not: false },
      {
        field: 'deviceCategory',
        operator: 'in_list',
        values: ['mobile', 'tablet'],
        caseSensitive: false,
        not: true,
      },
    ]);
    expect(and).toEqual({
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: 'sessions',
              numericFilter: { operation: 'GREATER_THAN', value: { int64Value: '10' } },
            },
          },
          {
            notExpression: {
              filter: {
                fieldName: 'deviceCategory',
                inListFilter: { values: ['mobile', 'tablet'], caseSensitive: false },
              },
            },
          },
        ],
      },
    });
    expect(() =>
      toFilterExpression([{ field: 'x', operator: 'in_list', caseSensitive: false, not: false }]),
    ).toThrow();
  });

  it('runs a report and renders rows and totals', async () => {
    const runReport = vi.fn().mockResolvedValue({
      data: {
        dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
        metricHeaders: [
          { name: 'sessions', type: 'TYPE_INTEGER' },
          { name: 'engagementRate', type: 'TYPE_FLOAT' },
        ],
        rows: [
          {
            dimensionValues: [{ value: 'Organic Search' }],
            metricValues: [{ value: '120' }, { value: '0.654321' }],
          },
        ],
        totals: [{ metricValues: [{ value: '120' }, { value: '0.654321' }] }],
        rowCount: 1,
      },
    });
    const apis = { analyticsData: { properties: { runReport } } } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis);
    const out = text(
      await client.callTool({
        name: 'ga4_run_report',
        arguments: {
          propertyId: 'properties/123',
          metrics: ['sessions', 'engagementRate'],
          dimensions: ['sessionDefaultChannelGroup'],
        },
      }),
    );
    expect(runReport.mock.calls[0]![0].property).toBe('properties/123');
    expect(runReport.mock.calls[0]![0].requestBody.orderBys).toEqual([
      { metric: { metricName: 'sessions' }, desc: true },
    ]);
    expect(out).toContain('| Organic Search | 120 | 0.6543 |');
    expect(out).toContain('Totals: sessions=120');
  });
});
