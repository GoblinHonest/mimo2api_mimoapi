import { createHash } from 'crypto';

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// 配置
const CONFIG = {
  MAX_TEXT_LENGTH: 1_000_000, // 1MB
  MAX_TOOL_CALLS: 50,
  ENABLE_LOGGING: process.env.NODE_ENV !== 'production',
};

// 日志工具
function log(level: 'info' | 'warn' | 'error', message: string, data?: unknown) {
  if (!CONFIG.ENABLE_LOGGING) return;
  const prefix = `[PARSE:${level.toUpperCase()}]`;
  if (data) {
    console.log(prefix, message, JSON.stringify(data));
  } else {
    console.log(prefix, message);
  }
}

// 生成安全的唯一ID
function generateCallId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  const hash = createHash('sha256')
    .update(`${timestamp}${random}${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  return `call_${timestamp}${hash}`;
}

// 清理不可见字符（更全面）
function cleanInvisibleChars(text: string): string {
  return text
    // 零宽字符
    .replace(/[\u200B-\u200D\uFEFF\u2060\u180E]/g, '')
    // 控制字符（保留换行和制表符）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    // 其他不可见字符
    .replace(/[\u00AD\u034F\u061C]/g, '')
    // 方向标记
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

// 改进的 JSON 修复
function repairJson(json: string): string {
  let repaired = json;

  // 1. 处理字符串内的换行符（保护已有的字符串）
  repaired = repaired.replace(
    /"([^"\\]*(\\.[^"\\]*)*)"/g,
    (match) => {
      return match
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    }
  );

  // 2. 移除尾随逗号
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // 3. 移除开头逗号
  repaired = repaired.replace(/([{\[])\s*,/g, '$1');

  // 4. 移除注释（简单处理）
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
  repaired = repaired.replace(/\/\/.*/g, '');

  return repaired;
}

// 智能值解析（递归解析 JSON 字符串）
function parseValue(val: string): unknown {
  if (!val) return '';
  
  // 尝试 JSON 解析
  try {
    const parsed = JSON.parse(val);
    // 如果解析结果是字符串，尝试再次解析（处理双重编码的情况）
    if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) {
      try {
        return JSON.parse(parsed);
      } catch {
        return parsed;
      }
    }
    return parsed;
  } catch {
    // 尝试修复后再解析
    try {
      const repaired = JSON.parse(repairJson(val));
      // 同样处理双重编码
      if (typeof repaired === 'string' && (repaired.startsWith('{') || repaired.startsWith('['))) {
        try {
          return JSON.parse(repaired);
        } catch {
          return repaired;
        }
      }
      return repaired;
    } catch {
      // 返回原始字符串
      return val;
    }
  }
}

// 改进的 XML 参数解析
function parseXmlParam(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // 1. 标准属性格式: <parameter name="key">value</parameter>
  const re1 = /<(?:parameter|arg)\s+name=["']([^"']+)["']>([\s\S]*?)<\/(?:parameter|arg)>/gi;
  
  // 2. 简化属性格式: <parameter=key>value</parameter>
  const re2 = /<(?:parameter|arg)=([^>\s/]+)>([\s\S]*?)<\/(?:parameter|arg)>/gi;
  
  // 3. 通用标签格式: <key>value</key>（使用 [\s\S] 替代 .|\n|\r）
  const re3 = /<([a-zA-Z_][\w-]*?)>([\s\S]*?)<\/\1>/g;

  const reserved = new Set([
    'parameter', 'arg', 'name', 'function', 'tool_call', 
    'tool_result', 'arguments', 'parameters', 'input', 'invoke'
  ]);

  // 解析标准格式
  let m: RegExpExecArray | null;
  while ((m = re1.exec(xml)) !== null) {
    const key = m[1].trim();
    const val = m[2].trim();
    result[key] = parseValue(val);
  }

  // 解析简化格式
  while ((m = re2.exec(xml)) !== null) {
    const key = m[1].trim();
    const val = m[2].trim();
    if (!result[key]) {
      result[key] = parseValue(val);
    }
  }

  // 解析通用标签（fallback）
  while ((m = re3.exec(xml)) !== null) {
    const key = m[1].trim();
    if (reserved.has(key.toLowerCase())) continue;
    if (result[key] !== undefined) continue;
    
    const val = m[2].trim();
    result[key] = parseValue(val);
  }

  return result;
}

// 提取工具名称
function extractName(inner: string): string | null {
  // 1. 显式标签: <name>...</name> 或 <function>...</function>
  let m = inner.match(/<(?:name|function)>([\s\S]*?)<\/(?:name|function)>/i);
  if (m) return m[1].trim();

  // 2. 属性格式: <name=...> 或 <function=...>
  m = inner.match(/<(?:name|function)=["']?([^"'<>\s/]+)["']?/i);
  if (m) return m[1].trim();

  // 3. JSON 格式中的 name 字段
  if (inner.includes('"name"') || inner.includes("'name'")) {
    try {
      const parsed = JSON.parse(repairJson(inner));
      if (parsed.name) return String(parsed.name);
    } catch { /* continue */ }
  }

  // 4. 第一个非保留标签
  m = inner.match(/<([a-zA-Z_][\w-]*)/);
  if (m) {
    const tag = m[1].toLowerCase();
    const reserved = ['parameter', 'arg', 'name', 'function', 'tool_call', 'tool_result', 'arguments', 'parameters', 'input'];
    if (!reserved.includes(tag)) {
      return m[1].trim();
    }
  }

  return null;
}

// 解析 MiMo 原生格式
function parseMimoNativeToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const cleanText = cleanInvisibleChars(text);

  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let block: RegExpExecArray | null;
  let count = 0;

  while ((block = blockRe.exec(cleanText)) !== null) {
    if (++count > CONFIG.MAX_TOOL_CALLS) {
      log('warn', `Exceeded max tool calls limit: ${CONFIG.MAX_TOOL_CALLS}`);
      break;
    }

    let inner = block[1].trim();
    
    // 移除可能的 tool_result 包装
    inner = inner.replace(/^<tool_result>\s*/i, '').replace(/\s*<\/tool_result>$/i, '');

    const callId = generateCallId();

    // 尝试 JSON 格式
    if (inner.startsWith('{')) {
      try {
        const parsed = JSON.parse(repairJson(inner));
        if (parsed.name) {
          calls.push({
            id: parsed.id ?? callId,
            name: String(parsed.name),
            arguments: (parsed.arguments ?? parsed.parameters ?? parsed.input ?? {}) as Record<string, unknown>
          });
          continue;
        }
      } catch (err) {
        log('warn', 'JSON parse failed, falling back to XML', { error: String(err), inner: inner.slice(0, 100) });
      }
    }

    // 尝试 XML 格式
    const name = extractName(inner);
    if (name) {
      const args = parseXmlParam(inner);
      calls.push({ id: callId, name, arguments: args });
    } else {
      log('warn', 'Failed to extract tool name', { inner: inner.slice(0, 100) });
    }
  }

  return calls;
}

// 解析 Anthropic 格式
function parseAnthropicToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const blockRe = /<function_calls>([\s\S]*?)<\/function_calls>/gi;
  let block: RegExpExecArray | null;

  while ((block = blockRe.exec(text)) !== null) {
    const invokeRe = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi;
    let inv: RegExpExecArray | null;
    let count = 0;

    while ((inv = invokeRe.exec(block[1])) !== null) {
      if (++count > CONFIG.MAX_TOOL_CALLS) {
        log('warn', `Exceeded max tool calls limit in function_calls block`);
        break;
      }

      calls.push({
        id: generateCallId(),
        name: inv[1].trim(),
        arguments: parseXmlParam(inv[2])
      });
    }
  }

  return calls;
}

// 主解析函数
export function parseToolCalls(text: string): ParsedToolCall[] {
  // 输入验证
  if (!text || typeof text !== 'string') {
    log('warn', 'Invalid input: text is not a string');
    return [];
  }

  if (text.length > CONFIG.MAX_TEXT_LENGTH) {
    log('error', `Text too long: ${text.length} > ${CONFIG.MAX_TEXT_LENGTH}`);
    return [];
  }

  // 清理不可见字符
  const cleanText = cleanInvisibleChars(text);
  
  console.log('[PARSE:DEBUG] Tool call text preview:', cleanText.slice(0, 500));

  // 检测格式并解析
  let calls: ParsedToolCall[] = [];

  if (cleanText.includes('<tool_call>')) {
    calls = parseMimoNativeToolCalls(cleanText);
    log('info', `Parsed ${calls.length} MiMo native tool calls`);
    console.log('[PARSE:DEBUG] Parsed calls:', JSON.stringify(calls, null, 2));
  } else if (cleanText.includes('<function_calls>')) {
    calls = parseAnthropicToolCalls(cleanText);
    log('info', `Parsed ${calls.length} Anthropic tool calls`);
    console.log('[PARSE:DEBUG] Parsed calls:', JSON.stringify(calls, null, 2));
  }

  // 验证结果
  const validCalls = calls.filter(call => {
    if (!call.name || typeof call.name !== 'string') {
      log('warn', 'Invalid tool call: missing or invalid name', call);
      return false;
    }
    if (!call.arguments || typeof call.arguments !== 'object') {
      log('warn', 'Invalid tool call: missing or invalid arguments', call);
      console.log('[PARSE:ERROR] Invalid arguments type:', typeof call.arguments, call.arguments);
      return false;
    }
    return true;
  });

  if (validCalls.length !== calls.length) {
    log('warn', `Filtered out ${calls.length - validCalls.length} invalid tool calls`);
  }

  return validCalls;
}

// 检测是否包含工具调用标记
export function hasToolCallMarker(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const cleanText = cleanInvisibleChars(text);
  return cleanText.includes('<tool_call>') || cleanText.includes('<function_calls>');
}
