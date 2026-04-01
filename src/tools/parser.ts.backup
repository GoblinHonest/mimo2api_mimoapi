export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function parseXmlParam(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // 1. Specific tags: <parameter name="key"> or <arg name="key">
  const re1 = /<(?:parameter|arg)\s+name="([^"]+)">((?:.|\n|\r)*?)<\/(?:parameter|arg)>/g;
  // 2. Attribute-like tags: <parameter=key> or <arg=key>
  const re2 = /<(?:parameter|arg)=([^>\s/]+)>((?:.|\n|\r)*?)<\/(?:parameter|arg)>/g;
  // 3. Generic tags: <key>val</key>
  const re3 = /<([a-zA-Z_][a-zA-Z0-9_]*?)>((?:.|\n|\r)*?)<\/\1>/g;

  let m: RegExpExecArray | null;
  while ((m = re1.exec(xml)) !== null) {
    const key = m[1]; const val = m[2].trim();
    try { result[key] = JSON.parse(val); } catch { result[key] = val; }
  }
  while ((m = re2.exec(xml)) !== null) {
    const key = m[1]; const val = m[2].trim();
    try { result[key] = JSON.parse(val); } catch { result[key] = val; }
  }

  // Generic tags fallback (only if not already captured)
  while ((m = re3.exec(xml)) !== null) {
    const key = m[1];
    if (['parameter', 'arg', 'name', 'function', 'tool_call', 'tool_result'].includes(key.toLowerCase())) continue;
    if (result[key] !== undefined) continue;
    const val = m[2].trim();
    try { result[key] = JSON.parse(val); } catch { result[key] = val; }
  }

  return result;
}

function extractName(inner: string): string | null {
  // 1. Explicit tags: <name>... or <function>...
  let m = inner.match(/<(?:name|function)>([^<\n]+?)<\/(?:name|function)>/);
  if (m) return m[1].trim();
  // 2. Attribute-like: <name=... or <function=...
  m = inner.match(/<(?:name|function)=([^<>\n\s/]+)/);
  if (m) return m[1].trim();
  // 3. First tag that isn't a reserved word
  m = inner.match(/<([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (m && !['parameter', 'arg', 'name', 'function', 'tool_call', 'tool_result', 'arguments', 'parameters', 'input'].includes(m[1].toLowerCase())) {
    return m[1].trim();
  }
  return null;
}

function repairJson(json: string): string {
  return json
    .replace(/("[^"]*")|(\n|\r)/g, (match, group1) => group1 || (match === '\n' ? '\\n' : '\\r'))
    .replace(/,\s*([}\]])/g, '$1'); // trailing commas
}

function parseMimoNativeToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  // 预处理：清理所有可能干扰解析的零宽字符和控制字符
  const cleanText = text.replace(/[\u200B-\u200D\uFEFF\u2060\u0000]/g, '');

  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(cleanText)) !== null) {
    let inner = block[1].trim();
    if (inner.startsWith("<tool_result>")) inner = inner.slice("<tool_result>".length).trim();
    if (inner.endsWith("</tool_result>")) inner = inner.slice(0, -"</tool_result>".length).trim();

    const callId = `call_${Math.random().toString(36).slice(2, 10)}`;

    if (inner.startsWith("{")) {
      try {
        const parsed = JSON.parse(repairJson(inner));
        if (parsed.name) {
          calls.push({
            id: parsed.id ?? callId,
            name: parsed.name,
            arguments: parsed.arguments ?? parsed.parameters ?? parsed.input ?? {}
          });
          continue;
        }
      } catch { /* fallback to other methods */ }
    }

    const name = extractName(inner);
    if (name) {
      const args = parseXmlParam(inner);
      calls.push({ id: callId, name, arguments: args });
    }
  }
  return calls;
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  // 预处理：清理不可见字符干扰
  const cleanText = text.replace(/[\u200B-\u200D\uFEFF\u2060\u0000]/g, '');

  if (cleanText.includes("<tool_call>")) {
    const calls = parseMimoNativeToolCalls(cleanText);
    console.log("[PARSE] native calls:", JSON.stringify(calls));
    return calls;
  }
  const calls: ParsedToolCall[] = [];
  const blockRe = /<function_calls>([\s\S]*?)<\/function_calls>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(text)) !== null) {
    const invokeRe = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g;
    let inv: RegExpExecArray | null;
    while ((inv = invokeRe.exec(block[1])) !== null) {
      calls.push({ id: `call_${Math.random().toString(36).slice(2,10)}`, name: inv[1], arguments: parseXmlParam(inv[2]) });
    }
  }
  return calls;
}

export function hasToolCallMarker(text: string): boolean {
  return text.includes("<tool_call>") || text.includes("<function_calls>");
}
