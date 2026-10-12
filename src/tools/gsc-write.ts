import { z } from 'zod';
import { textResult } from '../util/output.js';
import { siteUrlSchema } from './gsc.js';
import { defineTool } from './registry.js';

const feedpath = z
  .string()
  .url()
  .describe('Full sitemap URL, e.g. https://www.example.com/sitemap.xml');

export const gscSubmitSitemap = defineTool({
  name: 'gsc_submit_sitemap',
  title: 'Submit sitemap',
  description: 'Submits (or resubmits) a sitemap to Search Console for a property.',
  access: 'write',
  toolset: 'gsc',
  idempotent: true,
  inputSchema: { siteUrl: siteUrlSchema, feedpath },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl, 'write');
    const apis = await ctx.apis();
    await apis.searchconsole.sitemaps.submit({ siteUrl: args.siteUrl, feedpath: args.feedpath });
    return textResult(`Submitted sitemap ${args.feedpath} for ${args.siteUrl}.`);
  },
});

export const gscDeleteSitemap = defineTool({
  name: 'gsc_delete_sitemap',
  title: 'Delete sitemap',
  description:
    'Removes a submitted sitemap from Search Console (does not delete the file from your website).',
  access: 'write',
  toolset: 'gsc',
  destructive: true,
  idempotent: true,
  inputSchema: { siteUrl: siteUrlSchema, feedpath },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl, 'write');
    const apis = await ctx.apis();
    await apis.searchconsole.sitemaps.delete({ siteUrl: args.siteUrl, feedpath: args.feedpath });
    return textResult(`Deleted sitemap ${args.feedpath} from ${args.siteUrl}.`);
  },
});

export const gscAddSite = defineTool({
  name: 'gsc_add_site',
  title: 'Add Search Console property',
  description:
    'Adds a property to the connected Search Console account. Ownership still has to be verified (DNS/HTML) before data is available.',
  access: 'write',
  toolset: 'gsc',
  idempotent: true,
  inputSchema: { siteUrl: siteUrlSchema },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl, 'write');
    const apis = await ctx.apis();
    await apis.searchconsole.sites.add({ siteUrl: args.siteUrl });
    return textResult(
      `Added ${args.siteUrl} to Search Console. If it is new, verify ownership at https://search.google.com/search-console before data appears.`,
    );
  },
});

export const gscDeleteSite = defineTool({
  name: 'gsc_delete_site',
  title: 'Remove Search Console property',
  description:
    "Removes a property from the connected account's Search Console list. Other owners keep access; you can add it back later.",
  access: 'write',
  toolset: 'gsc',
  destructive: true,
  idempotent: true,
  inputSchema: { siteUrl: siteUrlSchema },
  handler: async (args, ctx) => {
    ctx.policy.assertSite(args.siteUrl, 'write');
    const apis = await ctx.apis();
    await apis.searchconsole.sites.delete({ siteUrl: args.siteUrl });
    return textResult(`Removed ${args.siteUrl} from Search Console for the connected account.`);
  },
});

export const gscWriteTools = [gscSubmitSitemap, gscDeleteSitemap, gscAddSite, gscDeleteSite];
