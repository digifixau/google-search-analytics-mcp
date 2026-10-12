import { z } from 'zod';
import { jsonResult, tableResult } from '../util/output.js';
import { defineTool } from './registry.js';

const POLICY_NOTE =
  'Google officially supports the Indexing API only for pages with JobPosting or BroadcastEvent (livestream) structured data; default quota is 200 publish requests/day. The connected account must be an Owner of the Search Console property.';

export const indexingGetStatus = defineTool({
  name: 'indexing_get_status',
  title: 'Indexing API notification status',
  description: `Returns the latest URL_UPDATED / URL_DELETED notifications Google received for a URL via the Indexing API. ${POLICY_NOTE}`,
  access: 'read',
  toolset: 'indexing',
  inputSchema: { url: z.string().url() },
  handler: async (args, ctx) => {
    ctx.policy.assertUrl(args.url);
    const apis = await ctx.apis();
    const res = await apis.indexing.urlNotifications.getMetadata({ url: args.url });
    return jsonResult(`Indexing API metadata for ${args.url}`, res.data);
  },
});

export const indexingPublish = defineTool({
  name: 'indexing_publish',
  title: 'Request indexing / removal',
  description: `Notifies Google via the Indexing API that URLs were updated (URL_UPDATED, requests a recrawl) or removed (URL_DELETED). Up to 20 URLs per call. ${POLICY_NOTE}`,
  access: 'write',
  toolset: 'indexing',
  inputSchema: {
    urls: z.array(z.string().url()).min(1).max(20),
    type: z.enum(['URL_UPDATED', 'URL_DELETED']).default('URL_UPDATED'),
  },
  handler: async (args, ctx) => {
    for (const url of args.urls) ctx.policy.assertUrl(url, 'write');
    const apis = await ctx.apis();
    const rows = [];
    for (const url of args.urls) {
      try {
        const res = await apis.indexing.urlNotifications.publish({
          requestBody: { url, type: args.type },
        });
        const meta = res.data.urlNotificationMetadata;
        rows.push({
          url,
          status: 'accepted',
          notifyTime:
            (args.type === 'URL_DELETED' ? meta?.latestRemove : meta?.latestUpdate)?.notifyTime ??
            '',
        });
      } catch (error) {
        const e = error as {
          response?: { status?: number; data?: { error?: { message?: string } } };
          message?: string;
        };
        rows.push({
          url,
          status: `error ${e.response?.status ?? ''}`.trim(),
          notifyTime: e.response?.data?.error?.message ?? e.message ?? '',
        });
      }
    }
    const failed = rows.filter((r) => r.status !== 'accepted').length;
    if (failed === rows.length) {
      throw new Error(`All ${failed} Indexing API requests failed: ${rows[0]?.notifyTime}`);
    }
    return tableResult(
      `Indexing API ${args.type}: ${rows.length - failed} accepted, ${failed} failed`,
      rows,
    );
  },
});

export const indexingTools = [indexingGetStatus, indexingPublish];
