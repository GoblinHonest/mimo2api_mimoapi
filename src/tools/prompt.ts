export interface ToolDefinition {
  // OpenAI format
  type?: 'function';
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
  // Anthropic format
  name?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface NormalizedTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

function normalizeTool(t: ToolDefinition): NormalizedTool {
  if (t.function) return { name: t.function.name, description: t.function.description, parameters: t.function.parameters };
  return { name: t.name!, description: t.description, parameters: t.input_schema };
}

// 递归生成参数 schema 描述，保留嵌套结构
function formatSchemaForPrompt(
  schema: Record<string, unknown> | undefined,
  indent: number = 0
): string {
  if (!schema) return '';
  const type = schema.type as string;
  const pad = '  '.repeat(indent);

  if (type === 'object' && schema.properties) {
    const required = (schema.required as string[]) ?? [];
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const lines = Object.entries(props).map(([name, prop]) => {
      const req = required.includes(name) ? '*' : '';
      const pType = (prop.type as string) ?? 'any';
      const desc = prop.description ? ` // ${prop.description}` : '';
      if (pType === 'object' && prop.properties) {
        const nested = formatSchemaForPrompt(prop, indent + 1);
        return `${pad}  ${name}${req}: object {\n${nested}\n${pad}  }${desc}`;
      }
      if (pType === 'array' && prop.items) {
        const items = prop.items as Record<string, unknown>;
        const iType = (items.type as string) ?? 'any';
        if (iType === 'object' && items.properties) {
          const nested = formatSchemaForPrompt(items, indent + 1);
          return `${pad}  ${name}${req}: array<object> [\n${nested}\n${pad}  ]${desc}`;
        }
        return `${pad}  ${name}${req}: array<${iType}>${desc}`;
      }
      return `${pad}  ${name}${req}: ${pType}${desc}`;
    });
    return lines.join('\n');
  }

  return `${pad}${type ?? 'any'}`;
}

export function buildToolSystemPrompt(tools: ToolDefinition[]): string {
  const toolDescs = tools.map(t => {
    const fn = normalizeTool(t);
    const props = fn.parameters?.properties as Record<string, Record<string, unknown>> | undefined;
    let paramBlock: string;
    if (props) {
      const required = (fn.parameters?.required as string[]) ?? [];
      const lines = Object.entries(props).map(([name, prop]) => {
        const req = required.includes(name) ? '*' : '';
        const pType = (prop.type as string) ?? 'any';
        const desc = prop.description ? ` // ${prop.description}` : '';
        if (pType === 'object' && prop.properties) {
          const nested = formatSchemaForPrompt(prop, 1);
          return `  ${name}${req}: object {\n${nested}\n  }${desc}`;
        }
        if (pType === 'array' && prop.items) {
          const items = prop.items as Record<string, unknown>;
          const iType = (items.type as string) ?? 'any';
          if (iType === 'object' && items.properties) {
            const nested = formatSchemaForPrompt(items, 1);
            return `  ${name}${req}: array<object> [\n${nested}\n  ]${desc}`;
          }
          return `  ${name}${req}: array<${iType}>${desc}`;
        }
        return `  ${name}${req}: ${pType}${desc}`;
      });
      paramBlock = `\n${lines.join('\n')}`;
    } else {
      paramBlock = '';
    }
    const desc = fn.description ? ` // ${fn.description.split('\n')[0].slice(0, 80)}` : '';
    return `## ${fn.name}${desc}${paramBlock}`;
  }).join('\n\n');

  return `[工具调用格式 - 必须严格遵守]
<tool_call>
{"name": "工具名", "arguments": {"参数": "值"}}
</tool_call>

要求：
• 必须用 <tool_call> 标签包裹 JSON
• JSON 必须有 "name" 和 "arguments" 字段
• 禁止输出 bash 命令或 markdown 代码块
• 禁止输出 <toolcall_status>、<toolcall_result> 等系统标签
• 禁止使用中文标签（如 <函数调用>、<函数名> 等）

可用工具：${toolDescs}`;
}