import { compatTools } from './compat.js';
import { ga4ReadTools } from './ga4.js';
import { ga4WriteTools } from './ga4-write.js';
import { gscReadTools } from './gsc.js';
import { gscWriteTools } from './gsc-write.js';
import { gtmReadTools } from './gtm.js';
import { gtmWriteTools } from './gtm-write.js';
import { indexingTools } from './indexing.js';
import type { ToolDef } from './registry.js';

export const allTools: ToolDef[] = [
  ...gscReadTools,
  ...ga4ReadTools,
  ...gtmReadTools,
  ...compatTools,
  ...indexingTools,
  ...gscWriteTools,
  ...ga4WriteTools,
  ...gtmWriteTools,
] as unknown as ToolDef[];
