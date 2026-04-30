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

  // 1. 移除尾随逗号
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // 2. 移除开头逗号
  repaired = repaired.replace(/([{\[])\s*,/g, '$1');

  // 3. 移除注释（简单处理）
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
  repaired = repaired.replace(/\/\/.*/g, '');

  // 4. 修复数字后多余的引号：123"}} -> 123}}
  repaired = repaired.replace(/(\d+)"([}\],])/g, '$1$2');

  // 5. 修复字符串值后缺少引号：": value, -> ": "value",
  repaired = repaired.replace(/:\s*([^"{[\d\s][^,}\]]*?)([,}\]])/g, (match, value, end) => {
    const trimmed = value.trim();
    if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null') {
      return `: ${trimmed}${end}`;
    }
    return `: "${trimmed}"${end}`;
  });

  return repaired;
}

// 更智能的 JSON 解析，处理包含换行符的字符串
function parseJsonSafely(text: string): any {
  try {
    // 先尝试直接解析
    return JSON.parse(text);
  } catch (firstError) {
    try {
      // 尝试修复后解析
      return JSON.parse(repairJson(text));
    } catch (secondError) {
      // 如果还是失败，尝试更激进的修复：
      // 找到所有字符串值，并确保它们被正确转义
      let fixed = text;
      
      // 匹配 "key": "value" 模式，其中 value 可能包含未转义的换行符
      // 使用负向后查找确保引号前没有反斜杠
      fixed = fixed.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, content) => {
        // 如果内容已经被正确转义，直接返回
        if (!content.includes('\n') && !content.includes('\r') && !content.includes('\t')) {
          return match;
        }
        
        // 否则，重新转义
        const escaped = content
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
        
        return `"${escaped}"`;
      });
      
      try {
        return JSON.parse(fixed);
      } catch (thirdError) {
        // 最后尝试：移除所有实际的换行符，只保留转义的
        const noNewlines = text.replace(/([^\\])\n/g, '$1\\n').replace(/([^\\])\r/g, '$1\\r');
        return JSON.parse(noNewlines);
      }
    }
  }
}

// 智能值解析（递归解析 JSON 字符串）
function parseValue(val: string): unknown {
  if (!val) return '';
  
  const trimmed = val.trim();
  
  // 处理 Python 风格的布尔值
  if (trimmed === 'True' || trimmed === 'true') return true;
  if (trimmed === 'False' || trimmed === 'false') return false;
  
  // 处理 Python 风格的 None
  if (trimmed === 'None' || trimmed === 'null') return null;
  
  // 尝试 JSON 解析
  try {
    const parsed = parseJsonSafely(trimmed);
    // 如果解析结果是字符串，尝试再次解析（处理双重编码的情况）
    if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) {
      try {
        return parseJsonSafely(parsed);
      } catch {
        return parsed;
      }
    }
    return parsed;
  } catch {
    // 返回原始字符串
    return trimmed;
  }
}

// 改进的 XML 参数解析
function parseXmlParam(xml: string): Record<string, unknown> {
  const trimmed = xml.trim();

  // 0. 如果内容是 JSON 格式，直接解析
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = parseJsonSafely(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      log('warn', 'Failed to parse JSON in parseXmlParam', {
        error: String(err),
        xml: trimmed.slice(0, 200),
        xmlRaw: JSON.stringify(trimmed.slice(0, 150))
      });
    }
  }

  const result: Record<string, unknown> = {};
  const keyCounts: Record<string, number> = {}; // 跟踪每个 key 出现的次数

  // 1. 标准属性格式: <parameter name="key">value</parameter>
  const re1 = /<(?:parameter|arg)\s+name=["']([^"']+)["']>([\s\S]*?)<\/(?:parameter|arg)>/gi;

  // 2. 简化属性格式: <parameter=key>value</parameter>
  const re2 = /<(?:parameter|arg)=([^>\s/]+)>([\s\S]*?)<\/(?:parameter|arg)>/gi;

  // 3. 通用标签格式: <key>value</key>（使用 [\s\S] 替代 .|\n|\r）
  const re3 = /<([a-zA-Z_][\w-]*?)>([\s\S]*?)<\/\1>/g;

  const reserved = new Set([
    'parameter', 'arg', 'name', 'function', 'tool_call',
    'tool_result', 'arguments', 'parameters', 'input', 'invoke', 'tool_name'
  ]);

  // 解析标准格式
  let m: RegExpExecArray | null;
  while ((m = re1.exec(xml)) !== null) {
    const key = m[1].trim();
    const val = m[2].trim();
    const parsedVal = parseValue(val);

    if (result[key] !== undefined) {
      // 重复的 key，转换为数组
      if (!Array.isArray(result[key])) {
        result[key] = [result[key]];
      }
      (result[key] as unknown[]).push(parsedVal);
    } else {
      result[key] = parsedVal;
    }
  }

  // 解析简化格式
  while ((m = re2.exec(xml)) !== null) {
    const key = m[1].trim();
    const val = m[2].trim();
    const parsedVal = parseValue(val);

    if (result[key] !== undefined) {
      if (!Array.isArray(result[key])) {
        result[key] = [result[key]];
      }
      (result[key] as unknown[]).push(parsedVal);
    } else {
      result[key] = parsedVal;
    }
  }

  // 解析通用标签（fallback）
  while ((m = re3.exec(xml)) !== null) {
    const key = m[1].trim();
    if (reserved.has(key.toLowerCase())) continue;

    const val = m[2].trim();
    const parsedVal = parseValue(val);

    if (result[key] !== undefined) {
      // 重复的 key，转换为数组
      if (!Array.isArray(result[key])) {
        result[key] = [result[key]];
      }
      (result[key] as unknown[]).push(parsedVal);
    } else {
      result[key] = parsedVal;
    }
  }

  return result;
}

// 提取工具名称
function extractName(inner: string): string | null {
  // 1. 显式标签: <name>...</name>, <function>...</function>, <tool_name>...</tool_name>
  let m = inner.match(/<(?:name|function|tool_name)>([\s\S]*?)<\/(?:name|function|tool_name)>/i);
  if (m) return m[1].trim();

  // 2. 属性格式: <name=...>, <function=...>, <tool_name=...>
  m = inner.match(/<(?:name|function|tool_name)=["']?([^"'<>\s/]+)["']?/i);
  if (m) return m[1].trim();

  // 3. JSON 格式中的 name 字段 - 尝试更激进的修复
  if (inner.includes('"name"') || inner.includes("'name'")) {
    try {
      // 先尝试直接解析
      const parsed = parseJsonSafely(inner);
      if (parsed.name) return String(parsed.name);
    } catch {
      // 如果失败，尝试用正则直接提取 name 字段的值
      const nameMatch = inner.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch) return nameMatch[1];
      const nameMatch2 = inner.match(/'name'\s*:\s*'([^']+)'/);
      if (nameMatch2) return nameMatch2[1];
    }
  }

  // 4. 第一个非保留标签
  m = inner.match(/<([a-zA-Z_][\w-]*)/);
  if (m) {
    const tag = m[1].toLowerCase();
    const reserved = ['parameter', 'arg', 'name', 'function', 'tool_call', 'tool_result', 'arguments', 'parameters', 'input', 'tool_name'];
    if (!reserved.includes(tag)) {
      return m[1].trim();
    }
  }

  return null;
}

// 从参数推断工具名称（当名称缺失时）
function inferToolNameFromArgs(args: Record<string, unknown>): string | null {
  const keys = Object.keys(args);
  
  // Read 工具：通常有 file_path 或 path
  if (keys.includes('file_path') || (keys.includes('path') && keys.length === 1)) {
    return 'Read';
  }
  
  // Write 工具：通常有 file_path 和 content
  if (keys.includes('file_path') && keys.includes('content')) {
    return 'Write';
  }
  
  // Edit 工具：通常有 file_path 和 edits
  if (keys.includes('file_path') && keys.includes('edits')) {
    return 'Edit';
  }
  
  // Bash 工具：通常有 command
  if (keys.includes('command') && !keys.includes('file_path')) {
    return 'Bash';
  }
  
  // Grep 工具：通常有 pattern 或 regex
  if (keys.includes('pattern') || keys.includes('regex')) {
    return 'Grep';
  }
  
  // Glob 工具：通常有 glob 或 glob_pattern
  if (keys.includes('glob') || keys.includes('glob_pattern')) {
    return 'Glob';
  }
  
  return null;
}

// 解析 MiMo 原生格式
function parseMimoNativeToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const cleanText = cleanInvisibleChars(text);

  // 支持多种格式：
  // 1. <tool_call>...</tool_call>
  // 2. <tool_call name="ToolName">...</tool_call>
  // 3. <toolcall>...</toolcall> (小写，无下划线)
  // 4. <toolcall id="toolname">...</toolcall>
  const blockRe = /<tool_?call(?:\s+(?:name|id)=["']([^"']+)["'])?>([\s\S]*?)<\/tool_?call>/gi;
  let block: RegExpExecArray | null;
  let count = 0;

  while ((block = blockRe.exec(cleanText)) !== null) {
    if (++count > CONFIG.MAX_TOOL_CALLS) {
      log('warn', `Exceeded max tool calls limit: ${CONFIG.MAX_TOOL_CALLS}`);
      break;
    }

    let toolCallName = block[1]; // 从 <tool_call name="..."> 或 <toolcall id="..."> 提取的名称
    let inner = block[2].trim();

    // 如果没有从属性中获取到名称，尝试从内部第一个标签提取
    // 例如: <toolcall><attempt_completion>...</attempt_completion></toolcall>
    if (!toolCallName) {
      const innerTagMatch = inner.match(/^<([a-zA-Z_][\w-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>\s*$/);
      if (innerTagMatch) {
        const candidateName = innerTagMatch[1];
        const reserved = ['parameter', 'arg', 'name', 'function', 'tool_call', 'tool_result', 'arguments', 'parameters', 'input', 'invoke', 'tool_name'];
        if (!reserved.includes(candidateName.toLowerCase())) {
          toolCallName = candidateName;
          inner = innerTagMatch[2].trim();
          log('info', `Extracted tool name from inner tag: ${toolCallName}`);
        }
      }
    }

    console.log('[PARSE:DEBUG] Found tool_call block:', {
      toolCallName,
      innerLength: inner.length,
      innerPreview: inner.slice(0, 200),
      innerRaw: JSON.stringify(inner.slice(0, 150))
    });

    // 移除可能的 tool_result 包装
    inner = inner.replace(/^<tool_result>\s*/i, '').replace(/\s*<\/tool_result>$/i, '');

    const callId = generateCallId();

    // 尝试 JSON 格式
    if (inner.startsWith('{')) {
      try {
        const parsed = parseJsonSafely(inner);
        if (parsed.name) {
          calls.push({
            id: parsed.id ?? callId,
            name: String(parsed.name),
            arguments: (parsed.arguments ?? parsed.parameters ?? parsed.input ?? {}) as Record<string, unknown>
          });
          continue;
        }
      } catch (err) {
        // 尝试解析多个 JSON 对象（当多个工具调用在一个 <tool_call> 块内时）
        const multiCalls = parseNamedJsonToolCalls(inner);
        if (multiCalls.length > 0) {
          calls.push(...multiCalls);
          continue;
        }
        log('warn', 'JSON parse failed, falling back to XML', {
          error: String(err),
          innerLength: inner.length,
          innerPreview: inner.slice(0, 200),
          innerEnd: inner.slice(-100)
        });
      }
    }

    // 处理特殊格式：第一行是工具名，后面是 JSON
    // 例如：todowrite\n{"todos": [...]}
    const lines = inner.split('\n');
    if (lines.length >= 2 && lines[1].trim().startsWith('{')) {
      const possibleName = lines[0].trim();
      const jsonPart = lines.slice(1).join('\n').trim();
      console.log('[PARSE:DEBUG] Trying special format:', {
        possibleName,
        toolCallName,
        jsonPartPreview: jsonPart.slice(0, 100)
      });
      try {
        const parsed = parseJsonSafely(jsonPart);
        if (typeof parsed === 'object' && parsed !== null) {
          const finalName = toolCallName || possibleName;
          console.log('[PARSE:DEBUG] Successfully parsed special format:', {
            name: finalName,
            arguments: parsed
          });
          calls.push({
            id: callId,
            name: finalName,
            arguments: parsed as Record<string, unknown>
          });
          continue;
        }
      } catch (err) {
        log('warn', 'Failed to parse special format', { error: String(err), possibleName, jsonPart: jsonPart.slice(0, 100) });
      }
    }

    // 尝试 XML 格式
    let name = toolCallName || extractName(inner);

    //   → name="read", inner 需要解包 <read> 标签
    if (name && !toolCallName) {
      const unwrapRe = new RegExp(
        `^\\s*<${name}(?:\\s[^>]*)?>([\\s\\S]*)<\\/${name}>\\s*$`, 'i'
      );
      const unwrapped = inner.match(unwrapRe);
      if (unwrapped) {
        inner = unwrapped[1].trim();
        log('info', `Unwrapped <${name}> tag from inner content`);
      }
    }

    // 如果还是没有名称，尝试从 arguments 推断
    if (!name) {
      // 先提取 arguments 看看能否推断
      let argsXml = inner;
      const argsMatch = inner.match(/<(?:arguments|parameters|input)>([\s\S]*?)<\/(?:arguments|parameters|input)>/i);
      if (argsMatch) {
        argsXml = argsMatch[1];
      }
      const tempArgs = parseXmlParam(argsXml);
      name = inferToolNameFromArgs(tempArgs);
      
      if (name) {
        log('info', `Inferred tool name from arguments: ${name}`, { args: tempArgs });
        calls.push({ id: callId, name, arguments: tempArgs });
        continue;
      }
    }
    
    if (name) {
      // 先尝试提取 <arguments> 或 <parameters> 标签的内容
      let argsXml = inner;
      const argsMatch = inner.match(/<(?:arguments|parameters|input)>([\s\S]*?)<\/(?:arguments|parameters|input)>/i);
      if (argsMatch) {
        argsXml = argsMatch[1];
      }
      const args = parseXmlParam(argsXml);
      
      // 只有当参数有效时才添加
      if (Object.keys(args).length > 0 || toolCallName) {
        calls.push({ id: callId, name, arguments: args });
      } else {
        log('warn', 'No arguments extracted', { name, inner: inner.slice(0, 100) });
      }
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

// 解析 JSON 格式的工具调用（如 {"action": "ToolName", "args": {...}}）
function parseJsonToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  let cleanText = cleanInvisibleChars(text);

  // 去除 markdown 代码块标记
  cleanText = cleanText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // 尝试提取所有 JSON 对象（使用正则匹配 {...} 块）
  const jsonBlockRe = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  const matches = cleanText.match(jsonBlockRe);

  if (matches) {
    for (const jsonStr of matches) {
      try {
        const parsed = parseJsonSafely(jsonStr);

        // 检查是否是工具调用格式
        if (parsed.action && typeof parsed.action === 'string') {
          // 提取参数：如果有 args/arguments 字段就用它，否则用除了 action 之外的所有字段
          let args: Record<string, unknown>;
          if (parsed.args !== undefined) {
            args = typeof parsed.args === 'object' && parsed.args !== null ? parsed.args as Record<string, unknown> : { args: parsed.args };
          } else if (parsed.arguments !== undefined) {
            args = typeof parsed.arguments === 'object' && parsed.arguments !== null ? parsed.arguments as Record<string, unknown> : { arguments: parsed.arguments };
          } else {
            // 使用除了 action 之外的所有字段
            const { action, ...rest } = parsed;
            args = rest as Record<string, unknown>;
          }

          console.log('[PARSE:DEBUG] Found JSON tool call:', {
            action: parsed.action,
            args
          });

          calls.push({
            id: generateCallId(),
            name: parsed.action,
            arguments: args
          });
        }
      } catch (err) {
        // 跳过无效的 JSON
        continue;
      }
    }
  }

  // 如果没有找到，尝试解析整个文本为单个 JSON 或数组
  if (calls.length === 0) {
    try {
      const parsed = parseJsonSafely(cleanText.trim());

      // 单个工具调用
      if (parsed.action && typeof parsed.action === 'string') {
        // 提取参数：如果有 args/arguments 字段就用它，否则用除了 action 之外的所有字段
        let args: Record<string, unknown>;
        if (parsed.args !== undefined) {
          args = typeof parsed.args === 'object' && parsed.args !== null ? parsed.args as Record<string, unknown> : { args: parsed.args };
        } else if (parsed.arguments !== undefined) {
          args = typeof parsed.arguments === 'object' && parsed.arguments !== null ? parsed.arguments as Record<string, unknown> : { arguments: parsed.arguments };
        } else {
          const { action, ...rest } = parsed;
          args = rest as Record<string, unknown>;
        }

        console.log('[PARSE:DEBUG] Found JSON tool call:', {
          action: parsed.action,
          args
        });

        calls.push({
          id: generateCallId(),
          name: parsed.action,
          arguments: args
        });
      }
      // 数组格式
      else if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.action && typeof item.action === 'string') {
            let args: Record<string, unknown>;
            if (item.args !== undefined) {
              args = typeof item.args === 'object' && item.args !== null ? item.args as Record<string, unknown> : { args: item.args };
            } else if (item.arguments !== undefined) {
              args = typeof item.arguments === 'object' && item.arguments !== null ? item.arguments as Record<string, unknown> : { arguments: item.arguments };
            } else {
              const { action, ...rest } = item;
              args = rest as Record<string, unknown>;
            }

            calls.push({
              id: generateCallId(),
              name: item.action,
              arguments: args
            });
          }
        }
      }
    } catch (err) {
      log('warn', 'Failed to parse JSON tool call', { error: String(err), text: cleanText.slice(0, 200) });
    }
  }

  return calls;
}

// 解析直接工具名标签格式（如 <todo_write>...</todo_write>）
function parseDirectToolNameFormat(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const cleanText = cleanInvisibleChars(text);

  // 匹配 <tool_name>content</tool_name> 格式
  // 工具名通常是小写字母、下划线、数字的组合
  const directToolRe = /<([a-z_][a-z0-9_]*)\s*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  let count = 0;

  const excludedTags = ['div', 'span', 'p', 'a', 'img', 'br', 'hr', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre', 'blockquote', 'strong', 'em', 'b', 'i', 'u', 'todo', 'todo_list', 'thinking', 'result', 'task_progress', 'path', 'name', 'content', 'question', 'options'];

  while ((match = directToolRe.exec(cleanText)) !== null) {
    if (++count > CONFIG.MAX_TOOL_CALLS) {
      log('warn', `Exceeded max tool calls limit: ${CONFIG.MAX_TOOL_CALLS}`);
      break;
    }

    const toolName = match[1];
    const inner = match[2].trim();

    // 跳过常见的 HTML/Markdown 标签和非工具标签
    if (excludedTags.includes(toolName.toLowerCase())) {
      continue;
    }

    console.log('[PARSE:DEBUG] Found direct tool name format:', {
      toolName,
      innerLength: inner.length,
      innerPreview: inner.slice(0, 200)
    });

    const callId = generateCallId();

    // 尝试解析内容为 JSON
    if (inner.startsWith('{')) {
      try {
        const parsed = parseJsonSafely(inner);
        calls.push({
          id: callId,
          name: toolName,
          arguments: parsed as Record<string, unknown>
        });
        continue;
      } catch (err) {
        log('warn', 'Failed to parse JSON in direct format', { error: String(err), toolName });
      }
    }

    // 尝试解析为 XML 参数
    const args = parseXmlParam(inner);
    if (Object.keys(args).length > 0) {
      calls.push({
        id: callId,
        name: toolName,
        arguments: args
      });
    } else {
      // 如果没有参数，将整个内容作为单个参数
      calls.push({
        id: callId,
        name: toolName,
        arguments: { content: inner }
      });
    }
  }

  return calls;
}

// 解析直接 JSON 格式的工具调用（如 {"name": "ToolName", "arguments": {...}}）
// 处理 MiMo 未包裹 <tool_call> 标签时的输出
function parseNamedJsonToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const cleanText = cleanInvisibleChars(text);

  const pattern = /\{\s*"name"\s*:/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(cleanText)) !== null) {
    if (calls.length >= CONFIG.MAX_TOOL_CALLS) break;

    const start = match.index;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < cleanText.length; i++) {
      const ch = cleanText[i];

      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }

      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
    }

    if (end === -1) continue;

    const candidate = cleanText.slice(start, end);
    try {
      const parsed = parseJsonSafely(candidate);
      if (parsed.name && typeof parsed.name === 'string' &&
          (parsed.arguments !== undefined || parsed.parameters !== undefined || parsed.input !== undefined)) {
        const args = (parsed.arguments ?? parsed.parameters ?? parsed.input ?? {}) as Record<string, unknown>;
        calls.push({
          id: parsed.id ?? generateCallId(),
          name: String(parsed.name),
          arguments: typeof args === 'object' && args !== null ? args : {}
        });
        pattern.lastIndex = end;
      }
    } catch {
      // Skip invalid JSON
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

  if (cleanText.includes('<tool_call') || cleanText.includes('<toolcall')) {
    calls = parseMimoNativeToolCalls(cleanText);
    log('info', `Parsed ${calls.length} MiMo native tool calls`);
    console.log('[PARSE:DEBUG] Parsed calls:', JSON.stringify(calls, null, 2));
  } else if (cleanText.includes('<function_calls>')) {
    calls = parseAnthropicToolCalls(cleanText);
    log('info', `Parsed ${calls.length} Anthropic tool calls`);
    console.log('[PARSE:DEBUG] Parsed calls:', JSON.stringify(calls, null, 2));
  } else if (cleanText.includes('{"action"') || cleanText.includes('{ "action"') ||
             (cleanText.includes('{') && cleanText.includes('"action"'))) {
    // JSON 格式 - 使用更宽松的检测，支持 { 和 "action" 之间有换行
    calls = parseJsonToolCalls(cleanText);
    if (calls.length > 0) {
      log('info', `Parsed ${calls.length} JSON format tool calls`);
      console.log('[PARSE:DEBUG] Parsed calls:', JSON.stringify(calls, null, 2));
    }
  } else if (cleanText.includes('"name"') && cleanText.includes('"arguments"')) {
    // {"name": "ToolName", "arguments": {...}} 格式（MiMo 未包裹 <tool_call> 时）
    calls = parseNamedJsonToolCalls(cleanText);
    if (calls.length > 0) {
      log('info', `Parsed ${calls.length} named JSON format tool calls`);
      console.log('[PARSE:DEBUG] Parsed calls:', JSON.stringify(calls, null, 2));
    }
  } else {
    // 尝试直接工具名格式
    calls = parseDirectToolNameFormat(cleanText);
    if (calls.length > 0) {
      log('info', `Parsed ${calls.length} direct tool name format calls`);
      console.log('[PARSE:DEBUG] Parsed calls:', JSON.stringify(calls, null, 2));
    }
  }

  // 终极回退：如果所有解析器都失败，尝试 {"name": "...", "arguments": {...}} 格式
  if (calls.length === 0 && cleanText.includes('"name"') && cleanText.includes('"arguments"')) {
    calls = parseNamedJsonToolCalls(cleanText);
    if (calls.length > 0) {
      log('info', `Parsed ${calls.length} named JSON format tool calls (fallback)`);
      console.log('[PARSE:DEBUG] Parsed calls:', JSON.stringify(calls, null, 2));
    }
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

  // 检查标准格式
  if (cleanText.includes('<tool_call') || cleanText.includes('<toolcall') || cleanText.includes('<function_calls>')) {
    return true;
  }

  // 检查 JSON 格式的工具调用（如 {"action": "ToolName", "args": {...}}）
  // 使用更宽松的检测：只要包含 {"action": 或 { 和 "action" 就认为可能是工具调用
  if (cleanText.includes('{"action"') || cleanText.includes('{ "action"')) {
    return true;
  }

  // 检查 { 和 "action" 之间只有空白字符的情况（支持换行）
  if (cleanText.includes('{') && cleanText.includes('"action"')) {
    const openBrace = cleanText.indexOf('{');
    const actionPos = cleanText.indexOf('"action"');
    if (actionPos > openBrace) {
      const between = cleanText.slice(openBrace + 1, actionPos);
      if (/^\s*$/.test(between)) {
        return true;
      }
    }
  }

  // 检查直接工具名标签格式（如 <todo_write>, <run_command> 等）
  const directToolPattern = /<([a-z_][a-z0-9_]*)\s*>/i;
  const match = cleanText.match(directToolPattern);
  if (match) {
    const tagName = match[1].toLowerCase();
    // 排除常见的 HTML/Markdown 标签
    const excludedTags = ['div', 'span', 'p', 'a', 'img', 'br', 'hr', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre', 'blockquote', 'strong', 'em', 'b', 'i', 'u', 'thinking', 'result', 'task_progress', 'path', 'name', 'content', 'question', 'options'];
    if (!excludedTags.includes(tagName)) {
      return true;
    }
  }

  // 检查 {"name": 格式（MiMo 未包裹 <tool_call> 标签时的输出）
  if (cleanText.includes('"name"') && cleanText.includes('"arguments"')) {
    const namedJsonMatch = cleanText.match(/\{\s*"name"\s*:\s*"[A-Z]/);
    if (namedJsonMatch) return true;
  }

  return false;
}
