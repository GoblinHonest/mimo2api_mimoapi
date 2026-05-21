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

  return `[Tool Call Format - Strictly Enforced]
<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

Requirements:
• Must wrap JSON with <tool_call> tags
• JSON must include "name" and "arguments" fields
• Do not output bash commands or markdown code blocks
• Do not output system tags such as <toolcall_status>, <toolcall_result>
• Use English only for all tags and labels

Available Tools: ${toolDescs}`;
}