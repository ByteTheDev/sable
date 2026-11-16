import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SessionRuntime } from '../core/runtime';
import { BROWSER_DESCRIPTIONS, BROWSER_SELECTOR_DESCRIPTION, BROWSER_TOOLS, BROWSER_URL_DESCRIPTION, runBrowserTool, type BrowserOp, type BrowserToolResult } from './browser-tool';
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
    tools.push(
      tool(BROWSER_TOOLS.read, BROWSER_DESCRIPTIONS.read, { selector: z.string().optional().describe(BROWSER_SELECTOR_DESCRIPTION) }, (args) => run('read', args), {
        annotations: { title: 'Read the Browser tab', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      }),
      tool(BROWSER_TOOLS.screenshot, BROWSER_DESCRIPTIONS.screenshot, {}, (args) => run('screenshot', args), {
        annotations: { title: 'Screenshot of the Browser tab', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      }),
      tool(BROWSER_TOOLS.open, BROWSER_DESCRIPTIONS.open, { url: z.string().describe(BROWSER_URL_DESCRIPTION) }, (args) => run('open', args), {
        annotations: { title: 'Open in the Browser tab', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      }),
    );
  }
  return createSdkMcpServer({
    name: WIDGET_SERVER,
    version: '1.0.0',
    // Never deferred behind tool search: the agent should know it can draw and look without searching.
    alwaysLoad: true,
    tools,
  });
}
