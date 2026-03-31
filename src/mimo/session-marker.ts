// 零宽字符会话ID编解码，移植自 web2api conv_parser.py
// 用途：将 conversationId 隐藏在 AI 回复末尾，供下轮请求自动复用会话

const ZW = [
  '\u200b', // 0
  '\u200c', // 1
  '\u200d', // 2
  '\ufeff', // 3
  '\u180e', // 4
];

const ZW_TO_IDX: Record<string, number> = {};
for (let i = 0; i < ZW.length; i++) ZW_TO_IDX[ZW[i]] = i;

// HEAD: \u180e×3 + \ufeff×3, TAIL: \ufeff×3 + \u180e×3
const HEAD_MARK = ZW[4].repeat(3) + ZW[3].repeat(3);
const TAIL_MARK = ZW[3].repeat(3) + ZW[4].repeat(3);

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_TO_IDX: Record<string, number> = {};
for (let i = 0; i < B64_CHARS.length; i++) B64_TO_IDX[B64_CHARS[i]] = i;
const PAD_IDX = 64;

function encodeB64Idx(idx: number): string {
  const a = Math.floor(idx / 25);
  const r = idx % 25;
  const b = Math.floor(r / 5);
  const c = r % 5;
  return ZW[a] + ZW[b] + ZW[c];
}

function decodeB64Idx(zw3: string): number | null {
  if (zw3.length !== 3) return null;
  const a = ZW_TO_IDX[zw3[0]];
  const b = ZW_TO_IDX[zw3[1]];
  const c = ZW_TO_IDX[zw3[2]];
  if (a === undefined || b === undefined || c === undefined) return null;
  const val = a * 25 + b * 5 + c;
  return val > 64 ? null : val;
}

export function encodeSessionId(sessionId: string): string {
  const b64 = Buffer.from(sessionId, 'utf8').toString('base64');
  let encoded = HEAD_MARK;
  for (const ch of b64) {
    const idx = ch === '=' ? PAD_IDX : (B64_TO_IDX[ch] ?? null);
    if (idx === null) continue;
    encoded += encodeB64Idx(idx);
  }
  encoded += TAIL_MARK;
  return encoded;
}

function decodeFromText(text: string): string | null {
  const headIdx = text.lastIndexOf(HEAD_MARK);
  if (headIdx === -1) return null;
  const afterHead = headIdx + HEAD_MARK.length;
  const tailIdx = text.indexOf(TAIL_MARK, afterHead);
  if (tailIdx === -1) return null;
  const payload = text.slice(afterHead, tailIdx);
  if (payload.length % 3 !== 0) return null;
  let b64 = '';
  for (let i = 0; i < payload.length; i += 3) {
    const idx = decodeB64Idx(payload.slice(i, i + 3));
    if (idx === null) return null;
    b64 += idx === PAD_IDX ? '=' : B64_CHARS[idx];
  }
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      .map(p => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .join(' ');
  }
  return '';
}

export function decodeSessionIdFromMessages(messages: unknown[]): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    const text = normalizeContent(m?.content);
    const decoded = decodeFromText(text);
    if (decoded) return decoded;
  }
  return null;
}

export function stripSessionMarker(text: string): string {
  const headIdx = text.lastIndexOf(HEAD_MARK);
  if (headIdx === -1) return text;
  const tailIdx = text.indexOf(TAIL_MARK, headIdx + HEAD_MARK.length);
  if (tailIdx === -1) return text;
  return text.slice(0, headIdx) + text.slice(tailIdx + TAIL_MARK.length);
}
