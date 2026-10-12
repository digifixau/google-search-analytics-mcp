import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type Row = Record<string, unknown>;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Renders rows as a GitHub-flavoured markdown table (compact and model friendly). */
export function markdownTable(rows: Row[], columns?: string[]): string {
  if (rows.length === 0) return '_No rows._';
  const cols = columns ?? Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const header = `| ${cols.join(' | ')} |`;
  const divider = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

export function round(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return `${round(value * 100, digits)}%`;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(title: string, value: unknown): CallToolResult {
  return textResult(`${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
}

export function tableResult(
  title: string,
  rows: Row[],
  options: { columns?: string[]; notes?: string[] } = {},
): CallToolResult {
  const parts = [title, '', markdownTable(rows, options.columns)];
  if (options.notes?.length) parts.push('', ...options.notes.map((n) => `- ${n}`));
  return textResult(parts.join('\n'));
}
