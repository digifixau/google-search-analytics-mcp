import { describe, expect, it, vi } from 'vitest';
import type { GoogleApis } from '../src/google/clients.js';
import { formatDuration } from '../src/tools/youtube.js';
import { flattenReportRow, performanceQuery, toProductAttributes } from '../src/tools/merchant.js';
import { connectClient, testConfig, text } from './helpers.js';

const READ = ['mcp:read'];
const RW = ['mcp:read', 'mcp:write'];

async function names(connector: string, scopes: string[], env: Record<string, string> = {}) {
  const { client } = await connectClient(
    testConfig({ ACCESS_MODE: 'readwrite', ...env }),
    scopes,
    {},
    connector,
  );
  return (await client.listTools()).tools.map((t) => t.name);
}

describe('connectors', () => {
  it('serves YouTube and Merchant as their own MCPs', async () => {
    const ytRead = await names('youtube', READ);
    const ytRw = await names('youtube', RW);
    expect(ytRead).toHaveLength(9);
    expect(ytRw).toHaveLength(10);
    expect(ytRw.every((n) => n.startsWith('yt_'))).toBe(true);
    expect(ytRw).toContain('yt_update_video_metadata');

    const mRead = await names('merchant', READ);
    const mRw = await names('merchant', RW);
    expect(mRead).toHaveLength(10);
    expect(mRw).toHaveLength(14);
    expect(mRw.every((n) => n.startsWith('merchant_'))).toBe(true);

    expect(await names('search-analytics', RW)).toHaveLength(46);
  });

  it('drops write tools when their toolset is not enabled', async () => {
    const yt = await names('youtube', RW, { WRITE_TOOLSETS: 'gsc' });
    expect(yt).not.toContain('yt_update_video_metadata');
    const merchant = await names('merchant', RW, { WRITE_TOOLSETS: 'gsc' });
    expect(merchant).toHaveLength(10);
  });
});

describe('youtube tools', () => {
  it('formats durations', () => {
    expect(formatDuration('PT1H2M3S')).toBe('1:02:03');
    expect(formatDuration('PT4M5S')).toBe('4:05');
    expect(formatDuration('PT45S')).toBe('0:45');
  });

  it('ranks top videos and adds their titles', async () => {
    const query = vi.fn().mockResolvedValue({
      data: {
        columnHeaders: [
          { name: 'video', dataType: 'STRING' },
          { name: 'views', dataType: 'INTEGER' },
          { name: 'estimatedMinutesWatched', dataType: 'INTEGER' },
          { name: 'averageViewDuration', dataType: 'INTEGER' },
          { name: 'averageViewPercentage', dataType: 'FLOAT' },
          { name: 'likes', dataType: 'INTEGER' },
          { name: 'subscribersGained', dataType: 'INTEGER' },
        ],
        rows: [['abcdefghijk', 1200, 3400, 170, 45.678912, 80, 12]],
      },
    });
    const list = vi.fn().mockResolvedValue({
      data: { items: [{ id: 'abcdefghijk', snippet: { title: 'How to fix a fridge' } }] },
    });
    const apis = {
      youtubeAnalytics: { reports: { query } },
      youtube: { videos: { list } },
    } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis, 'youtube');
    const out = text(
      await client.callTool({
        name: 'yt_top_videos',
        arguments: {
          startDate: '2026-01-01',
          endDate: '2026-01-31',
          rankBy: 'estimatedMinutesWatched',
        },
      }),
    );
    expect(query.mock.calls[0]![0]).toMatchObject({
      ids: 'channel==MINE',
      dimensions: 'video',
      sort: '-estimatedMinutesWatched',
      startDate: '2026-01-01',
    });
    expect(out).toContain(
      '| abcdefghijk | How to fix a fridge | 1200 | 3400 | 170 | 45.6789 | 80 | 12 |',
    );
  });

  it('merges metadata updates over the current snippet and enforces the channel allowlist', async () => {
    const snippet = {
      channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
      title: 'Old title',
      description: 'Keep me',
      tags: ['a'],
      categoryId: '22',
    };
    const list = vi.fn().mockResolvedValue({ data: { items: [{ id: 'abcdefghijk', snippet }] } });
    const update = vi
      .fn()
      .mockResolvedValue({ data: { snippet: { ...snippet, title: 'New title' } } });
    const apis = { youtube: { videos: { list, update } } } as unknown as GoogleApis;

    const { client, audit } = await connectClient(
      testConfig({ ACCESS_MODE: 'readwrite' }),
      RW,
      apis,
      'youtube',
    );
    await client.callTool({
      name: 'yt_update_video_metadata',
      arguments: { videoId: 'abcdefghijk', title: 'New title' },
    });
    expect(update).toHaveBeenCalledWith({
      part: ['snippet'],
      requestBody: {
        id: 'abcdefghijk',
        snippet: {
          title: 'New title',
          description: 'Keep me',
          tags: ['a'],
          categoryId: '22',
          defaultLanguage: undefined,
        },
      },
    });
    expect(audit.recent()[0]).toMatchObject({ tool: 'yt_update_video_metadata', outcome: 'ok' });

    const locked = await connectClient(
      testConfig({
        ACCESS_MODE: 'readwrite',
        WRITE_ALLOWED_YOUTUBE_CHANNELS: 'UCbbbbbbbbbbbbbbbbbbbbbb',
      }),
      RW,
      apis,
      'youtube',
    );
    const denied = await locked.client.callTool({
      name: 'yt_update_video_metadata',
      arguments: { videoId: 'abcdefghijk', title: 'Nope' },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('not in the write allowlist');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('explains revenue errors for non-monetized channels', async () => {
    const query = vi
      .fn()
      .mockRejectedValue({ response: { status: 403, data: { error: { message: 'Forbidden' } } } });
    const apis = { youtubeAnalytics: { reports: { query } } } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis, 'youtube');
    const res = await client.callTool({ name: 'yt_revenue', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('monetized channels');
  });
});

describe('merchant tools', () => {
  it('converts prices and flattens report rows', () => {
    expect(toProductAttributes({ title: 'Fridge', price: 1299.95, currency: 'aud' })).toEqual({
      title: 'Fridge',
      price: { amountMicros: '1299950000', currencyCode: 'AUD' },
    });
    expect(() => toProductAttributes({ price: 10 })).toThrow(/currency/);
    expect(
      flattenReportRow({
        offerId: 'sku1',
        date: { year: 2026, month: 3, day: 7 },
        conversionValue: { amountMicros: '25500000', currencyCode: 'AUD' },
        clickThroughRate: 0.0123456,
      }),
    ).toEqual({
      offerId: 'sku1',
      date: '2026-03-07',
      conversionValue: '25.5 AUD',
      clickThroughRate: 0.0123,
    });
  });

  it('builds the performance MCQL query', async () => {
    expect(performanceQuery('offer', '2026-01-01', '2026-01-31', 25)).toBe(
      "SELECT offer_id, title, impressions, clicks, click_through_rate, conversions, conversion_value FROM product_performance_view WHERE date BETWEEN '2026-01-01' AND '2026-01-31' ORDER BY clicks DESC LIMIT 25",
    );
    const search = vi.fn().mockResolvedValue({
      data: {
        results: [
          { productPerformanceView: { offerId: 'sku1', clicks: '12', impressions: '400' } },
        ],
      },
    });
    const apis = {
      merchantReports: { accounts: { reports: { search } } },
    } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis, 'merchant');
    const out = text(
      await client.callTool({
        name: 'merchant_performance_report',
        arguments: {
          account: '123',
          groupBy: 'date',
          startDate: '2026-02-01',
          endDate: '2026-02-28',
        },
      }),
    );
    expect(search.mock.calls[0]![0].parent).toBe('accounts/123');
    expect(search.mock.calls[0]![0].requestBody.query).toContain(
      "BETWEEN '2026-02-01' AND '2026-02-28' ORDER BY date ASC",
    );
    expect(out).toContain('| sku1 | 12 | 400 |');
  });

  it('groups item-level issues across products', async () => {
    const issue = (code: string, severity: string, ctx = 'SHOPPING_ADS') => ({
      code,
      severity,
      reportingContext: ctx,
      description: `${code} description`,
      resolution: 'merchant_action',
    });
    const products = [
      { offerId: 'a', productStatus: { itemLevelIssues: [issue('missing_gtin', 'DEMOTED')] } },
      {
        offerId: 'b',
        productStatus: {
          itemLevelIssues: [
            issue('image_too_small', 'DISAPPROVED'),
            issue('missing_gtin', 'DEMOTED', 'FREE_LISTINGS'),
          ],
        },
      },
      { offerId: 'c', productStatus: { itemLevelIssues: [issue('missing_gtin', 'DEMOTED')] } },
      { offerId: 'd', productStatus: {} },
    ];
    const list = vi.fn().mockResolvedValue({ data: { products } });
    const apis = {
      merchantProducts: { accounts: { products: { list } } },
    } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis, 'merchant');
    const out = text(
      await client.callTool({ name: 'merchant_product_issues', arguments: { account: '123' } }),
    );
    const lines = out
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| issue') && !l.startsWith('| ---'));
    // Disapprovals first, then by product count.
    expect(lines[0]).toContain('| image_too_small | DISAPPROVED | 1 |');
    expect(lines[1]).toContain(
      '| missing_gtin | DEMOTED | 3 | SHOPPING_ADS, FREE_LISTINGS | a, b, c |',
    );
    expect(out).toContain('2 issue types across 4 products');
  });

  it('patches only the given attributes and enforces the account write allowlist', async () => {
    const patch = vi.fn().mockResolvedValue({ data: { name: 'x' } });
    const apis = {
      merchantProducts: { accounts: { productInputs: { patch } } },
    } as unknown as GoogleApis;
    const config = testConfig({ ACCESS_MODE: 'readwrite', WRITE_ALLOWED_MERCHANT_ACCOUNTS: '123' });
    const { client } = await connectClient(config, RW, apis, 'merchant');
    const args = {
      dataSource: 'accounts/123/dataSources/9',
      offerId: 'sku/1',
      feedLabel: 'AU',
      attributes: { salePrice: 99, currency: 'AUD', availability: 'IN_STOCK' },
    };
    await client.callTool({
      name: 'merchant_update_product',
      arguments: { account: '123', ...args },
    });
    const call = patch.mock.calls[0]![0];
    expect(call.name).toBe(
      `accounts/123/productInputs/${Buffer.from('en~AU~sku/1').toString('base64url')}`,
    );
    expect(call.updateMask).toBeUndefined();
    expect(call.requestBody.productAttributes).toEqual({
      salePrice: { amountMicros: '99000000', currencyCode: 'AUD' },
      availability: 'IN_STOCK',
    });

    const denied = await client.callTool({
      name: 'merchant_update_product',
      arguments: { account: '456', ...args, dataSource: 'accounts/456/dataSources/9' },
    });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('456 is not in the write allowlist');
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('points to registration when the Cloud project is not registered', async () => {
    const list = vi.fn().mockRejectedValue({
      response: {
        status: 401,
        data: {
          error: {
            message: 'GCP project with id 123 is not registered with the merchant account.',
          },
        },
      },
    });
    const apis = { merchantAccounts: { accounts: { list } } } as unknown as GoogleApis;
    const { client } = await connectClient(testConfig(), READ, apis, 'merchant');
    const res = await client.callTool({ name: 'merchant_list_accounts', arguments: {} });
    expect(text(res)).toContain('merchant_register_gcp_project');
  });
});
