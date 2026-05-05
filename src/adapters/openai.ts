import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { randomUUID } from 'crypto';
import { decrementActive } from '../accounts.js';
import { callMimo, MimoUsage, fetchBotConfig, getChatModels } from '../mimo/client.js';
import { serializeMessages, ChatMessage } from '../mimo/serialize.js';
import { config } from '../config.js';
import { buildToolSystemPrompt, ToolDefinition } from '../tools/prompt.js';
import { parseToolCalls, hasToolCallMarker } from '../tools/parser.js';
import { toOpenAIToolCalls } from '../tools/format.js';
import { uploadImageToMimo, fetchImageBytes, MimoMedia } from '../mimo/upload.js';
import { Account } from '../accounts.js';
import { getOrCreateSession, updateSessionTokens } from '../mimo/session.js';
import { extractApiKey, authenticateRequest, acquireAccountForRequest, logApiRequest, handleAccountError } from '../middleware/request-handler.js';
import { generateClientSessionId } from '../mimo/session-marker.js';

// 静态 fallback（网络失败时使用）
const MODEL_MAP: Record<string, string> = {
  'mimo-v2.5-pro': 'mimo-v2.5-pro',
  'mimo-v2.5': 'mimo-v2.5',
  'mimo-v2.1-pro': 'mimo-v2.1-pro',
  'mimo-v2.1-omni': 'mimo-v2.1-omni',
  'mimo-v2.1-pro-preview': 'mimo-v2.1-pro-preview',
  'mimo-v2.1-omni-preview': 'mimo-v2.1-omni-preview',
  'mimo-v2-pro': 'mimo-v2-pro',
  'mimo-v2-omni': 'mimo-v2-omni',
  'mimo-v2-flash-studio': 'mimo-v2-flash-studio',
  'clawm-alpha': 'clawm-alpha',
  'clawl-alpha': 'clawl-alpha',
};

// 动态模型解析（支持 redirectTo）
function resolveModelDynamic(model: string): string {
  if (!cachedModels) return MODEL_MAP[model] ?? 'mimo-v2-pro';
  const entry = cachedModels.find(m => m.model === model);
  if (entry) {
    return entry.redirectTo ?? entry.model;
  }
  return 'mimo-v2-pro'; // 未知模型默认
}

// 缓存模型配置
let cachedModels: Array<{ model: string; redirectTo?: string }> | null = null;

async function getResolvedModel(model: string): Promise<string> {
  if (!cachedModels) {
    try {
      const botConfig = await fetchBotConfig();
      cachedModels = botConfig.modelConfigListNg
        .filter(m => m.pageType === 'chat')
        .map(m => ({ model: m.model, redirectTo: m.redirectTo }));
    } catch (err) {
      console.error('[MODEL] Failed to fetch bot config:', err);
      cachedModels = null;
    }
  }
  return resolveModelDynamic(model);
}

function resolveModel(model: string): string {
  return resolveModelDynamic(model);
}

function stripThink(text: string): string {
  text = text.replace(/\u0000/g, '');
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const openIdx = text.indexOf('<think>');
  if (openIdx !== -1) text = text.slice(0, openIdx);
  return text.trimStart();
}

function processThinkContent(text: string, mode: string): string {
  if (mode === 'strip') return stripThink(text);
  return text;
}

// 转义字符串用于 JSON
function escapeForJson(str: string): string {
  return str
    .replace(/\\/g, '\\\\')  // 先转义反斜杠
    .replace(/"/g, '\\"')     // 再转义双引号
    .replace(/\n/g, '\\n')    // 转义换行符
    .replace(/\r/g, '\\r')    // 转义回车符
    .replace(/\t/g, '\\t');   // 转义制表符
}

// 检测并转换 bash 命令为工具调用
function detectAndConvertBashCommands(text: string): { hasBashCommand: boolean; convertedText?: string } {
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

async function extractImages(account: Account, messages: Array<{ role: string; content: unknown }>): Promise<{ messages: Array<{ role: string; content: unknown }>; medias: MimoMedia[] }> {
  const medias: MimoMedia[] = [];
  const out = await Promise.all(messages.map(async (m) => {
    // 如果 content 不是数组，直接返回
    if (!Array.isArray(m.content)) return m;

    // content 是数组，需要转换成字符串
    const blocks = m.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const textParts: string[] = [];

    for (const b of blocks) {
      if (b.type === 'text') {
        textParts.push(b.text ?? '');
      } else if (b.type === 'image_url' && b.image_url?.url) {
        const { data, mimeType } = await fetchImageBytes(b.image_url.url);
        medias.push(await uploadImageToMimo(account, data, mimeType));
      }
    }

    // 始终返回字符串格式的 content
    return { role: m.role, content: textParts.join('\n') };
  }));
  return { messages: out, medias };
}

function logRequest(data: {
  account_id: string;
  api_key_id: string | null;
  model: string;
  usage: MimoUsage | null;
  status: 'success' | 'error';
  error?: string;
  duration_ms: number;
}) {
  logApiRequest({ ...data, endpoint: 'openai' });
}

export function registerOpenAI(app: Hono) {
  app.get('/v1/models', async (c) => {
    try {
      const botConfig = await fetchBotConfig();
      const chatModels = botConfig.modelConfigListNg
        .filter(m => m.pageType === 'chat')
        .map(m => ({ id: m.model, object: 'model', created: 1700000000, owned_by: 'mimo' }));
      return c.json({ object: 'list', data: chatModels });
    } catch (err) {
      console.error('[MODEL] Failed to fetch models from bot config:', err);
      // Fallback to cached models
      const models = Object.keys(MODEL_MAP).map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'mimo' }));
      return c.json({ object: 'list', data: models });
    }
  });

  app.post('/v1/chat/completions', async (c) => {
    console.log('\n[REQ] ========== New OpenAI Request ==========');
    console.log('[REQ] Time:', new Date().toISOString());
    console.log('[REQ] Method:', c.req.method, 'Path:', c.req.path);

    const startTime = Date.now();
    const apiKey = extractApiKey(c);

    // 1. 认证检查
    const apiKeyRecord = authenticateRequest(apiKey);
    if (!apiKeyRecord) {
      return c.json({ error: { message: apiKey ? 'Invalid API key' : 'Missing API key', type: 'auth_error' } }, 401);
    }

    // 2. 原子性选择账号并递增并发计数
    const acquired = acquireAccountForRequest(apiKeyRecord);
    if (!acquired) {
      return c.json({ error: { message: 'No active account available', type: 'service_error' } }, 503);
    }
    const { account } = acquired;

    const body = await c.req.json();
    console.log('[REQ] Body parsed:', { model: body.model || 'default', stream: body.stream ?? false, messages: body.messages?.length || 0, tools: body.tools?.length || 0, reasoning: !!body.reasoning_effort });

    const { messages: cleanedMsgs, medias } = await extractImages(account, body.messages ?? []);
    let rawMessages: ChatMessage[] = cleanedMsgs as ChatMessage[];

    // 处理 Anthropic 风格的 body.system 字段（OpenClaw 会通过此字段发送 system prompt）
    if (body.system) {
      let systemContent: string;
      if (typeof body.system === 'string') {
        systemContent = body.system;
      } else if (Array.isArray(body.system)) {
        // Anthropic 格式：[{"type":"text","text":"..."}]
        systemContent = body.system
          .filter((b: { type: string }) => b.type === 'text')
          .map((b: { text?: string }) => b.text ?? '')
          .join('\n');
      } else {
        systemContent = String(body.system);
      }
      if (systemContent) {
        console.log('[REQ] Found body.system, injecting as system message:', systemContent.slice(0, 200) + '...');
        rawMessages = [{ role: 'system', content: systemContent }, ...rawMessages];
      }
    }
    const tools: ToolDefinition[] | undefined = body.tools?.length ? body.tools : undefined;
    const isStream: boolean = body.stream ?? false;
    const enableThinking: boolean = !!body.reasoning_effort;
    const mimoModel = await getResolvedModel(body.model ?? '');

    let messages = rawMessages;
    if (tools) {
      console.log('[REQ] 🔧 Tools:', tools.map(t => t.name || (t as any).function?.name).join(', '));
      const toolPrompt = buildToolSystemPrompt(tools);
      // 工具定义作为单独的 system 消息，用 _toolPrompt 标记，不污染身份指令
      messages = [{ role: 'system', content: toolPrompt, _toolPrompt: true }, ...messages];
    }

    console.log('[REQ] 🚀 Starting request processing...');
    let lastUsage: MimoUsage | null = null;

    try {
      // 1. 生成客户端会话标识（备用）
      const clientSessionId = generateClientSessionId(c, account.id);
      
      // 2. 获取或创建会话（基于消息历史连续性）
      const { conversationId, session } = await getOrCreateSession(
        account.id,
        clientSessionId,
        rawMessages
      );
      
      console.log('[SESSION] Using conversation:', {
        conversationId: conversationId.slice(0, 16) + '...',
        sessionId: session.id.slice(0, 8) + '...',
        cumulativeTokens: session.cumulative_prompt_tokens
      });
      
      const query = serializeMessages(messages);
      console.log('[MIMO] Calling MiMo API...', { model: mimoModel, thinking: enableThinking, queryLength: query.length, hasMedia: medias.length > 0 });

      const gen = callMimo(account, conversationId, query, enableThinking, mimoModel, medias);
      const responseId = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
      const created = Math.floor(Date.now() / 1000);

      if (isStream) {
        console.log('[STREAM] Starting streaming response...');
        c.header('Content-Type', 'text/event-stream');
        c.header('Cache-Control', 'no-cache');
        c.header('X-Accel-Buffering', 'no');
        return stream(c, async (s) => {
          let isAborted = false;
          let chunkCount = 0;
          let loggedError = false;

          const req = c.req.raw as any;
          if (req.on) {
            req.on('close', () => { isAborted = true; console.log('[STREAM] ⚠️ Client disconnected after', chunkCount, 'chunks'); });
          }

          const sendDelta = async (delta: object) => {
            if (isAborted) return;
            try {
              await s.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model: mimoModel, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
              chunkCount++;
            } catch (err) {
              console.error('[STREAM] ❌ Write error:', err);
              isAborted = true;
              throw err;
            }
          };

          try {
            console.log('[STREAM] Waiting for MiMo response...');
            let pastThink = false;
            let thinkingStarted = false;
            let thinkBuf = '';
            let toolCallBuf: string | null = null;
            let pendingText = '';
            let contentBuf = ''; // 缓存所有 content，finish 时决定是否发送

            for await (const chunk of gen) {
              if (isAborted) { console.log('[STREAM] Aborted, stopping generation'); break; }

              if (chunk.type === 'text') {
                let text = (chunk.content ?? '').replace(/\u0000/g, '');


                if (!pastThink && !thinkingStarted && text && !text.includes('<think>')) pastThink = true;
                if (!pastThink) {
                  if (!thinkingStarted && text.includes('<think>')) { thinkingStarted = true; text = text.replace('<think>', ''); }
                  const closeIdx = text.indexOf('</think>');
                  if (closeIdx !== -1) {
                    pastThink = true;
                    const thinkPart = text.slice(0, closeIdx);
                    const afterThink = text.slice(closeIdx + 8).trimStart();
                    if (config.thinkMode === 'separate') { if (thinkPart) await sendDelta({ reasoning_content: thinkPart }); }
                    else if (config.thinkMode === 'passthrough') { thinkBuf += thinkPart; await sendDelta({ content: '<think>' + thinkBuf + '</think>' }); }
                    if (afterThink) { text = afterThink; } else { continue; }
                  } else {
                    if (config.thinkMode === 'separate') { thinkBuf += text; if (text) await sendDelta({ reasoning_content: text }); }
                    else if (config.thinkMode === 'passthrough') { thinkBuf += text; }
                    continue;
                  }
                }
                if (pastThink) {
                  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
                  const t2Idx = text.indexOf('<think>');
                  if (t2Idx !== -1) text = text.slice(0, t2Idx);
                  // Also strip XML-style <thinking> blocks (MiMo sometimes outputs these)
                  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
                  const t3Idx = text.indexOf('<thinking>');
                  if (t3Idx !== -1) text = text.slice(0, t3Idx);
                  if (!text) continue;
                  
                  if (toolCallBuf !== null) {
                    toolCallBuf += text;
                  } else {
                    pendingText += text;

                    // 调试：记录 pendingText 的内容
                    // 检测各种工具调用格式的起始位置
                    const fc1 = pendingText.indexOf('<function_calls>');
                    const fc2 = pendingText.indexOf('<tool_call>');
                    const fc3 = pendingText.indexOf('<toolcall');

                    // 检测直接工具名标签格式 - 使用通用模式，和解析器保持一致
                    const directToolPattern = /<([a-z_][a-z0-9_]*)\s*>/i;
                    const directToolMatch = pendingText.match(directToolPattern);
                    let fc4 = -1;
                    if (directToolMatch) {
                      const tagName = directToolMatch[1].toLowerCase();
                      // 排除常见的 HTML/Markdown 标签和 MiMo 内部标签
                      const excludedTags = ['div', 'span', 'p', 'a', 'img', 'br', 'hr', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre', 'blockquote', 'strong', 'em', 'b', 'i', 'u', 'thinking', 'result', 'task_progress', 'path', 'name', 'content', 'question', 'options'];
                      if (!excludedTags.includes(tagName)) {
                        fc4 = pendingText.indexOf(directToolMatch[0]);
                      }
                    }

                    // 检测 JSON 格式的工具调用 - 使用更宽松的检测
                    // 支持 { 和 "action" 之间有换行和空格的情况
                    let fc5 = -1;
                    if (pendingText.includes('{"action"')) {
                      fc5 = pendingText.indexOf('{"action"');
                    } else if (pendingText.includes('{ "action"')) {
                      fc5 = pendingText.indexOf('{ "action"');
                    } else if (pendingText.includes('{') && pendingText.includes('"action"')) {
                      // 检查 { 和 "action" 之间是否只有空白字符
                      const openBrace = pendingText.indexOf('{');
                      const actionPos = pendingText.indexOf('"action"');
                      if (actionPos > openBrace) {
                        const between = pendingText.slice(openBrace + 1, actionPos);
                        // 如果之间只有空白字符（空格、换行、制表符），认为是 JSON 工具调用
                        if (/^\s*$/.test(between)) {
                          fc5 = openBrace;
                        }
                      }
                    }

                    // 检测 bash 命令代码块
                    let fc6 = -1;
                    const bashBlockIdx = pendingText.indexOf('```bash');
                    const shBlockIdx = pendingText.indexOf('```sh');
                    const shellBlockIdx = pendingText.indexOf('```shell');
                    if (bashBlockIdx !== -1) fc6 = bashBlockIdx;
                    else if (shBlockIdx !== -1) fc6 = shBlockIdx;
                    else if (shellBlockIdx !== -1) fc6 = shellBlockIdx;

                    // 检测 {"name": 格式的工具调用（MiMo 未包裹 <tool_call> 时）
                    let fc7 = -1;
                    const namedJsonMatch = pendingText.match(/\{\s*"name"\s*:\s*"[A-Z]/);
                    if (namedJsonMatch && namedJsonMatch.index !== undefined) {
                      fc7 = namedJsonMatch.index;
                    }

                    if (fc5 !== -1) {
                    }
                    if (fc6 !== -1) {
                    }

                    const fcIdx = [fc1, fc2, fc3, fc4, fc5, fc6, fc7].filter(i => i !== -1).sort((a, b) => a - b)[0] ?? -1;
                    if (fcIdx !== -1) {
                      let before = pendingText.slice(0, fcIdx);
                      let toolCallStart = pendingText.slice(fcIdx);

                      // 如果是 JSON 格式（fc5），检查前面是否有 ```json 标记
                      if (fcIdx === fc5 && before.endsWith('```json\n')) {
                        const markdownStart = before.lastIndexOf('```json\n');
                        before = pendingText.slice(0, markdownStart);
                        toolCallStart = pendingText.slice(markdownStart);
                      } else if (fcIdx === fc5 && before.match(/```json\s*$/)) {
                        const match = before.match(/(```json\s*)$/);
                        if (match) {
                          const markdownStart = before.length - match[1].length;
                          before = pendingText.slice(0, markdownStart);
                          toolCallStart = pendingText.slice(markdownStart);
                        }
                      }

                      if (before) {
                        contentBuf += before;
                      }
                      toolCallBuf = toolCallStart;
                      pendingText = '';
                    } else {
                      // 增加 safe buffer 大小，避免 ```json 被分割
                      // 如果 pendingText 包含 ``` 但还没有完整的工具调用标记，保留更多字符
                      let safeBufferSize = 20;
                      if (pendingText.includes('```') && !pendingText.includes('```\n')) {
                        // 可能是 ```json 的开始，保留更多
                        safeBufferSize = 30;
                      } else if (pendingText.match(/```\w*$/)) {
                        // 以 ``` 或 ```j 等结尾，保留整个 pendingText
                        safeBufferSize = pendingText.length;
                      }

                      const safe = pendingText.slice(0, Math.max(0, pendingText.length - safeBufferSize));
                      if (safe) contentBuf += safe;
                      pendingText = pendingText.slice(safe.length);
                    }
                  }
                }
              } else if (chunk.type === 'usage') {
                lastUsage = chunk.usage!;
              } else if (chunk.type === 'finish') {
                if (!pastThink && thinkingStarted) {
                  pastThink = true;
                  // 不在这里发送 thinking，先缓存到 contentBuf
                  if (config.thinkMode === 'passthrough') contentBuf += '<think>' + thinkBuf + '</think>';
                }
                if (pendingText) {
                  if (toolCallBuf !== null) toolCallBuf += pendingText;
                  else if (hasToolCallMarker(pendingText)) toolCallBuf = pendingText;
                  else contentBuf += pendingText;
                  pendingText = '';
                }

                const usageChunk = lastUsage ? {
                  prompt_tokens: lastUsage.promptTokens, completion_tokens: lastUsage.completionTokens,
                  total_tokens: lastUsage.totalTokens, completion_tokens_details: { reasoning_tokens: lastUsage.reasoningTokens },
                } : undefined;
                let finishReason = 'stop';
                // 只有当客户端请求中包含 tools 时，才转换为原生 tool_calls 格式
                // 否则将工具调用 XML 作为普通文本返回（让客户端自己解析）
                const shouldConvertToToolCalls = !!tools;

                if (toolCallBuf && hasToolCallMarker(toolCallBuf)) {
                  if (shouldConvertToToolCalls) {
                    // 客户端请求了原生工具调用，转换为 OpenAI 格式
                    const calls = parseToolCalls(toolCallBuf);
                    if (calls.length > 0) {
                      finishReason = 'tool_calls';
                      const openaiCalls = toOpenAIToolCalls(calls);
                      await sendDelta({ tool_calls: openaiCalls.map((tc, i) => ({ index: i, ...tc })) });
                    } else {
                      // 解析失败，将内容缓存到 contentBuf
                      contentBuf += toolCallBuf;
                    }
                  } else {
                    // 客户端没有请求原生工具调用（如 Cline XML 模式），
                    // 将工具调用 XML 作为普通文本返回
                    console.log('[STREAM] Client did not send tools, returning tool call XML as text');
                    contentBuf += toolCallBuf;
                  }
                } else if (toolCallBuf) {
                  // toolCallBuf 存在但没有工具调用标记，可能是 bash 命令
                  if (shouldConvertToToolCalls) {
                    const bashDetection = detectAndConvertBashCommands(toolCallBuf);
                    if (bashDetection.hasBashCommand && bashDetection.convertedText) {
                      const calls = parseToolCalls(bashDetection.convertedText);
                      if (calls.length > 0) {
                        finishReason = 'tool_calls';
                        const openaiCalls = toOpenAIToolCalls(calls);
                        await sendDelta({ tool_calls: openaiCalls.map((tc, i) => ({ index: i, ...tc })) });
                      } else {
                        contentBuf += toolCallBuf;
                      }
                    } else {
                      contentBuf += toolCallBuf;
                    }
                  } else {
                    contentBuf += toolCallBuf;
                  }
                }
                // 有 tool_calls 时不发送 contentBuf，避免客户端重复显示文本
                if (finishReason !== 'tool_calls' && contentBuf) {
                  await sendDelta({ content: contentBuf });
                }
                await s.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model: mimoModel, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: usageChunk })}\n\n`);
                await s.write('data: [DONE]\n\n');
                console.log('[STREAM] ✓ Completed:', { chunks: chunkCount, finishReason, tokens: lastUsage?.totalTokens || 0, duration: Date.now() - startTime + 'ms' });
              }
            }
          } catch (err) {
            console.error('[STREAM] ❌ Error during streaming:', err);
            if (!isAborted) {
              try { await s.write(`data: ${JSON.stringify({ error: { message: String(err), type: 'api_error' } })}\n\n`); await s.write('data: [DONE]\n\n'); } catch {}
            }
            logRequest({ account_id: account.id, api_key_id: apiKeyRecord.id, model: mimoModel, usage: lastUsage, status: 'error', error: String(err), duration_ms: Date.now() - startTime });
            loggedError = true;
          } finally {
            decrementActive(account.id);
            if (!loggedError) {
              logRequest({ account_id: account.id, api_key_id: apiKeyRecord.id, model: mimoModel, usage: lastUsage, status: 'success', duration_ms: Date.now() - startTime });
              if (lastUsage) {
                updateSessionTokens(session.id, lastUsage.promptTokens);
              }
            }
          }
        });
      }

      // non-stream
      console.log('[REQ] Non-streaming mode, collecting response...');
      let fullText = '';
      for await (const chunk of gen) {
        if (chunk.type === 'text') fullText += chunk.content ?? '';
        else if (chunk.type === 'usage') lastUsage = chunk.usage!;
      }

      fullText = processThinkContent(fullText, config.thinkMode);
      logRequest({ account_id: account.id, api_key_id: apiKeyRecord.id, model: mimoModel, usage: lastUsage, status: 'success', duration_ms: Date.now() - startTime });
      // 更新会话 token 统计
      if (lastUsage) {
        updateSessionTokens(session.id, lastUsage.promptTokens);
      }

      const usageObj = lastUsage ? {
        prompt_tokens: lastUsage.promptTokens, completion_tokens: lastUsage.completionTokens,
        total_tokens: lastUsage.totalTokens, completion_tokens_details: { reasoning_tokens: lastUsage.reasoningTokens },
      } : undefined;

      // 只有当客户端请求中包含 tools 时，才转换为原生 tool_calls 格式
      if (tools && hasToolCallMarker(fullText)) {
        const calls = parseToolCalls(fullText);
        if (calls.length > 0) {
          return c.json({
            id: responseId, object: 'chat.completion', created, model: mimoModel,
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toOpenAIToolCalls(calls) }, finish_reason: 'tool_calls' }],
            usage: usageObj,
          });
        }
      }
      return c.json({
        id: responseId, object: 'chat.completion', created, model: mimoModel,
        choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
        usage: usageObj,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      handleAccountError(account, msg);
      logRequest({ account_id: account.id, api_key_id: apiKeyRecord.id, model: mimoModel, usage: null, status: 'error', error: msg, duration_ms: Date.now() - startTime });
      return c.json({ error: { message: msg, type: 'api_error' } }, 502);
    } finally {
      if (!isStream) decrementActive(account.id);
    }
  });
}
