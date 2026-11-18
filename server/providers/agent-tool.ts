import type { ProviderId, ToolItem } from '../../shared/protocol';
import { WIDGET_SERVER } from './widget-tool';

/**
 * Sub-agents from the other agent: a Claude session can hand a task to Codex and a Codex session to
 * Claude, both working in the same folder. One tool per direction, offered while the other agent
 * is installed and signed in (`ProviderContext.otherAgents`). The call shows in the timeline and
 * the Agents tab like the agent's own sub-agents: the other agent's steps nest under it, its
 * permission prompts come to this session, and its final answer is the tool's result.
 */

export const AGENT_TOOLS: Partial<Record<ProviderId, string>> = { codex: 'delegate_to_codex', claude: 'delegate_to_claude' };
const NAMES: Partial<Record<ProviderId, string>> = { codex: 'Codex', claude: 'Claude Code' };

/** The agent a tool name hands work to (plain, or as Claude Code names an MCP tool). */
export function agentOfTool(name: string | undefined): ProviderId | undefined {
  if (!name) return undefined;
  const plain = name.startsWith(`mcp__${WIDGET_SERVER}__`) ? name.slice(`mcp__${WIDGET_SERVER}__`.length) : name;
  for (const [p, n] of Object.entries(AGENT_TOOLS)) if (n === plain) return p as ProviderId;
  return undefined;
}

export const agentToolId = (agent: ProviderId) => `mcp__${WIDGET_SERVER}__${AGENT_TOOLS[agent]}`;

export function agentToolDescription(agent: ProviderId): string {
  const who = NAMES[agent] ?? agent;
  return [
    `Hand a self-contained task to ${who}, another coding agent, as a sub-agent working in this same folder.`,
    `Use it when the user asks for ${who}, or for a second opinion, a review, or a task that suits ${who}.`,
    `${who} starts with no memory of this conversation: say everything it needs in \`prompt\` (the goal, the files, the constraints, what to report back).`,
    'It works until it is done and its final answer comes back as the result. Its steps show to the user as they happen.',
  ].join(' ');
}

export const AGENT_PARAMS = {
  description: { type: 'string', description: 'A short title for the task, 3 to 6 words.', required: true },
  prompt: { type: 'string', description: 'The whole task for the sub-agent, self-contained.', required: true },
  model: { type: 'string', description: 'A model id of that agent; leave it out for its default.', required: false },
} as const;

export const AGENT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: AGENT_PARAMS.description.description },
    prompt: { type: 'string', description: AGENT_PARAMS.prompt.description },
    model: { type: 'string', description: AGENT_PARAMS.model.description },
  },
  required: ['description', 'prompt'],
  additionalProperties: false,
};

export interface AgentCall {
  agent: ProviderId;
  description: string;
  prompt: string;
  model?: string;
}

/** Reads a call's arguments; null when they are not usable. */
export function readAgentCall(agent: ProviderId, args: unknown): AgentCall | null {
  const a = (args ?? {}) as Record<string, unknown>;
  const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
  if (!prompt) return null;
  const description = typeof a.description === 'string' && a.description.trim() ? a.description.trim() : prompt.split('\n')[0].slice(0, 60);
  return { agent, description, prompt, ...(typeof a.model === 'string' && a.model.trim() ? { model: a.model.trim() } : {}) };
}

/** How the timeline shows a call: the sub-agent's title, its prompt in the details. */
export function describeAgentCall(agent: ProviderId, input: unknown): Pick<ToolItem, 'kind' | 'title' | 'detail'> {
  const a = (input ?? {}) as Record<string, unknown>;
  const description = typeof a.description === 'string' && a.description ? a.description : `Ask ${NAMES[agent] ?? agent}`;
  return { kind: 'agent', title: description, detail: { subagent: NAMES[agent] ?? agent, description, prompt: typeof a.prompt === 'string' ? a.prompt : undefined } };
}
