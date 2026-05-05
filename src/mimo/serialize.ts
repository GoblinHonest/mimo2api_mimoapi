import { config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  _toolPrompt?: boolean;
}

/**
 * 系统内部标签列表
 */
const SYSTEM_TAGS = [
  'toolcall_running_status',
  'toolcall_status',
  'toolcall_result',
  'toolcall_id',
  'toolcall_name',
  'toolcall_arguments',
  'toolcall_error_message',
  'terminal_id',
  'terminal_cwd',
  'command_id',
  'command_status',
  'command_exit_code',
  'command_run_logs'
];

/**
 * 检测消息历史是否被系统标签污染
 */
export function isHistoryContaminated(messages: ChatMessage[]): boolean {
  // 检查 assistant 消息中是否包含系统标签（说明 MiMo 在模仿这些标签）
  const assistantMessages = messages.filter(m => m.role === 'assistant');

  for (const msg of assistantMessages) {
    if (!msg.content) continue;
    for (const tag of SYSTEM_TAGS) {
      if (msg.content.includes(`<${tag}>`)) {
        console.log('[SERIALIZE] ⚠️ Contamination detected in assistant message:', {
          tag,
          preview: msg.content.slice(0, 200)
        });
        return true;
      }
    }
  }

  return false;
}

/**
 * 清理消息内容中的系统内部标签，防止 MiMo 学习和模仿这些标签
 */
function sanitizeContent(content: string | null, role: string): string {
  if (content === null || content === undefined) return '';
  // 只清理 tool 角色的消息，因为这些消息包含系统内部标签
  if (role !== 'tool') return content;

  let cleaned = content;

  // 移除完整的标签对（包括内容）
  for (const tag of SYSTEM_TAGS) {
    const regex = new RegExp(`<${tag}>.*?</${tag}>`, 'gs');
    cleaned = cleaned.replace(regex, '');
  }

  // 移除自闭合标签
  for (const tag of SYSTEM_TAGS) {
    const regex = new RegExp(`<${tag}\\s*/>`, 'g');
    cleaned = cleaned.replace(regex, '');
  }

  // 移除单独的开闭标签
  for (const tag of SYSTEM_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}>`, 'g'), '');
    cleaned = cleaned.replace(new RegExp(`</${tag}>`, 'g'), '');
  }

  // 清理多余的空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

/**
 * 格式化单条消息用于对话历史，保留工具调用上下文
 */
function formatMessageForHistory(m: ChatMessage): string {
  // assistant 消息带 tool_calls：显示工具调用信息
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    const callsStr = m.tool_calls.map(tc => {
      const args = tc.function.arguments;
      return `${tc.function.name}(${args})`;
    }).join('\n');
    const contentPart = m.content ? `\n${m.content}` : '';
    return `assistant: [调用工具]\n${callsStr}${contentPart}`;
  }

  // tool 消息：显示工具结果
  if (m.role === 'tool') {
    const name = m.name || 'unknown';
    return `[工具结果] ${name}:\n${m.content}`;
  }

  // 普通消息
  return `${m.role}: ${m.content}`;
}

export function serializeMessages(messages: ChatMessage[]): string {
  // 先清理所有消息内容
  const sanitizedMessages = messages.map(m => ({
    ...m,
    content: sanitizeContent(m.content, m.role)
  }));

  // 分离：身份指令（普通 system）和工具定义（_toolPrompt 标记）
  const identitySystem = sanitizedMessages.filter(m => m.role === 'system' && !m._toolPrompt);
  const toolPromptSystem = sanitizedMessages.find(m => m.role === 'system' && m._toolPrompt);
  const identityContent = identitySystem.map(m => m.content).join('\n').trim();
  const toolContent = (toolPromptSystem?.content ?? '').trim();
  const rest = sanitizedMessages.filter(m => m.role !== 'system');
  const truncated = rest.slice(-config.maxReplayMessages);
  const msgs = [...identitySystem, ...truncated];

  const parts: string[] = [];

  // 身份指令：放在最前面，加强调前缀
  if (identityContent) {
    console.log('[SERIALIZE] Identity prompt content:', identityContent.slice(0, 500) + (identityContent.length > 500 ? '...' : ''));
    parts.push(`[系统指令 - 你必须始终遵守以下身份和行为设定]\n${identityContent}`);
  }

  // 工具定义：单独一节，放在身份之后
  if (toolContent) {
    console.log('[SERIALIZE] Tool prompt content:', toolContent.slice(0, 300) + (toolContent.length > 300 ? '...' : ''));
    parts.push(`[工具调用指令]\n${toolContent}`);
  }

  const nonSystem = msgs.filter(m => m.role !== 'system');
  const dialogHistory = nonSystem.slice(0, -1);
  const lastMsg = nonSystem[nonSystem.length - 1];

  if (dialogHistory.length > 0) {
    const histStr = dialogHistory.map(m => formatMessageForHistory(m)).join('\n');
    parts.push(`[对话历史]\n${histStr}`);
  }

  if (lastMsg) parts.push(`[当前问题]\n${formatMessageForHistory(lastMsg)}`);

  // === 分别计算各部分，独立截断 ===
  const identityPrefix = '[系统指令 - 你必须始终遵守以下身份和行为设定]\n';
  const toolPrefix = '[工具调用指令]\n';
  const identityStr = identityContent ? `${identityPrefix}${identityContent}` : '';
  const toolStr = toolContent ? `${toolPrefix}${toolContent}` : '';

  // 对话部分（不含身份和工具）
  const dialogParts = parts.filter(p => !p.startsWith('[系统指令') && !p.startsWith('[工具调用'));
  const dialogStr = dialogParts.join('\n\n');

  // 分配空间：身份 30%、工具 30%、对话 40%
  const maxIdentity = Math.floor(config.maxQueryChars * 0.3);
  const maxTool = Math.floor(config.maxQueryChars * 0.3);

  // 截断身份指令
  let finalIdentity = identityStr;
  if (identityStr.length > maxIdentity) {
    finalIdentity = identityStr.slice(0, maxIdentity) + '\n...(身份指令已截断)';
    console.log('[SERIALIZE] ⚠️ Identity prompt truncated:', {
      original: identityStr.length,
      truncated: finalIdentity.length,
      maxAllowed: maxIdentity
    });
  }

  // 截断工具定义
  let finalTool = toolStr;
  if (toolStr.length > maxTool) {
    finalTool = toolStr.slice(0, maxTool) + '\n...(工具定义已截断)';
    console.log('[SERIALIZE] ⚠️ Tool prompt truncated:', {
      original: toolStr.length,
      truncated: finalTool.length,
      maxAllowed: maxTool
    });
  }

  // 剩余空间给对话
  const usedSpace = finalIdentity.length + finalTool.length;
  const maxDialog = config.maxQueryChars - usedSpace - 4;
  const finalDialog = maxDialog > 0 && dialogStr.length > maxDialog
    ? '...(历史消息已截断)\n\n' + dialogStr.slice(-maxDialog + 30)
    : dialogStr;

  // 组合最终结果
  const resultParts = [finalIdentity, finalTool, finalDialog].filter(Boolean);
  const result = resultParts.join('\n\n');

  // 打印各部分大小
  console.log('[SERIALIZE] Message sizes:', {
    identity: finalIdentity.length,
    toolPrompt: finalTool.length,
    dialog: finalDialog.length,
    total: result.length,
    maxAllowed: config.maxQueryChars,
    exceeded: result.length > config.maxQueryChars
  });

  return result;
}

export function extractLastUserMessage(messages: ChatMessage[]): string {
  // 先清理所有消息内容
  const sanitizedMessages = messages.map(m => ({
    ...m,
    content: sanitizeContent(m.content, m.role)
  }));

  const system = sanitizedMessages.filter(m => m.role === 'system');
  const userMsgs = sanitizedMessages.filter(m => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1]?.content ?? '';
  if (system.length === 0) return lastUser;
  const sysContent = system.map(m => m.content).join('\n');
  return `[系统指令]\n${sysContent}\n\n[当前问题]\n${lastUser}`;
}