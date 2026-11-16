import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SessionRuntime } from '../core/runtime';
import { BROWSER_DESCRIPTIONS, BROWSER_OPS, BROWSER_PARAMS, BROWSER_TOOLS, runBrowserTool, type BrowserOp, type BrowserToolResult } from './browser-tool';
import { WIDGET_CODE_DESCRIPTION, WIDGET_DESCRIPTION, WIDGET_SERVER, WIDGET_TITLE_DESCRIPTION, WIDGET_TOOL, widgetResult } from './widget-tool';

/**
 * The in-process MCP server that gives Claude Code Sable's own tools: `show_widget` while generative
 * UI is on, and the Browser tab tools while the session's capability is on. One per agent process
 * (an SDK server instance connects to a single process). The widget tool does nothing on the
 * agent's side: the call itself, streamed into the timeline, is what the app renders. The browser
 * tools ask the session's window (`session()` finds the session that owns the process at call time,
 * so a prewarmed process works once a session adopts it).
 */
export function widgetServer(opts: { widgets?: boolean; session?: () => SessionRuntime | undefined } = { widgets: true }): McpSdkServerConfigWithInstance {
  const tools = [];
  if (opts.widgets !== false) {
    tools.push(
      tool(
        WIDGET_TOOL,
        WIDGET_DESCRIPTION,
        { title: z.string().describe(WIDGET_TITLE_DESCRIPTION), code: z.string().describe(WIDGET_CODE_DESCRIPTION) },
        async (args) => {
          const r = widgetResult(args);
          return { content: [{ type: 'text' as const, text: r.text }], isError: !r.ok };
        },
        { annotations: { title: 'Show widget', readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      ),
    );
  }
  const session = opts.session;
  if (session) {
    const run = async (op: BrowserOp, args: unknown) => {
      const rt = session();
      const r: BrowserToolResult = rt ? await runBrowserTool(rt, op, args) : { ok: false, text: 'No session is attached yet.' };
      const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [{ type: 'text', text: r.text }];
      if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mime });
      return { content, isError: !r.ok };
    };
    const TITLES: Record<BrowserOp, string> = {
      read: 'Read the Browser tab',
      screenshot: 'Screenshot of the Browser tab',
      open: 'Open in the Browser tab',
      snapshot: 'Outline of the page in the Browser tab',
      click: 'Click in the Browser tab',
      type: 'Type in the Browser tab',
      press: 'Press a key in the Browser tab',
      scroll: 'Scroll the Browser tab',
      eval: 'Run a script in the Browser tab',
      logs: 'Console and requests of the Browser tab',
      wait: 'Wait for the Browser tab',
      navigate: 'Back, forward or reload in the Browser tab',
    };
    const LOOKS = new Set<BrowserOp>(['read', 'screenshot', 'snapshot', 'logs', 'wait', 'scroll']);
    for (const op of BROWSER_OPS) {
      // The same inputs the Codex schemas describe (BROWSER_PARAMS), as zod.
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, p] of Object.entries(BROWSER_PARAMS[op])) {
        const base = p.enum ? z.enum(p.enum) : p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : z.string();
        shape[key] = (p.required ? base : base.optional()).describe(p.description);
      }
      tools.push(
        tool(BROWSER_TOOLS[op], BROWSER_DESCRIPTIONS[op], shape, (args) => run(op, args), {
          annotations: { title: TITLES[op], readOnlyHint: LOOKS.has(op), destructiveHint: false, openWorldHint: true },
        }),
      );
    }
  }
  return createSdkMcpServer({
    name: WIDGET_SERVER,
    version: '1.0.0',
    // Never deferred behind tool search: the agent should know it can draw and look without searching.
    alwaysLoad: true,
    tools,
  });
}
