import { z } from 'zod';
import type { analyticsadmin_v1alpha } from 'googleapis';
import { ToolInputError } from '../util/errors.js';
import { jsonResult, textResult } from '../util/output.js';
import { propertyIdSchema } from './ga4.js';
import { defineTool, type ToolContext } from './registry.js';

const resourceName = (example: string) =>
  z.string().describe(`Full resource name, e.g. "${example}".`);

function parent(ctx: ToolContext, propertyId: string): string {
  return `properties/${ctx.policy.assertProperty(propertyId, 'write')}`;
}

/** Builds a PATCH body + updateMask from the provided (non-undefined) fields. */
function patch<T extends Record<string, unknown>>(
  fields: T,
): { body: Partial<T>; updateMask: string } {
  const body: Partial<T> = {};
  const mask: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      (body as Record<string, unknown>)[key] = value;
      mask.push(key);
    }
  }
  if (mask.length === 0) throw new ToolInputError('Provide at least one field to update.');
  return { body, updateMask: mask.join(',') };
}

// ---------------------------------------------------------------------------
// ga4_admin: custom definitions, key events, data retention
// ---------------------------------------------------------------------------

export const ga4CreateCustomDimension = defineTool({
  name: 'ga4_create_custom_dimension',
  title: 'Create GA4 custom dimension',
  description:
    'Registers an event/user/item parameter as a custom dimension. Note: GA4 limits standard properties to 50 event-scoped and 25 user-scoped custom dimensions, and parameterName cannot be changed later.',
  access: 'write',
  toolset: 'ga4_admin',
  inputSchema: {
    propertyId: propertyIdSchema,
    parameterName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
      .describe('Event parameter / user property name, e.g. "plan_type".'),
    displayName: z.string().min(1).max(82),
    scope: z.enum(['EVENT', 'USER', 'ITEM']).default('EVENT'),
    description: z.string().max(150).optional(),
    disallowAdsPersonalization: z.boolean().optional().describe('USER scope only.'),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.customDimensions.create({
      parent: parent(ctx, args.propertyId),
      requestBody: {
        parameterName: args.parameterName,
        displayName: args.displayName,
        scope: args.scope,
        description: args.description,
        disallowAdsPersonalization: args.disallowAdsPersonalization,
      },
    });
    return jsonResult('Created custom dimension', res.data);
  },
});

export const ga4UpdateCustomDimension = defineTool({
  name: 'ga4_update_custom_dimension',
  title: 'Update GA4 custom dimension',
  description:
    'Updates the display name, description or ads-personalisation flag of a custom dimension.',
  access: 'write',
  toolset: 'ga4_admin',
  idempotent: true,
  inputSchema: {
    name: resourceName('properties/123/customDimensions/456'),
    displayName: z.string().min(1).max(82).optional(),
    description: z.string().max(150).optional(),
    disallowAdsPersonalization: z.boolean().optional(),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const { body, updateMask } = patch({
      displayName: args.displayName,
      description: args.description,
      disallowAdsPersonalization: args.disallowAdsPersonalization,
    });
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.customDimensions.patch({
      name: args.name,
      updateMask,
      requestBody: body,
    });
    return jsonResult('Updated custom dimension', res.data);
  },
});

export const ga4ArchiveCustomDimension = defineTool({
  name: 'ga4_archive_custom_dimension',
  title: 'Archive GA4 custom dimension',
  description:
    'Archives a custom dimension. Its data stops being processed and it frees a slot; this cannot be undone via the API.',
  access: 'write',
  toolset: 'ga4_admin',
  destructive: true,
  inputSchema: { name: resourceName('properties/123/customDimensions/456') },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const apis = await ctx.apis();
    await apis.analyticsAdmin.properties.customDimensions.archive({
      name: args.name,
      requestBody: {},
    });
    return textResult(`Archived custom dimension ${args.name}.`);
  },
});

export const ga4CreateCustomMetric = defineTool({
  name: 'ga4_create_custom_metric',
  title: 'Create GA4 custom metric',
  description: 'Registers a numeric event parameter as a custom metric.',
  access: 'write',
  toolset: 'ga4_admin',
  inputSchema: {
    propertyId: propertyIdSchema,
    parameterName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
    displayName: z.string().min(1).max(82),
    measurementUnit: z
      .enum([
        'STANDARD',
        'CURRENCY',
        'FEET',
        'METERS',
        'KILOMETERS',
        'MILES',
        'MILLISECONDS',
        'SECONDS',
        'MINUTES',
        'HOURS',
      ])
      .default('STANDARD'),
    description: z.string().max(150).optional(),
    restrictedMetricType: z
      .array(z.enum(['COST_DATA', 'REVENUE_DATA']))
      .optional()
      .describe('Required for CURRENCY metrics.'),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.customMetrics.create({
      parent: parent(ctx, args.propertyId),
      requestBody: {
        parameterName: args.parameterName,
        displayName: args.displayName,
        measurementUnit: args.measurementUnit,
        scope: 'EVENT',
        description: args.description,
        restrictedMetricType: args.restrictedMetricType,
      },
    });
    return jsonResult('Created custom metric', res.data);
  },
});

export const ga4UpdateCustomMetric = defineTool({
  name: 'ga4_update_custom_metric',
  title: 'Update GA4 custom metric',
  description: 'Updates display name, description, unit or restricted type of a custom metric.',
  access: 'write',
  toolset: 'ga4_admin',
  idempotent: true,
  inputSchema: {
    name: resourceName('properties/123/customMetrics/456'),
    displayName: z.string().min(1).max(82).optional(),
    description: z.string().max(150).optional(),
    measurementUnit: z
      .enum([
        'STANDARD',
        'CURRENCY',
        'FEET',
        'METERS',
        'KILOMETERS',
        'MILES',
        'MILLISECONDS',
        'SECONDS',
        'MINUTES',
        'HOURS',
      ])
      .optional(),
    restrictedMetricType: z.array(z.enum(['COST_DATA', 'REVENUE_DATA'])).optional(),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const { body, updateMask } = patch({
      displayName: args.displayName,
      description: args.description,
      measurementUnit: args.measurementUnit,
      restrictedMetricType: args.restrictedMetricType,
    });
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.customMetrics.patch({
      name: args.name,
      updateMask,
      requestBody: body,
    });
    return jsonResult('Updated custom metric', res.data);
  },
});

export const ga4ArchiveCustomMetric = defineTool({
  name: 'ga4_archive_custom_metric',
  title: 'Archive GA4 custom metric',
  description: 'Archives a custom metric. This cannot be undone via the API.',
  access: 'write',
  toolset: 'ga4_admin',
  destructive: true,
  inputSchema: { name: resourceName('properties/123/customMetrics/456') },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const apis = await ctx.apis();
    await apis.analyticsAdmin.properties.customMetrics.archive({
      name: args.name,
      requestBody: {},
    });
    return textResult(`Archived custom metric ${args.name}.`);
  },
});

export const ga4CreateKeyEvent = defineTool({
  name: 'ga4_create_key_event',
  title: 'Create GA4 key event',
  description: 'Marks an event name as a key event (conversion), optionally with a default value.',
  access: 'write',
  toolset: 'ga4_admin',
  inputSchema: {
    propertyId: propertyIdSchema,
    eventName: z.string().min(1).max(40),
    countingMethod: z.enum(['ONCE_PER_EVENT', 'ONCE_PER_SESSION']).default('ONCE_PER_EVENT'),
    defaultValue: z.number().optional(),
    currencyCode: z
      .string()
      .length(3)
      .optional()
      .describe('Required with defaultValue, e.g. "AUD".'),
  },
  handler: async (args, ctx) => {
    if (args.defaultValue !== undefined && !args.currencyCode) {
      throw new ToolInputError('currencyCode is required when defaultValue is set.');
    }
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.keyEvents.create({
      parent: parent(ctx, args.propertyId),
      requestBody: {
        eventName: args.eventName,
        countingMethod: args.countingMethod,
        defaultValue:
          args.defaultValue !== undefined
            ? { numericValue: args.defaultValue, currencyCode: args.currencyCode }
            : undefined,
      },
    });
    return jsonResult('Created key event', res.data);
  },
});

export const ga4DeleteKeyEvent = defineTool({
  name: 'ga4_delete_key_event',
  title: 'Delete GA4 key event',
  description: 'Removes the key event marking from an event (the underlying events are kept).',
  access: 'write',
  toolset: 'ga4_admin',
  destructive: true,
  idempotent: true,
  inputSchema: { name: resourceName('properties/123/keyEvents/456') },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const apis = await ctx.apis();
    await apis.analyticsAdmin.properties.keyEvents.delete({ name: args.name });
    return textResult(`Deleted key event ${args.name}.`);
  },
});

export const ga4UpdateDataRetention = defineTool({
  name: 'ga4_update_data_retention',
  title: 'Update GA4 data retention',
  description:
    'Changes how long GA4 keeps event- and user-level data (affects Explorations, not standard reports). Shortening retention permanently deletes older data.',
  access: 'write',
  toolset: 'ga4_admin',
  destructive: true,
  idempotent: true,
  inputSchema: {
    propertyId: propertyIdSchema,
    eventDataRetention: z
      .enum([
        'TWO_MONTHS',
        'FOURTEEN_MONTHS',
        'TWENTY_SIX_MONTHS',
        'THIRTY_EIGHT_MONTHS',
        'FIFTY_MONTHS',
      ])
      .optional()
      .describe('Standard properties support TWO_MONTHS or FOURTEEN_MONTHS.'),
    userDataRetention: z
      .enum([
        'TWO_MONTHS',
        'FOURTEEN_MONTHS',
        'TWENTY_SIX_MONTHS',
        'THIRTY_EIGHT_MONTHS',
        'FIFTY_MONTHS',
      ])
      .optional(),
    resetUserDataOnNewActivity: z.boolean().optional(),
  },
  handler: async (args, ctx) => {
    const name = `${parent(ctx, args.propertyId)}/dataRetentionSettings`;
    const { body, updateMask } = patch({
      eventDataRetention: args.eventDataRetention,
      userDataRetention: args.userDataRetention,
      resetUserDataOnNewActivity: args.resetUserDataOnNewActivity,
    });
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.updateDataRetentionSettings({
      name,
      updateMask,
      requestBody: body,
    });
    return jsonResult('Updated data retention', res.data);
  },
});

// ---------------------------------------------------------------------------
// ga4_audiences_streams: audiences, data streams, Measurement Protocol secrets
// ---------------------------------------------------------------------------

export const ga4CreateAudience = defineTool({
  name: 'ga4_create_audience',
  title: 'Create GA4 audience',
  description:
    'Creates a GA4 audience (Admin API v1alpha). "audience" is a GA4 Audience object: displayName, description, membershipDurationDays (1-540) and filterClauses. Example filterClauses: [{"clauseType":"INCLUDE","simpleFilter":{"scope":"AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS","filterExpression":{"andGroup":{"filterExpressions":[{"orGroup":{"filterExpressions":[{"eventFilter":{"eventName":"purchase"}}]}}]}}}}]. Audiences only accumulate members from creation onward.',
  access: 'write',
  toolset: 'ga4_audiences_streams',
  inputSchema: {
    propertyId: propertyIdSchema,
    audience: z
      .object({
        displayName: z.string().min(1),
        description: z.string().min(1),
        membershipDurationDays: z.number().int().min(1).max(540),
        filterClauses: z.array(z.record(z.string(), z.unknown())).min(1),
        exclusionDurationMode: z.enum(['EXCLUDE_TEMPORARILY', 'EXCLUDE_PERMANENTLY']).optional(),
        eventTrigger: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  },
  handler: async (args, ctx) => {
    const apis = await ctx.apis();
    const res = await apis.analyticsAdminAlpha.properties.audiences.create({
      parent: parent(ctx, args.propertyId),
      requestBody:
        args.audience as analyticsadmin_v1alpha.Schema$GoogleAnalyticsAdminV1alphaAudience,
    });
    return jsonResult('Created audience', res.data);
  },
});

export const ga4UpdateAudience = defineTool({
  name: 'ga4_update_audience',
  title: 'Update GA4 audience',
  description: 'Updates an audience display name, description or membership duration.',
  access: 'write',
  toolset: 'ga4_audiences_streams',
  idempotent: true,
  inputSchema: {
    name: resourceName('properties/123/audiences/456'),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    membershipDurationDays: z.number().int().min(1).max(540).optional(),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const { body, updateMask } = patch({
      displayName: args.displayName,
      description: args.description,
      membershipDurationDays: args.membershipDurationDays,
    });
    const apis = await ctx.apis();
    const res = await apis.analyticsAdminAlpha.properties.audiences.patch({
      name: args.name,
      updateMask,
      requestBody: body,
    });
    return jsonResult('Updated audience', res.data);
  },
});

export const ga4ArchiveAudience = defineTool({
  name: 'ga4_archive_audience',
  title: 'Archive GA4 audience',
  description: 'Archives an audience. Linked Google Ads remarketing lists stop updating.',
  access: 'write',
  toolset: 'ga4_audiences_streams',
  destructive: true,
  inputSchema: { name: resourceName('properties/123/audiences/456') },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const apis = await ctx.apis();
    await apis.analyticsAdminAlpha.properties.audiences.archive({
      name: args.name,
      requestBody: {},
    });
    return textResult(`Archived audience ${args.name}.`);
  },
});

export const ga4CreateDataStream = defineTool({
  name: 'ga4_create_data_stream',
  title: 'Create GA4 data stream',
  description:
    'Creates a web, Android or iOS data stream on a GA4 property. For web streams the response includes the new measurement ID (G-XXXX).',
  access: 'write',
  toolset: 'ga4_audiences_streams',
  inputSchema: {
    propertyId: propertyIdSchema,
    type: z
      .enum(['WEB_DATA_STREAM', 'ANDROID_APP_DATA_STREAM', 'IOS_APP_DATA_STREAM'])
      .default('WEB_DATA_STREAM'),
    displayName: z.string().min(1),
    defaultUri: z
      .string()
      .url()
      .optional()
      .describe('Web streams: site URL, e.g. https://www.example.com'),
    packageName: z.string().optional().describe('Android streams.'),
    bundleId: z.string().optional().describe('iOS streams.'),
  },
  handler: async (args, ctx) => {
    const requestBody: Record<string, unknown> = { type: args.type, displayName: args.displayName };
    if (args.type === 'WEB_DATA_STREAM') {
      if (!args.defaultUri) throw new ToolInputError('defaultUri is required for web streams.');
      requestBody.webStreamData = { defaultUri: args.defaultUri };
    } else if (args.type === 'ANDROID_APP_DATA_STREAM') {
      if (!args.packageName)
        throw new ToolInputError('packageName is required for Android streams.');
      requestBody.androidAppStreamData = { packageName: args.packageName };
    } else {
      if (!args.bundleId) throw new ToolInputError('bundleId is required for iOS streams.');
      requestBody.iosAppStreamData = { bundleId: args.bundleId };
    }
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.dataStreams.create({
      parent: parent(ctx, args.propertyId),
      requestBody,
    });
    return jsonResult('Created data stream', res.data);
  },
});

export const ga4UpdateDataStream = defineTool({
  name: 'ga4_update_data_stream',
  title: 'Update GA4 data stream',
  description: 'Renames a data stream.',
  access: 'write',
  toolset: 'ga4_audiences_streams',
  idempotent: true,
  inputSchema: {
    name: resourceName('properties/123/dataStreams/456'),
    displayName: z.string().min(1),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.dataStreams.patch({
      name: args.name,
      updateMask: 'displayName',
      requestBody: { displayName: args.displayName },
    });
    return jsonResult('Updated data stream', res.data);
  },
});

export const ga4DeleteDataStream = defineTool({
  name: 'ga4_delete_data_stream',
  title: 'Delete GA4 data stream',
  description:
    'Deletes a data stream. Data collection from that site/app stops immediately. Irreversible.',
  access: 'write',
  toolset: 'ga4_audiences_streams',
  destructive: true,
  idempotent: true,
  inputSchema: { name: resourceName('properties/123/dataStreams/456') },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const apis = await ctx.apis();
    await apis.analyticsAdmin.properties.dataStreams.delete({ name: args.name });
    return textResult(`Deleted data stream ${args.name}.`);
  },
});

export const ga4CreateMeasurementProtocolSecret = defineTool({
  name: 'ga4_create_measurement_protocol_secret',
  title: 'Create Measurement Protocol secret',
  description:
    'Creates a Measurement Protocol API secret on a data stream (for server-side event sending). The secret value is returned once.',
  access: 'write',
  toolset: 'ga4_audiences_streams',
  inputSchema: {
    streamName: resourceName('properties/123/dataStreams/456'),
    displayName: z.string().min(1),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.streamName, 'write');
    const apis = await ctx.apis();
    const res = await apis.analyticsAdmin.properties.dataStreams.measurementProtocolSecrets.create({
      parent: args.streamName,
      requestBody: { displayName: args.displayName },
    });
    return jsonResult('Created Measurement Protocol secret', res.data);
  },
});

export const ga4DeleteMeasurementProtocolSecret = defineTool({
  name: 'ga4_delete_measurement_protocol_secret',
  title: 'Delete Measurement Protocol secret',
  description:
    'Deletes a Measurement Protocol secret. Any server sending events with it will stop being accepted.',
  access: 'write',
  toolset: 'ga4_audiences_streams',
  destructive: true,
  idempotent: true,
  inputSchema: {
    name: resourceName('properties/123/dataStreams/456/measurementProtocolSecrets/789'),
  },
  handler: async (args, ctx) => {
    ctx.policy.assertResourceName(args.name, 'write');
    const apis = await ctx.apis();
    await apis.analyticsAdmin.properties.dataStreams.measurementProtocolSecrets.delete({
      name: args.name,
    });
    return textResult(`Deleted Measurement Protocol secret ${args.name}.`);
  },
});

export const ga4WriteTools = [
  ga4CreateCustomDimension,
  ga4UpdateCustomDimension,
  ga4ArchiveCustomDimension,
  ga4CreateCustomMetric,
  ga4UpdateCustomMetric,
  ga4ArchiveCustomMetric,
  ga4CreateKeyEvent,
  ga4DeleteKeyEvent,
  ga4UpdateDataRetention,
  ga4CreateAudience,
  ga4UpdateAudience,
  ga4ArchiveAudience,
  ga4CreateDataStream,
  ga4UpdateDataStream,
  ga4DeleteDataStream,
  ga4CreateMeasurementProtocolSecret,
  ga4DeleteMeasurementProtocolSecret,
];
