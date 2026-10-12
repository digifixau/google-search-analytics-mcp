import { z } from 'zod';
import type { tagmanager_v2 } from 'googleapis';
import type { GoogleApis } from '../google/clients.js';
import { AccessDeniedError, ToolInputError } from '../util/errors.js';
import { jsonResult, markdownTable, tableResult, textResult, type Row } from '../util/output.js';
import { defineTool, type ToolContext } from './registry.js';

type Tag = tagmanager_v2.Schema$Tag;
type Trigger = tagmanager_v2.Schema$Trigger;
type Variable = tagmanager_v2.Schema$Variable;

const CONTAINER_PATH = /^accounts\/(\d+)\/containers\/(\d+)(?:\/|$)/;
const WORKSPACE_PATH = /^(accounts\/\d+\/containers\/\d+\/workspaces\/\d+)(?:\/|$)/;

export const containerPathSchema = z
  .string()
  .regex(CONTAINER_PATH, 'Expected a GTM path like accounts/123/containers/456')
  .describe('GTM container path, e.g. "accounts/123/containers/456" (see gtm_list_containers).');

export const workspaceOrContainerPathSchema = z
  .string()
  .regex(CONTAINER_PATH, 'Expected a GTM path like accounts/123/containers/456[/workspaces/7]')
  .describe(
    'Workspace path ("accounts/123/containers/456/workspaces/7") or a container path to use its Default Workspace.',
  );

/**
 * Parses a GTM resource path and enforces the container allowlist.
 * When an allowlist is configured, the container is looked up so public IDs (GTM-XXXX) match too.
 */
export async function checkContainer(
  ctx: ToolContext,
  apis: GoogleApis,
  path: string,
  mode: 'read' | 'write' = 'read',
): Promise<{ accountId: string; containerId: string; containerPath: string; publicId?: string }> {
  const match = CONTAINER_PATH.exec(path);
  if (!match)
    throw new ToolInputError(`"${path}" is not a GTM path (accounts/{id}/containers/{id}/...)`);
  const [, accountId, containerId] = match as unknown as [string, string, string];
  const containerPath = `accounts/${accountId}/containers/${containerId}`;
  let publicId: string | undefined;
  if (ctx.policy.hasContainerAllowlist) {
    const res = await apis.tagmanager.accounts.containers.get({ path: containerPath });
    publicId = res.data.publicId ?? undefined;
    if (!ctx.policy.containerAllowed(containerId, publicId, mode)) {
      throw new AccessDeniedError(
        `GTM container ${publicId ?? containerId} is not in the ${mode === 'write' ? 'write ' : ''}allowlist.`,
      );
    }
  }
  return { accountId, containerId, containerPath, publicId };
}

/** Returns the workspace path; a bare container path resolves to its Default Workspace. */
export async function resolveWorkspace(apis: GoogleApis, path: string): Promise<string> {
  const ws = WORKSPACE_PATH.exec(path);
  if (ws) return ws[1]!;
  const containerPath = CONTAINER_PATH.exec(path)![0].replace(/\/$/, '');
  const res = await apis.tagmanager.accounts.containers.workspaces.list({ parent: containerPath });
  const workspaces = res.data.workspace ?? [];
  const chosen = workspaces.find((w) => w.name === 'Default Workspace') ?? workspaces[0];
  if (!chosen?.path) throw new ToolInputError(`Container ${containerPath} has no workspaces.`);
  return chosen.path;
}

async function listAllPages<T>(
  fetchPage: (pageToken?: string) => Promise<{ items?: T[]; nextPageToken?: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    items.push(...(page.items ?? []));
    token = page.nextPageToken ?? undefined;
  } while (token && items.length < 5000);
  return items;
}

export async function loadWorkspaceEntities(apis: GoogleApis, workspacePath: string) {
  const ws = apis.tagmanager.accounts.containers.workspaces;
  const [tags, triggers, variables, builtIns] = await Promise.all([
    listAllPages(async (pageToken) => {
      const r = await ws.tags.list({ parent: workspacePath, pageToken });
      return { items: r.data.tag, nextPageToken: r.data.nextPageToken };
    }),
    listAllPages(async (pageToken) => {
      const r = await ws.triggers.list({ parent: workspacePath, pageToken });
      return { items: r.data.trigger, nextPageToken: r.data.nextPageToken };
    }),
    listAllPages(async (pageToken) => {
      const r = await ws.variables.list({ parent: workspacePath, pageToken });
      return { items: r.data.variable, nextPageToken: r.data.nextPageToken };
    }),
    listAllPages(async (pageToken) => {
      const r = await ws.built_in_variables.list({ parent: workspacePath, pageToken });
      return { items: r.data.builtInVariable, nextPageToken: r.data.nextPageToken };
    }),
  ]);
  return { tags, triggers, variables, builtIns };
}

/** Flattens a GTM parameter list into `key=value` pairs for compact display. */
function paramSummary(params: tagmanager_v2.Schema$Parameter[] | undefined, max = 4): string {
  return (params ?? [])
    .filter((p) => p.value !== undefined && p.value !== null && p.value !== '')
    .slice(0, max)
    .map((p) => `${p.key}=${String(p.value).slice(0, 60)}`)
    .join('; ');
}

const MEASUREMENT_ID = /\bG-[A-Z0-9]{6,12}\b/g;

export function findMeasurementIds(value: unknown): string[] {
  return [...new Set(JSON.stringify(value ?? '').match(MEASUREMENT_ID) ?? [])];
}

export interface AuditFindings {
  tagsWithoutTrigger: string[];
  pausedTags: string[];
  unusedTriggers: string[];
  unusedVariables: string[];
  duplicateTagNames: string[];
  measurementIds: string[];
}

/** Static checks over a workspace's tags, triggers and variables. */
export function auditEntities(
  tags: Tag[],
  triggers: Trigger[],
  variables: Variable[],
): AuditFindings {
  const usedTriggerIds = new Set(
    tags.flatMap((t) => [...(t.firingTriggerId ?? []), ...(t.blockingTriggerId ?? [])]),
  );
  const everything = JSON.stringify({ tags, triggers, variables });
  const nameCounts = new Map<string, number>();
  for (const t of tags) nameCounts.set(t.name ?? '', (nameCounts.get(t.name ?? '') ?? 0) + 1);
  return {
    tagsWithoutTrigger: tags.filter((t) => !t.firingTriggerId?.length).map((t) => t.name ?? '?'),
    pausedTags: tags.filter((t) => t.paused).map((t) => t.name ?? '?'),
    unusedTriggers: triggers
      .filter((t) => !usedTriggerIds.has(t.triggerId ?? ''))
      .map((t) => t.name ?? '?'),
    // A variable is used if any entity references it as {{Name}} (its own definition does not count).
    unusedVariables: variables
      .filter((v) => everything.split(`{{${v.name}}}`).length - 1 === 0)
      .map((v) => v.name ?? '?'),
    duplicateTagNames: [...nameCounts].filter(([, n]) => n > 1).map(([name]) => name),
    measurementIds: findMeasurementIds({ tags, variables }),
  };
}

export const gtmListContainers = defineTool({
  name: 'gtm_list_containers',
  title: 'List GTM containers',
  description:
    'Lists Google Tag Manager accounts and containers (public ID GTM-XXXX, name, usage context and path). Use the path with other gtm_* tools.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: {},
  handler: async (_args, ctx) => {
    const apis = await ctx.apis();
    const accounts = (await apis.tagmanager.accounts.list()).data.account ?? [];
    const rows: Row[] = [];
    for (const account of accounts) {
      const containers =
        (await apis.tagmanager.accounts.containers.list({ parent: account.path! })).data
          .container ?? [];
      for (const c of containers) {
        if (!ctx.policy.containerAllowed(c.containerId ?? '', c.publicId ?? undefined)) continue;
        rows.push({
          account: account.name,
          publicId: c.publicId,
          container: c.name,
          usage: (c.usageContext ?? []).join(','),
          domains: (c.domainName ?? []).join(','),
          path: c.path,
        });
      }
    }
    return tableResult(`GTM containers (${rows.length})`, rows);
  },
});

export const gtmListWorkspaces = defineTool({
  name: 'gtm_list_workspaces',
  title: 'List GTM workspaces',
  description:
    'Lists workspaces in a GTM container. Changes are made in a workspace, then turned into a version.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: { containerPath: containerPathSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const { containerPath } = await checkContainer(ctx, apis, args.containerPath);
    const res = await apis.tagmanager.accounts.containers.workspaces.list({
      parent: containerPath,
    });
    return tableResult(
      `Workspaces in ${containerPath}`,
      (res.data.workspace ?? []).map((w) => ({
        name: w.name,
        description: w.description,
        path: w.path,
      })),
    );
  },
});

export const gtmWorkspaceStatus = defineTool({
  name: 'gtm_workspace_status',
  title: 'GTM workspace changes',
  description:
    'Shows unpublished changes in a workspace (added/updated/deleted tags, triggers, variables) and merge conflicts.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: { path: workspaceOrContainerPathSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    await checkContainer(ctx, apis, args.path);
    const workspacePath = await resolveWorkspace(apis, args.path);
    const res = await apis.tagmanager.accounts.containers.workspaces.getStatus({
      path: workspacePath,
    });
    const rows = (res.data.workspaceChange ?? []).map((c) => {
      const entity = c.tag ?? c.trigger ?? c.variable ?? c.folder ?? c.client ?? c.zone;
      const kind = c.tag ? 'tag' : c.trigger ? 'trigger' : c.variable ? 'variable' : 'other';
      return {
        change: c.changeStatus,
        kind,
        name: (entity as { name?: string } | undefined)?.name ?? '',
      };
    });
    const conflicts = res.data.mergeConflict?.length ?? 0;
    return tableResult(`Pending changes in ${workspacePath} (${rows.length})`, rows, {
      notes: conflicts
        ? [`${conflicts} merge conflict(s): resolve them in the GTM UI before creating a version.`]
        : [],
    });
  },
});

export const gtmListTags = defineTool({
  name: 'gtm_list_tags',
  title: 'List GTM tags',
  description:
    'Lists tags in a workspace with type, firing/blocking triggers, paused state and key parameters.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: { path: workspaceOrContainerPathSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    await checkContainer(ctx, apis, args.path);
    const workspacePath = await resolveWorkspace(apis, args.path);
    const { tags, triggers } = await loadWorkspaceEntities(apis, workspacePath);
    const triggerNames = new Map(triggers.map((t) => [t.triggerId, t.name]));
    const names = (ids: string[] | null | undefined) =>
      (ids ?? [])
        .map((id) => triggerNames.get(id) ?? (id === '2147479553' ? 'All Pages' : id))
        .join(', ');
    return tableResult(
      `Tags in ${workspacePath} (${tags.length})`,
      tags.map((t) => ({
        name: t.name,
        type: t.type,
        firing: names(t.firingTriggerId),
        blocking: names(t.blockingTriggerId),
        paused: t.paused ? 'yes' : '',
        params: paramSummary(t.parameter),
        path: t.path,
      })),
    );
  },
});

export const gtmListTriggers = defineTool({
  name: 'gtm_list_triggers',
  title: 'List GTM triggers',
  description: 'Lists triggers in a workspace with their type and conditions.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: { path: workspaceOrContainerPathSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    await checkContainer(ctx, apis, args.path);
    const workspacePath = await resolveWorkspace(apis, args.path);
    const { triggers } = await loadWorkspaceEntities(apis, workspacePath);
    const conditions = (t: Trigger) =>
      [...(t.customEventFilter ?? []), ...(t.filter ?? []), ...(t.autoEventFilter ?? [])]
        .map((f) => `${f.type}(${paramSummary(f.parameter, 2)})`)
        .join(' AND ');
    return tableResult(
      `Triggers in ${workspacePath} (${triggers.length})`,
      triggers.map((t) => ({
        id: t.triggerId,
        name: t.name,
        type: t.type,
        conditions: conditions(t),
        path: t.path,
      })),
    );
  },
});

export const gtmListVariables = defineTool({
  name: 'gtm_list_variables',
  title: 'List GTM variables',
  description: 'Lists user-defined variables and enabled built-in variables in a workspace.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: { path: workspaceOrContainerPathSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    await checkContainer(ctx, apis, args.path);
    const workspacePath = await resolveWorkspace(apis, args.path);
    const { variables, builtIns } = await loadWorkspaceEntities(apis, workspacePath);
    return textResult(
      [
        `Variables in ${workspacePath}`,
        '',
        `## User-defined (${variables.length})`,
        markdownTable(
          variables.map((v) => ({
            name: v.name,
            type: v.type,
            params: paramSummary(v.parameter),
            path: v.path,
          })),
        ),
        '',
        `## Built-in enabled (${builtIns.length})`,
        builtIns.map((b) => b.name).join(', ') || '_None._',
      ].join('\n'),
    );
  },
});

export const gtmGetEntity = defineTool({
  name: 'gtm_get_entity',
  title: 'Get GTM tag/trigger/variable',
  description:
    'Returns the full JSON of a tag, trigger or variable (including fingerprint and all parameters) by its path.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: {
    path: z
      .string()
      .regex(/^accounts\/\d+\/containers\/\d+\/workspaces\/\d+\/(tags|triggers|variables)\/\d+$/)
      .describe('e.g. "accounts/1/containers/2/workspaces/3/tags/4"'),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    await checkContainer(ctx, apis, args.path);
    const ws = apis.tagmanager.accounts.containers.workspaces;
    const kind = /\/(tags|triggers|variables)\//.exec(args.path)![1];
    const res =
      kind === 'tags'
        ? await ws.tags.get({ path: args.path })
        : kind === 'triggers'
          ? await ws.triggers.get({ path: args.path })
          : await ws.variables.get({ path: args.path });
    return jsonResult(`GTM ${kind!.slice(0, -1)} ${args.path}`, res.data);
  },
});

export const gtmListVersions = defineTool({
  name: 'gtm_list_versions',
  title: 'List GTM versions',
  description:
    'Lists container versions (newest first) with counts of tags/triggers/variables, and marks the live version.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: {
    containerPath: containerPathSchema,
    limit: z.number().int().min(1).max(200).default(20),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const { containerPath } = await checkContainer(ctx, apis, args.containerPath);
    const [headers, live] = await Promise.all([
      apis.tagmanager.accounts.containers.version_headers.list({ parent: containerPath }),
      apis.tagmanager.accounts.containers.versions
        .live({ parent: containerPath })
        .catch(() => undefined),
    ]);
    const liveId = live?.data.containerVersionId;
    const rows = (headers.data.containerVersionHeader ?? [])
      .filter((h) => !h.deleted)
      .sort((a, b) => Number(b.containerVersionId) - Number(a.containerVersionId))
      .slice(0, args.limit)
      .map((h) => ({
        version: h.containerVersionId,
        name: h.name,
        live: h.containerVersionId === liveId ? 'LIVE' : '',
        tags: h.numTags,
        triggers: h.numTriggers,
        variables: h.numVariables,
        path: h.path,
      }));
    return tableResult(`Versions of ${containerPath}`, rows);
  },
});

export const gtmGetLiveVersion = defineTool({
  name: 'gtm_get_live_version',
  title: 'Get live GTM version',
  description:
    'Summarises the currently published (live) version of a container: tags with triggers, and GA4 measurement IDs in use.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: { containerPath: containerPathSchema },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const { containerPath } = await checkContainer(ctx, apis, args.containerPath);
    const v = (await apis.tagmanager.accounts.containers.versions.live({ parent: containerPath }))
      .data;
    const triggerNames = new Map((v.trigger ?? []).map((t) => [t.triggerId, t.name]));
    const rows = (v.tag ?? []).map((t) => ({
      tag: t.name,
      type: t.type,
      firing: (t.firingTriggerId ?? [])
        .map((id) => triggerNames.get(id) ?? (id === '2147479553' ? 'All Pages' : id))
        .join(', '),
      paused: t.paused ? 'yes' : '',
    }));
    return tableResult(
      `Live version ${v.containerVersionId} "${v.name ?? ''}" of ${containerPath}`,
      rows,
      {
        notes: [
          `${v.tag?.length ?? 0} tags, ${v.trigger?.length ?? 0} triggers, ${v.variable?.length ?? 0} variables.`,
          `GA4 measurement IDs referenced: ${findMeasurementIds({ tag: v.tag, variable: v.variable }).join(', ') || 'none'}.`,
        ],
      },
    );
  },
});

async function knownMeasurementIds(apis: GoogleApis): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  const summaries =
    (await apis.analyticsAdmin.accountSummaries.list({ pageSize: 200 })).data.accountSummaries ??
    [];
  const properties = summaries.flatMap((a) => a.propertySummaries ?? []).slice(0, 50);
  await Promise.all(
    properties.map(async (p) => {
      const streams = await apis.analyticsAdmin.properties.dataStreams
        .list({ parent: p.property!, pageSize: 50 })
        .catch(() => undefined);
      for (const s of streams?.data.dataStreams ?? []) {
        const id = s.webStreamData?.measurementId;
        if (id) known.set(id, `${p.displayName} (${p.property?.replace('properties/', '')})`);
      }
    }),
  );
  return known;
}

export const gtmAuditContainer = defineTool({
  name: 'gtm_audit_container',
  title: 'Audit GTM container',
  description:
    'Health check for a GTM workspace: tags with no firing trigger, paused tags, unused triggers and variables, duplicate tag names, and GA4 measurement IDs (G-XXXX) cross-checked against the GA4 properties this server can see.',
  access: 'read',
  toolset: 'gtm',
  inputSchema: {
    path: workspaceOrContainerPathSchema,
    checkGa4: z
      .boolean()
      .default(true)
      .describe('Cross-check measurement IDs against GA4 data streams.'),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    await checkContainer(ctx, apis, args.path);
    const workspacePath = await resolveWorkspace(apis, args.path);
    const { tags, triggers, variables } = await loadWorkspaceEntities(apis, workspacePath);
    const f = auditEntities(tags, triggers, variables);

    let ga4Lines: string[];
    if (f.measurementIds.length && args.checkGa4 && ctx.config.enabledServices.includes('ga4')) {
      try {
        const known = await knownMeasurementIds(apis);
        ga4Lines = f.measurementIds.map((id) =>
          known.has(id)
            ? `- ${id} → GA4 ${known.get(id)}`
            : `- ${id} → ⚠️ not found in any GA4 property this account can access`,
        );
      } catch {
        ga4Lines = ['- Could not read GA4 data streams to cross-check.'];
      }
    } else {
      ga4Lines = f.measurementIds.map((id) => `- ${id}`);
    }

    const section = (title: string, items: string[]) =>
      `## ${title} (${items.length})\n${items.length ? items.map((i) => `- ${i}`).join('\n') : '_None._'}`;
    return textResult(
      [
        `# GTM audit: ${workspacePath}`,
        `${tags.length} tags, ${triggers.length} triggers, ${variables.length} user-defined variables.`,
        section('Tags without a firing trigger', f.tagsWithoutTrigger),
        section('Paused tags', f.pausedTags),
        section('Unused triggers', f.unusedTriggers),
        section('Unused variables', f.unusedVariables),
        section('Duplicate tag names', f.duplicateTagNames),
        `## GA4 measurement IDs (${f.measurementIds.length})\n${ga4Lines.join('\n') || '_None found._'}`,
      ].join('\n\n'),
    );
  },
});

export const gtmReadTools = [
  gtmListContainers,
  gtmListWorkspaces,
  gtmWorkspaceStatus,
  gtmListTags,
  gtmListTriggers,
  gtmListVariables,
  gtmGetEntity,
  gtmListVersions,
  gtmGetLiveVersion,
  gtmAuditContainer,
];
