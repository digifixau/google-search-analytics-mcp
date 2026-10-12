import { z } from 'zod';
import type { tagmanager_v2 } from 'googleapis';
import type { GoogleApis } from '../google/clients.js';
import { ToolInputError } from '../util/errors.js';
import { jsonResult, textResult } from '../util/output.js';
import {
  checkContainer,
  containerPathSchema,
  resolveWorkspace,
  workspaceOrContainerPathSchema,
} from './gtm.js';
import { defineTool } from './registry.js';

type Kind = 'tag' | 'trigger' | 'variable';
const PLURAL: Record<Kind, 'tags' | 'triggers' | 'variables'> = {
  tag: 'tags',
  trigger: 'triggers',
  variable: 'variables',
};

const EXAMPLES: Record<Kind, string> = {
  tag: '{"name":"GA4 - generate_lead","type":"gaawe","parameter":[{"type":"template","key":"eventName","value":"generate_lead"},{"type":"template","key":"measurementIdOverride","value":"G-XXXXXXX"}],"firingTriggerId":["12"]}',
  trigger:
    '{"name":"Form submit - contact","type":"formSubmission","filter":[{"type":"contains","parameter":[{"type":"template","key":"arg0","value":"{{Page Path}}"},{"type":"template","key":"arg1","value":"/contact"}]}]}',
  variable:
    '{"name":"DLV - form_id","type":"v","parameter":[{"type":"integer","key":"dataLayerVersion","value":"2"},{"type":"template","key":"name","value":"form_id"}]}',
};

const entityPath = (kind: Kind) =>
  z
    .string()
    .regex(new RegExp(`^accounts/\\d+/containers/\\d+/workspaces/\\d+/${PLURAL[kind]}/\\d+$`))
    .describe(`Full ${kind} path, e.g. "accounts/1/containers/2/workspaces/3/${PLURAL[kind]}/4".`);

const entityBody = (kind: Kind) =>
  z
    .record(z.string(), z.unknown())
    .describe(`GTM API ${kind} resource. Example: ${EXAMPLES[kind]}`);

function resource(apis: GoogleApis, kind: Kind) {
  const ws = apis.tagmanager.accounts.containers.workspaces;
  return (kind === 'tag'
    ? ws.tags
    : kind === 'trigger'
      ? ws.triggers
      : ws.variables) as unknown as {
    create(p: {
      parent: string;
      requestBody: object;
    }): Promise<{ data: { name?: string | null; path?: string | null } }>;
    get(p: {
      path: string;
    }): Promise<{ data: Record<string, unknown> & { fingerprint?: string | null } }>;
    update(p: {
      path: string;
      fingerprint?: string;
      requestBody: object;
    }): Promise<{ data: object }>;
    delete(p: { path: string }): Promise<unknown>;
  };
}

function entityTools(kind: Kind) {
  const cap = kind[0]!.toUpperCase() + kind.slice(1);
  const create = defineTool({
    name: `gtm_create_${kind}`,
    title: `Create GTM ${kind}`,
    description: `Creates a ${kind} in a GTM workspace (not live until a version is created and published).`,
    access: 'write',
    toolset: 'gtm',
    inputSchema: { path: workspaceOrContainerPathSchema, resource: entityBody(kind) },
    handler: async (args, ctx) => {
      const apis = await ctx.apis();
      await checkContainer(ctx, apis, args.path, 'write');
      const parent = await resolveWorkspace(apis, args.path);
      const res = await resource(apis, kind).create({ parent, requestBody: args.resource });
      return jsonResult(`Created ${kind} "${res.data.name}" in ${parent}`, res.data);
    },
  });

  const update = defineTool({
    name: `gtm_update_${kind}`,
    title: `Update GTM ${kind}`,
    description: `Updates a GTM ${kind}. Provided fields are merged over the current ${kind}; the current fingerprint is used so concurrent edits fail instead of being overwritten.`,
    access: 'write',
    toolset: 'gtm',
    idempotent: true,
    inputSchema: { path: entityPath(kind), changes: entityBody(kind) },
    handler: async (args, ctx) => {
      const apis = await ctx.apis();
      await checkContainer(ctx, apis, args.path, 'write');
      const api = resource(apis, kind);
      const current = (await api.get({ path: args.path })).data;
      const res = await api.update({
        path: args.path,
        fingerprint: current.fingerprint ?? undefined,
        requestBody: { ...current, ...args.changes },
      });
      return jsonResult(`Updated ${kind} ${args.path}`, res.data);
    },
  });

  const remove = defineTool({
    name: `gtm_delete_${kind}`,
    title: `Delete GTM ${kind}`,
    description: `Deletes a ${kind} from a GTM workspace (the live site is unaffected until a new version is published).`,
    access: 'write',
    toolset: 'gtm',
    destructive: true,
    idempotent: true,
    inputSchema: { path: entityPath(kind) },
    handler: async (args, ctx) => {
      const apis = await ctx.apis();
      await checkContainer(ctx, apis, args.path, 'write');
      await resource(apis, kind).delete({ path: args.path });
      return textResult(`Deleted ${cap.toLowerCase()} ${args.path}.`);
    },
  });

  return [create, update, remove];
}

export const gtmCreateWorkspace = defineTool({
  name: 'gtm_create_workspace',
  title: 'Create GTM workspace',
  description:
    'Creates a new workspace in a container, so changes can be prepared without touching the Default Workspace.',
  access: 'write',
  toolset: 'gtm',
  inputSchema: {
    containerPath: containerPathSchema,
    name: z.string().min(1),
    description: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const { containerPath } = await checkContainer(ctx, apis, args.containerPath, 'write');
    const res = await apis.tagmanager.accounts.containers.workspaces.create({
      parent: containerPath,
      requestBody: { name: args.name, description: args.description },
    });
    return jsonResult('Created workspace', res.data);
  },
});

export const gtmCreateVersion = defineTool({
  name: 'gtm_create_version',
  title: 'Create GTM version',
  description:
    'Turns a workspace into a new container version (a saved snapshot). It does NOT go live; use gtm_publish_version for that. GTM removes the workspace afterwards and starts a fresh one.',
  access: 'write',
  toolset: 'gtm',
  inputSchema: {
    path: workspaceOrContainerPathSchema,
    name: z.string().min(1).describe('Version name, e.g. "Add generate_lead event".'),
    notes: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    await checkContainer(ctx, apis, args.path, 'write');
    const workspacePath = await resolveWorkspace(apis, args.path);
    const res = await apis.tagmanager.accounts.containers.workspaces.create_version({
      path: workspacePath,
      requestBody: { name: args.name, notes: args.notes },
    });
    if (res.data.compilerError) {
      throw new ToolInputError(
        'GTM reported a compiler error; fix the workspace (see gtm_workspace_status) and retry.',
      );
    }
    if (res.data.syncStatus?.mergeConflict) {
      throw new ToolInputError(
        'The workspace has merge conflicts; resolve them in the GTM UI first.',
      );
    }
    const v = res.data.containerVersion;
    return textResult(
      [
        `Created version ${v?.containerVersionId} "${v?.name}" (not live).`,
        `Version path: ${v?.path}`,
        res.data.newWorkspacePath ? `New workspace: ${res.data.newWorkspacePath}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
});

export const gtmPublishVersion = defineTool({
  name: 'gtm_publish_version',
  title: 'Publish GTM version (LIVE)',
  description:
    'Publishes a container version so it runs on the LIVE website immediately. Always confirm with the user first. Requires confirmContainerPublicId to equal the container public ID (GTM-XXXX) as a safety check. Returns the previously live version so it can be re-published to roll back.',
  access: 'write',
  toolset: 'gtm_publish',
  destructive: true,
  inputSchema: {
    versionPath: z
      .string()
      .regex(/^accounts\/\d+\/containers\/\d+\/versions\/\d+$/)
      .describe(
        'Version path, e.g. "accounts/1/containers/2/versions/15" (see gtm_list_versions).',
      ),
    confirmContainerPublicId: z
      .string()
      .describe('Type the container public ID (GTM-XXXX) to confirm publishing.'),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const { containerPath } = await checkContainer(ctx, apis, args.versionPath, 'write');
    const container = (await apis.tagmanager.accounts.containers.get({ path: containerPath })).data;
    if (
      !container.publicId ||
      container.publicId.toUpperCase() !== args.confirmContainerPublicId.trim().toUpperCase()
    ) {
      throw new ToolInputError(
        `confirmContainerPublicId "${args.confirmContainerPublicId}" does not match this container (${container.publicId}). Nothing was published.`,
      );
    }
    const previous = await apis.tagmanager.accounts.containers.versions
      .live({ parent: containerPath })
      .then((r) => r.data as tagmanager_v2.Schema$ContainerVersion)
      .catch(() => undefined);
    const res = await apis.tagmanager.accounts.containers.versions.publish({
      path: args.versionPath,
    });
    if (res.data.compilerError)
      throw new Error('GTM refused to publish: the version has a compiler error.');
    const live = res.data.containerVersion;
    return textResult(
      [
        `Published version ${live?.containerVersionId} "${live?.name ?? ''}" to ${container.publicId} (${container.name}). It is now LIVE.`,
        previous?.containerVersionId
          ? `Previously live: version ${previous.containerVersionId} (${previous.path}). Re-publish it to roll back.`
          : 'There was no previously live version.',
      ].join('\n'),
    );
  },
});

export const gtmWriteTools = [
  gtmCreateWorkspace,
  ...entityTools('tag'),
  ...entityTools('trigger'),
  ...entityTools('variable'),
  gtmCreateVersion,
  gtmPublishVersion,
];
