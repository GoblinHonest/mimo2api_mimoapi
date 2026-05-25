import { createHash } from 'crypto';
import { Account } from '../accounts.js';
import { getMimoProxyFetchOptions } from './proxy-agent.js';

const BASE_URL = 'https://aistudio.xiaomimimo.com';

export interface MimoMedia {
  mediaType: 'image';
  fileUrl: string;
  compressedVideoUrl: string;
  audioTrackUrl: string;
  name: string;
  size: number;
  status: 'completed';
  objectName: string;
  url: string;
}

function makeMd5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

function makeHeaders(account: Account): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Cookie': `serviceToken=${account.service_token}; userId=${account.user_id}; xiaomichatbot_ph=${account.ph_token}`,
    'Origin': 'https://aistudio.xiaomimimo.com',
    'Referer': 'https://aistudio.xiaomimimo.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-timezone': 'Asia/Shanghai',
  };
}

export async function fetchImageBytes(url: string): Promise<{ data: Buffer; mimeType: string }> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const header = url.slice(0, comma);
    const mimeType = header.split(':')[1].split(';')[0];
    const data = Buffer.from(url.slice(comma + 1), 'base64');
    return { data, mimeType };
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const mimeType = resp.headers.get('content-type')?.split(';')[0] ?? 'image/png';
  return { data: Buffer.from(buf), mimeType };
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp',
  };
  return map[mime] ?? 'png';
}

export async function uploadImageToMimo(account: Account, imageData: Buffer, mimeType: string): Promise<MimoMedia> {
  const md5 = makeMd5(imageData);
  const ext = mimeToExt(mimeType);
  const fileName = `image-${md5}.${ext}`;
  const ph = encodeURIComponent(account.ph_token);

  // Step 1: get upload info
  const infoResp = await fetch(
    `${BASE_URL}/open-apis/resource/genUploadInfo?xiaomichatbot_ph=${ph}`,
    {
      method: 'POST',
      headers: makeHeaders(account),
      body: JSON.stringify({ fileName, fileContentMd5: md5 }),
      ...getMimoProxyFetchOptions(),
    } as RequestInit
  );
  if (!infoResp.ok) throw new Error(`genUploadInfo failed: ${infoResp.status}`);
  const infoJson = await infoResp.json() as { code: number; data: { resourceUrl: string; uploadUrl: string } };
  if (infoJson.code !== 0) throw new Error(`genUploadInfo error: ${infoJson.code}`);
  const { resourceUrl, uploadUrl } = infoJson.data;

  // Step 2: upload to OSS
  const putResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'content-md5': md5,
    },
    body: imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength) as ArrayBuffer,
  });
  if (!putResp.ok) throw new Error(`OSS upload failed: ${putResp.status}`);

  // Step 3: parse (register resource)
  const parseResp = await fetch(
    `${BASE_URL}/open-apis/resource/parse?fileUrl=${encodeURIComponent(resourceUrl)}&xiaomichatbot_ph=${ph}`,
    { method: 'POST', headers: makeHeaders(account), ...getMimoProxyFetchOptions() } as RequestInit
  );
  if (!parseResp.ok) throw new Error(`parse failed: ${parseResp.status}`);

  // derive objectName from resourceUrl path (strip query string)
  const objectName = new URL(resourceUrl).pathname.slice(1); // remove leading /

  return {
    mediaType: 'image',
    fileUrl: resourceUrl,
    compressedVideoUrl: '',
    audioTrackUrl: '',
    name: fileName,
    size: imageData.length,
    status: 'completed',
    objectName,
    url: md5,
  };
}
