import { ParsedToolCall, parseToolCalls, hasToolCallMarker } from '../tools/parser.js';
import { toOpenAIToolCalls, toAnthropicToolUse } from '../tools/format.js';

export interface ToolCallResult {
  hasToolCalls: boolean;
  toolCalls?: ParsedToolCall[];
  openaiCalls?: ReturnType<typeof toOpenAIToolCalls>;
  anthropicCalls?: ReturnType<typeof toAnthropicToolUse>;
}

/**
 * 检测并解析文本中的工具调用
 */
export function detectAndParseToolCalls(text: string): ToolCallResult {
  if (!hasToolCallMarker(text)) {
    return { hasToolCalls: false };
  }

  const calls = parseToolCalls(text);
  if (calls.length === 0) {
    return { hasToolCalls: false };
  }

  return {
    hasToolCalls: true,
    toolCalls: calls,
    openaiCalls: toOpenAIToolCalls(calls),
    anthropicCalls: toAnthropicToolUse(calls),
  };
}

/**
 * 检测并转换 bash 命令为工具调用
 */
export function detectAndConvertBashCommands(text: string): { hasBashCommand: boolean; convertedText?: string } {
  // 转义字符串用于 JSON
  function escapeForJson(str: string): string {
    return str
      .replace(/\\/g, '\\\\')  // 先转义反斜杠
      .replace(/"/g, '\\"')     // 再转义双引号
      .replace(/\n/g, '\\n')    // 转义换行符
      .replace(/\r/g, '\\r')    // 转义回车符
      .replace(/\t/g, '\\t');   // 转义制表符
  }

  // 检测 markdown bash 代码块
  const bashBlockMatch = text.match(/```(?:bash|sh|shell)\s*\n([\s\S]*?)\n```/);
  if (bashBlockMatch) {
    const command = bashBlockMatch[1].trim();
    const converted = `<tool_call>\n{"name": "RunCommand", "arguments": {"command": "${escapeForJson(command)}"}}\n</tool_call>`;
    return { hasBashCommand: true, convertedText: text.replace(bashBlockMatch[0], converted) };
  }

  // 检测常见的 shell 命令模式（单独一行，以常见命令开头）
  const lines = text.split('\n');
  let hasCommand = false;
  const convertedLines = lines.map(line => {
    const trimmed = line.trim();
    // 匹配常见命令：cat, ls, cd, pwd, grep, find, etc.
    const commandMatch = trimmed.match(/^(cat|ls|cd|pwd|grep|find|mkdir|rm|cp|mv|touch|echo|head|tail|wc|sort|uniq|chmod|chown|ps|kill|df|du|tar|zip|unzip|curl|wget|git|npm|yarn|cargo|rustc|python|node|java|gcc|make)\s+/);
    if (commandMatch && !line.includes('<') && !line.includes('>')) {
      hasCommand = true;
      return `<tool_call>\n{"name": "RunCommand", "arguments": {"command": "${escapeForJson(trimmed)}"}}\n</tool_call>`;
    }
    return line;
  });

  if (hasCommand) {
    return { hasBashCommand: true, convertedText: convertedLines.join('\n') };
  }

  return { hasBashCommand: false };
}

/**
 * 处理 thinking 内容（用于 OpenAI 格式）
 */
export function processThinkContent(text: string, mode: string): string {
  if (mode === 'strip') {
    text = text.replace(/\u0000/g, '');
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    const openIdx = text.indexOf('<think>');
    if (openIdx !== -1) text = text.slice(0, openIdx);
    return text.trimStart();
  }
  return text;
}
