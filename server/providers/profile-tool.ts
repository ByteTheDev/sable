import type { ToolDetail } from '../../shared/protocol';
import { WIDGET_SERVER } from './widget-tool';

/**
 * The user's profile for agents: `remember_about_user` adds one short fact to `<home>/profile.md`
 * (services/profile.ts merges it: dedupe, dates, a cap, never secrets). Claude Code gets it from
 * Sable's in-process MCP server (claude-widget.ts), Codex as a client-defined dynamic tool (codex.ts),
 * both while the profile is on (Settings › Profile).
 */

export const PROFILE_TOOL = 'remember_about_user';
/** The tool's full name inside Claude Code. */
export const PROFILE_TOOL_ID = `mcp__${WIDGET_SERVER}__${PROFILE_TOOL}`;

export const PROFILE_DESCRIPTION = `Remember one lasting fact about the user in their Sable profile, which every later session reads: a preference, the language they write in, how they like answers, their projects, their machine or tools. One short sentence in the third person ("Prefers answers in German", "Uses pnpm, never npm"). Not for details of the current task, guesses, or anything they did not make clear. Never secrets: keys, tokens, passwords and email addresses are refused.`;

export const PROFILE_FACT_DESCRIPTION = 'The fact, one short sentence (at most 240 characters).';

/** JSON Schema of the input (Codex dynamic tool; the Claude server builds the same shape in zod). */
export const PROFILE_INPUT_SCHEMA = {
  type: 'object',
  properties: { fact: { type: 'string', description: PROFILE_FACT_DESCRIPTION } },
  required: ['fact'],
  additionalProperties: false,
} as const;

/** A tool name from either agent that is this tool. */
export function isProfileTool(name: string | undefined): boolean {
  if (!name) return false;
  return name === PROFILE_TOOL || name === PROFILE_TOOL_ID || name.endsWith(`__${PROFILE_TOOL}`);
}

/** The timeline line for a call: "Remember: Prefers short answers". */
export function describeProfileCall(input: unknown): { kind: 'other'; title: string; detail: ToolDetail } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const fact = typeof o.fact === 'string' ? o.fact.replace(/\s+/g, ' ').trim() : '';
  const short = fact.length > 70 ? `${fact.slice(0, 69).trimEnd()}…` : fact;
  return { kind: 'other', title: short ? `Remember: ${short}` : 'Remember about you', detail: {} };
}

/** Codex's `item/tool/call` answer for the tool. */
export function profileDynamicAnswer(r: { ok: boolean; text: string }): { contentItems: { type: 'inputText'; text: string }[]; success: boolean } {
  return { contentItems: [{ type: 'inputText', text: r.text }], success: r.ok };
}
