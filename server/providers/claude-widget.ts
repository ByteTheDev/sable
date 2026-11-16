import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { WIDGET_CODE_DESCRIPTION, WIDGET_DESCRIPTION, WIDGET_SERVER, WIDGET_TITLE_DESCRIPTION, WIDGET_TOOL, widgetResult } from './widget-tool';

/**
 * The in-process MCP server that gives Claude Code the `show_widget` tool. One per agent process
 * (an SDK server instance connects to a single process). The tool does nothing on the agent's side:
 * the call itself, streamed into the timeline, is what the app renders.
 */
export function widgetServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: WIDGET_SERVER,
    version: '1.0.0',
    // Never deferred behind tool search: the agent should know it can draw without looking.
    alwaysLoad: true,
    tools: [
      tool(
        WIDGET_TOOL,
        WIDGET_DESCRIPTION,
        { title: z.string().describe(WIDGET_TITLE_DESCRIPTION), code: z.string().describe(WIDGET_CODE_DESCRIPTION) },
        async (args) => {
          const r = widgetResult(args);
          return { content: [{ type: 'text', text: r.text }], isError: !r.ok };
        },
        { annotations: { title: 'Show widget', readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      ),
    ],
  });
}
