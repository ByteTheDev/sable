import type { AppSettings, ToolDetail } from '../../shared/protocol';

/**
 * Generative UI: the `show_widget` tool every agent gets while the setting is on. The agent sends
 * HTML or SVG; the app renders it inline in a sandboxed frame (src/features/genui). Claude Code gets
 * it from an in-process MCP server (claude.ts), Codex as a client-defined dynamic tool (codex.ts).
 * Both name it `show_widget`; the timeline shows any call of it as the widget itself.
 */

export const WIDGET_TOOL = 'show_widget';
/** The in-process MCP server Claude Code sees. */
export const WIDGET_SERVER = 'sable';
/** The tool's full name inside Claude Code. */
export const WIDGET_TOOL_ID = `mcp__${WIDGET_SERVER}__${WIDGET_TOOL}`;
/** The largest widget the tool accepts (characters). */
export const WIDGET_MAX = 200_000;

/** Absent means on. */
export const widgetsEnabled = (settings: Pick<AppSettings, 'generativeUi'> | undefined) => settings?.generativeUi !== false;

/** A tool name from either agent that is this tool. */
export function isWidgetTool(name: string | undefined): boolean {
  if (!name) return false;
  return name === WIDGET_TOOL || name === WIDGET_TOOL_ID || name.endsWith(`__${WIDGET_TOOL}`) || name.endsWith(`.${WIDGET_TOOL}`);
}

/** The agent's only guidance: when a visual is worth it, what the frame gives, what it forbids. */
export const WIDGET_DESCRIPTION = `Show a visual inline in the conversation: a chart, diagram, comparison, small dashboard, interactive explainer, UI mockup, or a form with choices. It appears in place of this call while you write it.

Use it when seeing or trying beats reading: numbers with a shape (trends, distributions, comparisons), structure (architecture, flows, states), a choice for the user to make, a concept easier to explore than to explain. Not for plain answers, short lists, code to copy, or anything a sentence or a markdown table says as well. Keep the explanation in your text.

\`code\` is an HTML fragment or one <svg>, not a full page. It lands in a body with 16px padding, a transparent background over dark ink, ivory text in Inter, and styled defaults for headings, text, tables, buttons (class "primary" for the one main action), inputs, selects, checkboxes, radios, ranges and code. Plain HTML already looks right: add CSS for layout only. Stay monochrome and dark: text tones var(--text), var(--text-2), var(--text-3); panels var(--surface), var(--surface-2); hairlines var(--line), var(--line-2); chart tones var(--series-1) to var(--series-4); var(--good), var(--bad), var(--warn) only for meaning; var(--font-mono), var(--r-md). Helpers: .card, .row, .stack, .grid, .stat (.stat-value, .stat-label), .meter (style="--p:.4", one <span> inside), .num for aligned figures, .muted.

About 720px wide, sometimes much narrower, so keep layouts fluid; the height follows the content. Aim for under 600px (taller is clipped behind "Show all"); never size anything with vh.

Inline <script> runs once the code is complete: put the markup first and scripts last. No network at all: no CDN libraries, web fonts, remote images or fetch (draw with SVG or canvas, use data: URIs). No storage, popups, alerts or navigation. sendPrompt(text) sends a message to the chat as the user, for example the option they chose; it works only from a click inside the widget.`;

export const WIDGET_TITLE_DESCRIPTION = 'A short name for the visual, 2 to 6 words.';
export const WIDGET_CODE_DESCRIPTION = 'The HTML fragment or <svg> to render.';

/** JSON Schema of the input (Codex dynamic tool; the Claude server builds the same shape in zod). */
export const WIDGET_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: WIDGET_TITLE_DESCRIPTION },
    code: { type: 'string', description: WIDGET_CODE_DESCRIPTION },
  },
  required: ['title', 'code'],
  additionalProperties: false,
} as const;

/** One line for agents that may not have the tool (a Codex thread resumed from elsewhere). */
export const WIDGET_FENCE_HINT =
  'Sable can show visuals inline: when a chart, diagram or small interactive explainer beats text, call the show_widget tool. If that tool is not available, put the same HTML or SVG in a fenced code block with the info string widget (```widget) and it will be rendered.';

/** What the tool answers the agent: short, so it does not repeat the widget in its reply. */
export function widgetResult(input: unknown): { ok: boolean; text: string } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const code = typeof o.code === 'string' ? o.code : '';
  if (!code.trim()) return { ok: false, text: 'Nothing to show: `code` was empty.' };
  if (code.length > WIDGET_MAX) return { ok: false, text: `The widget is too large (${code.length} characters, at most ${WIDGET_MAX}). Make it smaller.` };
  return { ok: true, text: 'The widget is shown to the user above your next words. Do not describe what it looks like; add only what it does not say.' };
}

/** Codex's `item/tool/call` answer for a client-defined tool (DynamicToolCallResponse). */
export function dynamicToolAnswer(p: { tool?: unknown; arguments?: unknown } | undefined): { contentItems: { type: 'inputText'; text: string }[]; success: boolean } {
  const name = typeof p?.tool === 'string' ? p.tool : '';
  if (!isWidgetTool(name)) return { contentItems: [{ type: 'inputText', text: `Sable has no tool named ${name || '(none)'}.` }], success: false };
  const r = widgetResult(p?.arguments);
  return { contentItems: [{ type: 'inputText', text: r.text }], success: r.ok };
}

/** The timeline view of a call: the widget's title, no detail (the code lives in the input). */
export function describeWidget(input: unknown): { kind: 'widget'; title: string; detail: ToolDetail } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 80) : 'Widget';
  return { kind: 'widget', title, detail: {} };
}
