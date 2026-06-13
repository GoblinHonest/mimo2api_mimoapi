import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { randomUUID } from 'crypto';
import { decrementActive } from '../accounts.js';
import { callMimo, MimoUsage, fetchBotConfig, getChatModels } from '../mimo/client.js';
import { serializeMessages, ChatMessage } from '../mimo/serialize.js';
import { config, debugLog } from '../config.js';
import { buildToolSystemPrompt, ToolDefinition } from '../tools/prompt.js';
import { parseToolCalls, hasToolCallMarker, findEarliestToolCallMarker } from '../tools/parser.js';
import { toOpenAIToolCalls } from '../tools/format.js';
import { uploadImageToMimo, fetchImageBytes, MimoMedia } from '../mimo/upload.js';
import { Account } from '../accounts.js';
import { getOrCreateSession, updateSessionTokens } from '../mimo/session.js';
import { extractApiKey, authenticateRequest, acquireAccountForRequest, logApiRequest, handleAccountError } from '../middleware/request-handler.js';
import { generateClientSessionId } from '../mimo/session-marker.js';
import { getResolvedModel, resolveModel, MODEL_MAP } from '../shared/model-resolver.js';
import { processThinkContent, detectAndConvertBashCommands, detectAndParseToolCalls } from '../shared/tool-handler.js';

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
        .filter(m => m.pageType === 'chat' && m.isNew === true)
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
    const rawMessages: ChatMessage[] = cleanedMsgs as ChatMessage[];
    const tools: ToolDefinition[] | undefined = body.tools?.length ? body.tools : undefined;
    const isStream: boolean = body.stream ?? false;
    const enableThinking: boolean = !!body.reasoning_effort;
    const mimoModel = await getResolvedModel(body.model ?? '');

    let messages = rawMessages;
    if (tools) {
      console.log('[REQ] 🔧 Tools:', tools.map(t => t.name || (t as any).function?.name).join(', '));
      const toolPrompt = buildToolSystemPrompt(tools);
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        messages = messages.map((m, i) => i === sysIdx ? { ...m, content: m.content + '\n\n' + toolPrompt } : m);
      } else {
        messages = [{ role: 'system', content: toolPrompt }, ...messages];
      }
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
              await s.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model: mimoModel, system_fingerprint: `fp_mimo_${created}`, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
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

            for await (const chunk of gen) {
              if (isAborted) { console.log('[STREAM] Aborted, stopping generation'); break; }

              if (chunk.type === 'text') {
                let text = (chunk.content ?? '').replace(/\u0000/g, '');

                // 调试：打印包含 toolcall 的文本
                if (text.toLowerCase().includes('toolcall') || text.includes('<tool')) {
                  debugLog('[STREAM:DEBUG] Text chunk contains tool call marker:', text.slice(0, 200));
                }

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
                    if (pendingText.includes('{') || pendingText.includes('action')) {
                      debugLog('[STREAM:DEBUG] pendingText contains { or action:', {
                        length: pendingText.length,
                        preview: pendingText.slice(Math.max(0, pendingText.length - 100))
                      });
                    }

                    // 检测工具调用标记（使用共享的检测函数）
                    const fcIdx = findEarliestToolCallMarker(pendingText);
                    if (fcIdx !== -1) {
                      let before = pendingText.slice(0, fcIdx);
                      let toolCallStart = pendingText.slice(fcIdx);

                      debugLog('[STREAM:DEBUG] Tool call detected, before length:', before.length, 'preview:', before.slice(-50));

                      // 检查前面是否有 ```json 标记（MiMo 有时将 JSON 工具调用包裹在 markdown 代码块中）
                      const jsonMarkerMatch = before.match(/(```json)\s*$/);
                      if (jsonMarkerMatch) {
                        const markdownStart = before.lastIndexOf(jsonMarkerMatch[1]);
                        before = pendingText.slice(0, markdownStart);
                        toolCallStart = pendingText.slice(markdownStart);
                        debugLog('[STREAM:DEBUG] Adjusted for ```json marker, new before length:', before.length);
                      }

                      if (before) {
                        debugLog('[STREAM:DEBUG] Buffering before text:', before);
                        await sendDelta({ content: before });
                      }
                      toolCallBuf = toolCallStart;
                      pendingText = '';
                      debugLog('[STREAM:DEBUG] Started toolCallBuf, length:', toolCallBuf.length, 'preview:', toolCallBuf.slice(0, 100));
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
                      if (safe) await sendDelta({ content: safe });
                      pendingText = pendingText.slice(safe.length);
                    }
                  }
                }
              } else if (chunk.type === 'usage') {
                lastUsage = chunk.usage!;
              } else if (chunk.type === 'finish') {
                if (!pastThink && thinkingStarted) {
                  pastThink = true;
                  if (config.thinkMode === 'passthrough') await sendDelta({ content: '<think>' + thinkBuf + '</think>' });
                }
                if (pendingText) {
                  if (toolCallBuf !== null) toolCallBuf += pendingText;
                  else if (hasToolCallMarker(pendingText)) toolCallBuf = pendingText;
                  else await sendDelta({ content: pendingText });
                  pendingText = '';
                }

                debugLog('[STREAM:DEBUG] Finish event, toolCallBuf:', toolCallBuf ? toolCallBuf.slice(0, 500) : 'null');
                if (toolCallBuf) {
                  debugLog('[STREAM:DEBUG] toolCallBuf full length:', toolCallBuf.length);
                  debugLog('[STREAM:DEBUG] hasToolCallMarker:', hasToolCallMarker(toolCallBuf));
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
                    const calls = parseToolCalls(toolCallBuf);
                    if (calls.length > 0) {
                      finishReason = 'tool_calls';
                      const openaiCalls = toOpenAIToolCalls(calls);
                      // Step 1: 发送 role + 空 arguments 的初始 chunk
                      await sendDelta({
                        role: 'assistant',
                        tool_calls: openaiCalls.map((tc, i) => ({
                          index: i, id: tc.id, type: 'function',
                          function: { name: tc.function.name, arguments: '' },
                        })),
                      });
                      // Step 2: 分片发送 arguments
                      const CHUNK_SIZE = 50;
                      for (let i = 0; i < openaiCalls.length; i++) {
                        const args = openaiCalls[i].function.arguments;
                        for (let offset = 0; offset < args.length; offset += CHUNK_SIZE) {
                          await sendDelta({
                            tool_calls: [{ index: i, function: { arguments: args.slice(offset, offset + CHUNK_SIZE) } }],
                          });
                        }
                      }
                    } else {
                      await sendDelta({ content: toolCallBuf });
                    }
                  } else {
                    // 客户端没有请求原生工具调用（如 Cline XML 模式），
                    // 将工具调用 XML 作为普通文本返回
                    console.log('[STREAM] Client did not send tools, returning tool call XML as text');
                    await sendDelta({ content: toolCallBuf });
                  }
                } else if (toolCallBuf) {
                  // toolCallBuf 存在但没有工具调用标记，可能是 bash 命令
                  if (shouldConvertToToolCalls) {
                    const bashDetection = detectAndConvertBashCommands(toolCallBuf);
                    if (bashDetection.hasBashCommand && bashDetection.convertedText) {
                      debugLog('[STREAM:DEBUG] Detected bash command, converting to tool call');
                      const calls = parseToolCalls(bashDetection.convertedText);
                      if (calls.length > 0) {
                        finishReason = 'tool_calls';
                        const openaiCalls = toOpenAIToolCalls(calls);
                        await sendDelta({
                          role: 'assistant',
                          tool_calls: openaiCalls.map((tc, i) => ({
                            index: i, id: tc.id, type: 'function',
                            function: { name: tc.function.name, arguments: '' },
                          })),
                        });
                        const CHUNK_SIZE = 50;
                        for (let i = 0; i < openaiCalls.length; i++) {
                          const args = openaiCalls[i].function.arguments;
                          for (let offset = 0; offset < args.length; offset += CHUNK_SIZE) {
                            await sendDelta({
                              tool_calls: [{ index: i, function: { arguments: args.slice(offset, offset + CHUNK_SIZE) } }],
                            });
                          }
                        }
                      } else {
                        await sendDelta({ content: toolCallBuf });
                      }
                    } else {
                      await sendDelta({ content: toolCallBuf });
                    }
                  } else {
                    await sendDelta({ content: toolCallBuf });
                  }
                }
                await s.write(`data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', created, model: mimoModel, system_fingerprint: `fp_mimo_${created}`, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: usageChunk })}\n\n`);
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
            id: responseId, object: 'chat.completion', created, model: mimoModel, system_fingerprint: `fp_mimo_${created}`,
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toOpenAIToolCalls(calls) }, finish_reason: 'tool_calls' }],
            usage: usageObj,
          });
        }
        // 检测到工具标记但解析失败 — 返回文本但标记为 length
        console.warn('[REQ] Tool call markers detected but parsing failed, returning as text');
        return c.json({
          id: responseId, object: 'chat.completion', created, model: mimoModel, system_fingerprint: `fp_mimo_${created}`,
          choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'length' }],
          usage: usageObj,
        });
      }
      return c.json({
        id: responseId, object: 'chat.completion', created, model: mimoModel, system_fingerprint: `fp_mimo_${created}`,
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
