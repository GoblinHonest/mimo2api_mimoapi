export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function parseXmlParam(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // support both <parameter name="key"> and <arg name="key"> formats
  const re = /<(?:parameter|arg) name="([^"]+)">((?:.|\n|\r)*?)<\/(?:parameter|arg)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1]; const val = m[2].trim();
    try { result[key] = JSON.parse(val); } catch { result[key] = val; }
  }
  return result;
}

function extractName(inner: string): string | null {
  let m = inner.match(/<name>([^<\n]+?)<\/name>/);
  if (m) return m[1].trim();
  m = inner.match(/<name=([^<>\n\/]+)/);
  if (m) return m[1].trim();
  return null;
}

function parseMimoNativeToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(text)) !== null) {
    let inner = block[1].trim();
    if (inner.startsWith("<tool_result>")) inner = inner.slice("<tool_result>".length).trim();
    if (inner.endsWith("</tool_result>")) inner = inner.slice(0, -"</tool_result>".length).trim();
    if (inner.startsWith("{")) {
      try {
        const parsed = JSON.parse(inner);
        if (parsed.name) calls.push({ id: `call_${Math.random().toString(36).slice(2,10)}`, name: parsed.name, arguments: parsed.arguments ?? parsed.parameters ?? parsed.input ?? {} });
      } catch { /* skip */ }
    } else if (inner.includes("<name")) {
      const name = extractName(inner);
      if (!name) continue;
      const args = parseXmlParam(inner);
      calls.push({ id: `call_${Math.random().toString(36).slice(2,10)}`, name, arguments: args });
    } else {
      const tagMatch = inner.match(/^<([a-zA-Z_][a-zA-Z0-9_]*)>/);
      if (!tagMatch) continue;
      const name = tagMatch[1].trim();
      const args: Record<string, unknown> = {};
      const paramRe4 = /<([a-zA-Z_][a-zA-Z0-9_]*?)>((?:.|\n|\r)*?)<\/\1>/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRe4.exec(inner)) !== null) {
        if (pm[1] === name) continue;
        const key = pm[1].trim(); const val = pm[2].trim();
        try { args[key] = JSON.parse(val); } catch { args[key] = val; }
      }
      calls.push({ id: `call_${Math.random().toString(36).slice(2,10)}`, name, arguments: args });
    }
  }
  return calls;
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  if (text.includes("<tool_call>")) {
    const calls = parseMimoNativeToolCalls(text);
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
