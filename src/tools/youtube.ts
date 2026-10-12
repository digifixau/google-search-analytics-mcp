import { z } from 'zod';
import type { youtubeAnalytics_v2, youtube_v3 } from 'googleapis';
import type { GoogleApis } from '../google/clients.js';
import { DATE_HELP, isValidDateExpression, resolveDate } from '../util/dates.js';
import { AccessDeniedError, ToolInputError } from '../util/errors.js';
import {
  jsonResult,
  markdownTable,
  round,
  tableResult,
  textResult,
  type Row,
} from '../util/output.js';
import { defineTool, type ToolContext } from './registry.js';

const channelIdSchema = z
  .string()
  .regex(/^UC[\w-]{22}$/, 'Expected a channel ID like UCxxxxxxxxxxxxxxxxxxxxxx')
  .optional()
  .describe(
    "Channel ID (UC…) from yt_list_channels. Omit for the connected account's own channel.",
  );

const videoIdSchema = z
  .string()
  .regex(/^[\w-]{11}$/, 'Expected an 11-character YouTube video ID')
  .describe('YouTube video ID, e.g. "dQw4w9WgXcQ".');

const dateExpr = (fallback: string, what: string) =>
  z
    .string()
    .default(fallback)
    .refine(isValidDateExpression, { message: `Use ${DATE_HELP}` })
    .describe(`${what}: ${DATE_HELP}. Default "${fallback}".`);

const rangeSchema = {
  startDate: dateExpr('30daysAgo', 'Start date'),
  endDate: dateExpr('3daysAgo', 'End date (YouTube Analytics usually lags 2-3 days)'),
};

/** The `ids` parameter for YouTube Analytics, enforcing the channel allowlist. */
function channelIds(ctx: ToolContext, channelId: string | undefined): string {
  if (channelId) return `channel==${ctx.policy.assertChannel(channelId)}`;
  if (ctx.config.allowlists.youtubeChannels.length > 0) {
    throw new ToolInputError('A channel allowlist is configured, so channelId is required.');
  }
  return 'channel==MINE';
}

function formatValue(value: unknown, dataType: string | null | undefined): unknown {
  if (typeof value !== 'number') return value;
  return dataType === 'INTEGER' ? value : round(value, 4);
}

export function analyticsRows(res: youtubeAnalytics_v2.Schema$QueryResponse): Row[] {
  const headers = res.columnHeaders ?? [];
  return (res.rows ?? []).map((r) => {
    const out: Row = {};
    headers.forEach((h, i) => (out[h.name ?? `col${i}`] = formatValue(r[i], h.dataType)));
    return out;
  });
}

async function runReport(
  apis: GoogleApis,
  params: youtubeAnalytics_v2.Params$Resource$Reports$Query,
): Promise<Row[]> {
  const res = await apis.youtubeAnalytics.reports.query({
    ...params,
    startDate: resolveDate(params.startDate!),
    endDate: resolveDate(params.endDate!),
  });
  return analyticsRows(res.data);
}

async function videoTitles(apis: GoogleApis, ids: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const res = await apis.youtube.videos.list({
      part: ['snippet'],
      id: ids.slice(i, i + 50),
      maxResults: 50,
    });
    for (const v of res.data.items ?? []) titles.set(v.id!, v.snippet?.title ?? '');
  }
  return titles;
}

/** ISO 8601 duration (PT1H2M3S) to h:mm:ss / m:ss. */
export function formatDuration(iso: string | null | undefined): string {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const [h, min, s] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

async function getChannel(apis: GoogleApis, ctx: ToolContext, channelId?: string) {
  const res = channelId
    ? await apis.youtube.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        id: [ctx.policy.assertChannel(channelId)],
      })
    : await apis.youtube.channels.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        mine: true,
      });
  const channel = res.data.items?.[0];
  if (!channel)
    throw new ToolInputError('No YouTube channel found for the connected Google account.');
  if (!channelId) ctx.policy.assertChannel(channel.id!);
  return channel;
}

export const ytListChannels = defineTool({
  name: 'yt_list_channels',
  title: 'List YouTube channels',
  description:
    'Lists the YouTube channel(s) of the connected Google account with subscribers, total views and video count.',
  access: 'read',
  toolset: 'youtube',
  inputSchema: {},
  handler: async (_args, ctx) => {
    const apis = await ctx.apis();
    const res = await apis.youtube.channels.list({
      part: ['snippet', 'statistics'],
      mine: true,
      maxResults: 50,
    });
    const rows = (res.data.items ?? [])
      .filter((c) => ctx.policy.channelAllowed(c.id!))
      .map((c) => ({
        channelId: c.id,
        title: c.snippet?.title,
        handle: c.snippet?.customUrl,
        subscribers: c.statistics?.hiddenSubscriberCount ? 'hidden' : c.statistics?.subscriberCount,
        views: c.statistics?.viewCount,
        videos: c.statistics?.videoCount,
      }));
    return tableResult(`YouTube channels (${rows.length})`, rows, {
      notes: [
        'Only the channel chosen when Google was connected is visible. To use a Brand Account channel, reconnect Google on /setup and pick that channel.',
      ],
    });
  },
});

export const ytListVideos = defineTool({
  name: 'yt_list_videos',
  title: 'List YouTube videos',
  description:
    'Lists recent uploads (newest first) with views, likes, comments, duration and publish date. Optionally filter by a word in the title.',
  access: 'read',
  toolset: 'youtube',
  inputSchema: {
    channelId: channelIdSchema,
    search: z.string().optional().describe('Case-insensitive text that must appear in the title.'),
    limit: z.number().int().min(1).max(200).default(25),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const channel = await getChannel(apis, ctx, args.channelId);
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new ToolInputError('This channel has no uploads playlist.');
    const ids: string[] = [];
    let pageToken: string | undefined;
    const scanCap = args.search ? 500 : args.limit;
    do {
      const page = await apis.youtube.playlistItems.list({
        part: ['contentDetails'],
        playlistId: uploads,
        maxResults: 50,
        pageToken,
      });
      ids.push(
        ...(page.data.items ?? [])
          .map((i) => i.contentDetails?.videoId)
          .filter((v): v is string => !!v),
      );
      pageToken = page.data.nextPageToken ?? undefined;
    } while (pageToken && ids.length < scanCap);

    const videos: youtube_v3.Schema$Video[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const res = await apis.youtube.videos.list({
        part: ['snippet', 'statistics', 'contentDetails'],
        id: ids.slice(i, i + 50),
        maxResults: 50,
      });
      videos.push(...(res.data.items ?? []));
    }
    const q = args.search?.toLowerCase();
    const rows = videos
      .filter((v) => !q || v.snippet?.title?.toLowerCase().includes(q))
      .slice(0, args.limit)
      .map((v) => ({
        videoId: v.id,
        title: v.snippet?.title,
        published: v.snippet?.publishedAt?.slice(0, 10),
        duration: formatDuration(v.contentDetails?.duration),
        views: v.statistics?.viewCount,
        likes: v.statistics?.likeCount,
        comments: v.statistics?.commentCount,
      }));
    return tableResult(`Videos on ${channel.snippet?.title} (${rows.length})`, rows);
  },
});

export const ytGetVideo = defineTool({
  name: 'yt_get_video',
  title: 'Get YouTube video',
  description:
    "Returns a video's title, description, tags, category, privacy status, duration and lifetime statistics.",
  access: 'read',
  toolset: 'youtube',
  inputSchema: { videoId: videoIdSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const res = await apis.youtube.videos.list({
      part: ['snippet', 'statistics', 'contentDetails', 'status'],
      id: [args.videoId],
    });
    const v = res.data.items?.[0];
    if (!v) throw new ToolInputError(`Video ${args.videoId} not found.`);
    ctx.policy.assertChannel(v.snippet!.channelId!);
    return jsonResult(`Video ${args.videoId}`, {
      title: v.snippet?.title,
      description: v.snippet?.description,
      tags: v.snippet?.tags,
      categoryId: v.snippet?.categoryId,
      defaultLanguage: v.snippet?.defaultLanguage,
      publishedAt: v.snippet?.publishedAt,
      channel: `${v.snippet?.channelTitle} (${v.snippet?.channelId})`,
      privacyStatus: v.status?.privacyStatus,
      duration: formatDuration(v.contentDetails?.duration),
      statistics: v.statistics,
    });
  },
});

export const ytReport = defineTool({
  name: 'yt_report',
  title: 'YouTube Analytics report',
  description:
    'Runs any YouTube Analytics query. Metrics e.g. views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, subscribersGained, subscribersLost, likes, comments, shares. Dimensions e.g. day, month, video, country, deviceType, insightTrafficSourceType, ageGroup, gender, subscribedStatus, creatorContentType. Filters e.g. "video==VIDEO_ID" or "country==AU". Sort e.g. "-views".',
  access: 'read',
  toolset: 'youtube',
  inputSchema: {
    channelId: channelIdSchema,
    ...rangeSchema,
    metrics: z
      .array(z.string())
      .min(1)
      .default(['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained']),
    dimensions: z.array(z.string()).default([]),
    filters: z
      .string()
      .optional()
      .describe('Semicolon-separated filters, e.g. "video==abc123def45;country==US".'),
    sort: z.string().optional().describe('e.g. "-views" (descending) or "day".'),
    maxResults: z.number().int().min(1).max(200).optional(),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const rows = await runReport(apis, {
      ids: channelIds(ctx, args.channelId),
      startDate: args.startDate,
      endDate: args.endDate,
      metrics: args.metrics.join(','),
      dimensions: args.dimensions.join(',') || undefined,
      filters: args.filters,
      sort: args.sort,
      maxResults: args.maxResults,
    });
    return tableResult(
      `YouTube Analytics ${resolveDate(args.startDate)} → ${resolveDate(args.endDate)} (${rows.length} rows)`,
      rows,
    );
  },
});

export const ytTopVideos = defineTool({
  name: 'yt_top_videos',
  title: 'Top YouTube videos',
  description:
    'Top videos for a period ranked by views, watch time or subscribers gained, with titles, average view duration and engagement.',
  access: 'read',
  toolset: 'youtube',
  inputSchema: {
    channelId: channelIdSchema,
    ...rangeSchema,
    rankBy: z
      .enum(['views', 'estimatedMinutesWatched', 'subscribersGained', 'likes'])
      .default('views'),
    limit: z.number().int().min(1).max(200).default(25),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const rows = await runReport(apis, {
      ids: channelIds(ctx, args.channelId),
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: 'video',
      metrics:
        'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,subscribersGained',
      sort: `-${args.rankBy}`,
      maxResults: args.limit,
    });
    const titles = await videoTitles(
      apis,
      rows.map((r) => String(r.video)),
    );
    const out = rows.map((r) => ({
      video: r.video,
      title: titles.get(String(r.video)) ?? '',
      ...r,
    }));
    return tableResult(
      `Top videos by ${args.rankBy}, ${resolveDate(args.startDate)} → ${resolveDate(args.endDate)}`,
      out,
      {
        columns: [
          'video',
          'title',
          'views',
          'estimatedMinutesWatched',
          'averageViewDuration',
          'averageViewPercentage',
          'likes',
          'subscribersGained',
        ],
      },
    );
  },
});

export const ytTrafficSources = defineTool({
  name: 'yt_traffic_sources',
  title: 'YouTube traffic sources',
  description:
    'Where views come from (YouTube search, suggested videos, browse features, external, playlists, Shorts feed, …) for the channel or one video.',
  access: 'read',
  toolset: 'youtube',
  inputSchema: { channelId: channelIdSchema, videoId: videoIdSchema.optional(), ...rangeSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const rows = await runReport(apis, {
      ids: channelIds(ctx, args.channelId),
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: 'insightTrafficSourceType',
      metrics: 'views,estimatedMinutesWatched',
      filters: args.videoId ? `video==${args.videoId}` : undefined,
      sort: '-views',
    });
    return tableResult(`Traffic sources${args.videoId ? ` for ${args.videoId}` : ''}`, rows);
  },
});

export const ytAudience = defineTool({
  name: 'yt_audience',
  title: 'YouTube audience',
  description:
    'Audience profile: age & gender split (viewer %), top countries and device types by views.',
  access: 'read',
  toolset: 'youtube',
  inputSchema: { channelId: channelIdSchema, videoId: videoIdSchema.optional(), ...rangeSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const base = {
      ids: channelIds(ctx, args.channelId),
      startDate: args.startDate,
      endDate: args.endDate,
      filters: args.videoId ? `video==${args.videoId}` : undefined,
    };
    const [demo, countries, devices] = await Promise.all([
      runReport(apis, {
        ...base,
        dimensions: 'ageGroup,gender',
        metrics: 'viewerPercentage',
        sort: 'ageGroup,gender',
      }),
      runReport(apis, {
        ...base,
        dimensions: 'country',
        metrics: 'views,estimatedMinutesWatched',
        sort: '-views',
        maxResults: 15,
      }),
      runReport(apis, {
        ...base,
        dimensions: 'deviceType',
        metrics: 'views,estimatedMinutesWatched',
        sort: '-views',
      }),
    ]);
    return textResult(
      [
        `# Audience${args.videoId ? ` for ${args.videoId}` : ''}, ${resolveDate(args.startDate)} → ${resolveDate(args.endDate)}`,
        '## Age & gender (viewer %)',
        markdownTable(demo),
        '## Top countries',
        markdownTable(countries),
        '## Devices',
        markdownTable(devices),
      ].join('\n\n'),
    );
  },
});

export const ytVideoRetention = defineTool({
  name: 'yt_video_retention',
  title: 'YouTube audience retention',
  description:
    'Audience retention curve for one video: share of viewers still watching at each point (elapsedVideoTimeRatio 0→1). Values above 1 mean rewatching.',
  access: 'read',
  toolset: 'youtube',
  inputSchema: { channelId: channelIdSchema, videoId: videoIdSchema, ...rangeSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const rows = await runReport(apis, {
      ids: channelIds(ctx, args.channelId),
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: 'elapsedVideoTimeRatio',
      metrics: 'audienceWatchRatio,relativeRetentionPerformance',
      filters: `video==${args.videoId}`,
    });
    // 100 points is a lot of tokens; keep every 5th point plus the ends.
    const sampled = rows.filter((_r, i) => i % 5 === 0 || i === rows.length - 1);
    return tableResult(`Retention for ${args.videoId}`, sampled, {
      notes: [
        'relativeRetentionPerformance compares with YouTube videos of similar length (0.5 = median).',
      ],
    });
  },
});

export const ytRevenue = defineTool({
  name: 'yt_revenue',
  title: 'YouTube revenue',
  description:
    'Estimated revenue, ad revenue, gross revenue, CPM, playback-based CPM and monetized playbacks, by day, month or video. Requires a monetized channel (YouTube Partner Program).',
  access: 'read',
  toolset: 'youtube',
  inputSchema: {
    channelId: channelIdSchema,
    ...rangeSchema,
    groupBy: z.enum(['day', 'month', 'video', 'country', 'none']).default('none'),
    currency: z.string().length(3).optional().describe('e.g. "AUD" (default USD).'),
    limit: z.number().int().min(1).max(200).default(50),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    let rows: Row[];
    try {
      rows = await runReport(apis, {
        ids: channelIds(ctx, args.channelId),
        startDate: args.startDate,
        endDate: args.endDate,
        dimensions: args.groupBy === 'none' ? undefined : args.groupBy,
        metrics:
          'estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm,playbackBasedCpm,monetizedPlaybacks',
        sort:
          args.groupBy === 'video' || args.groupBy === 'country'
            ? '-estimatedRevenue'
            : args.groupBy === 'none'
              ? undefined
              : args.groupBy,
        maxResults: args.groupBy === 'video' || args.groupBy === 'country' ? args.limit : undefined,
        currency: args.currency,
      });
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 403) {
        throw new AccessDeniedError(
          'Revenue metrics are only available for monetized channels (YouTube Partner Program) and need the yt-analytics-monetary scope. Reconnect Google on /setup if the channel is monetized.',
        );
      }
      throw error;
    }
    if (args.groupBy === 'video') {
      const titles = await videoTitles(
        apis,
        rows.map((r) => String(r.video)),
      );
      rows = rows.map((r) => ({ video: r.video, title: titles.get(String(r.video)) ?? '', ...r }));
    }
    return tableResult(
      `Revenue ${resolveDate(args.startDate)} → ${resolveDate(args.endDate)}${args.currency ? ` (${args.currency})` : ''}`,
      rows,
    );
  },
});

export const ytUpdateVideoMetadata = defineTool({
  name: 'yt_update_video_metadata',
  title: 'Update YouTube video metadata',
  description:
    "Updates a video's title, description, tags, category or default language. Only the fields you pass change; everything else is kept. Changes are public immediately on published videos.",
  access: 'write',
  toolset: 'youtube',
  idempotent: true,
  inputSchema: {
    videoId: videoIdSchema,
    title: z.string().min(1).max(100).optional(),
    description: z.string().max(5000).optional(),
    tags: z
      .array(z.string())
      .max(500)
      .optional()
      .describe('Replaces all tags (total under 500 characters).'),
    categoryId: z
      .string()
      .regex(/^\d+$/)
      .optional()
      .describe('e.g. "22" People & Blogs, "27" Education, "28" Science & Technology.'),
    defaultLanguage: z.string().optional().describe('BCP-47, e.g. "en-AU".'),
  },
  handler: async (args, ctx) => {
    const { videoId, ...changes } = args;
    if (Object.values(changes).every((v) => v === undefined)) {
      throw new ToolInputError(
        'Provide at least one of title, description, tags, categoryId, defaultLanguage.',
      );
    }
    const apis = await ctx.apis();
    const current = (await apis.youtube.videos.list({ part: ['snippet'], id: [videoId] })).data
      .items?.[0];
    if (!current?.snippet)
      throw new ToolInputError(`Video ${videoId} not found or not owned by the connected account.`);
    ctx.policy.assertChannel(current.snippet.channelId!, 'write');
    const s = current.snippet;
    const snippet: youtube_v3.Schema$VideoSnippet = {
      title: changes.title ?? s.title,
      description: changes.description ?? s.description,
      tags: changes.tags ?? s.tags,
      categoryId: changes.categoryId ?? s.categoryId,
      defaultLanguage: changes.defaultLanguage ?? s.defaultLanguage,
    };
    const res = await apis.youtube.videos.update({
      part: ['snippet'],
      requestBody: { id: videoId, snippet },
    });
    const changed = Object.keys(changes).filter(
      (k) => changes[k as keyof typeof changes] !== undefined,
    );
    return jsonResult(`Updated ${changed.join(', ')} on video ${videoId}`, {
      title: res.data.snippet?.title,
      tags: res.data.snippet?.tags,
      categoryId: res.data.snippet?.categoryId,
    });
  },
});

export const youtubeTools = [
  ytListChannels,
  ytListVideos,
  ytGetVideo,
  ytReport,
  ytTopVideos,
  ytTrafficSources,
  ytAudience,
  ytVideoRetention,
  ytRevenue,
  ytUpdateVideoMetadata,
];
