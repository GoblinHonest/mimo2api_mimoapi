import { ParsedToolCall } from './parser.js';

export function toOpenAIToolCalls(calls: ParsedToolCall[]) {
  return calls.map(c => {
    // 确保 arguments 能正确序列化
    let argsString: string;
    try {
      if (typeof c.arguments === 'string') {
        argsString = c.arguments;
      } else if (c.arguments === null || c.arguments === undefined) {
        argsString = '{}';
      } else {
        argsString = JSON.stringify(c.arguments);
      }
    } catch (err) {
      console.error('[FORMAT] Failed to stringify tool arguments:', err);
      console.error('[FORMAT] Arguments value:', c.arguments);
      argsString = '{}';
    }

    return {
      id: c.id,
      type: 'function' as const,
      function: {
        name: c.name,
        arguments: argsString,
      },
    };
  });
}

export function toAnthropicToolUse(calls: ParsedToolCall[]) {
  return calls.map(c => ({
    type: 'tool_use' as const,
    id: c.id,
    name: c.name,
    input: c.arguments,
  }));
}

export function formatToolResultMessages(messages: Array<{ role: string; content: unknown }>): string {
  const toolMsgs = messages.filter(m => m.role === 'tool');
  if (!toolMsgs.length) return '';
  return toolMsgs.map(m => {
    const c = m as { tool_call_id?: string; name?: string; content: unknown };
    return `[工具结果] ${c.name ?? ''} (${c.tool_call_id ?? ''}):\n${typeof c.content === 'string' ? c.content : JSON.stringify(c.content)}`;
  }).join('\n\n');
}
