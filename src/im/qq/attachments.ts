import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';

export interface QqAttachment {
  type: 'image' | 'file';
  name: string;
  path: string;
  url: string;
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const URL_KEYS = new Set(['url', 'file_url', 'image_url', 'download_url', 'fileurl', 'imageurl']);

function collectUrls(value: unknown, urls: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && URL_KEYS.has(key.toLowerCase()) && /^https?:\/\//i.test(child)) urls.add(child);
    else collectUrls(child, urls, depth + 1);
  }
}

/** 附件按「天」建目录：YYYY-MM-DD（Asia/Shanghai） */
function dayInShanghai(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 附件文件名用秒级时间：HHMMSS（Asia/Shanghai） */
function clockInShanghai(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('hour')}${get('minute')}${get('second')}`;
}

function extensionFor(contentType: string | null): string {
  if (!contentType) return '';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg')) return '.jpg';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('bmp')) return '.bmp';
  if (contentType.includes('pdf')) return '.pdf';
  if (contentType.includes('zip')) return '.zip';
  if (contentType.includes('json')) return '.json';
  if (contentType.includes('text/')) return '.txt';
  return '';
}

/** 优先沿用 URL 里的扩展名（限定 1~5 位字母数字，避免奇怪后缀） */
function extensionFromUrl(url: string): string {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
  } catch {
    return '';
  }
}

/**
 * 取 URL 里的原始文件名主干（去掉扩展名），只保留字母/数字/._-（含中文）。
 * 拿不到有意义的就返回空串。
 */
function originalStem(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const base = decodeURIComponent(last);
    const stem = base.replace(/\.[^.]*$/, '');
    const cleaned = stem
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 24);
    if (!cleaned || /^(download|img|file|image)$/i.test(cleaned)) return '';
    return cleaned;
  } catch {
    return '';
  }
}

/**
 * 文件名 = 秒级时间 + (原文件名) + 扩展名；同名已存在则递增避让（-1、-2…）。
 * 用 flag 'wx' 把「检测存在」和「创建」合成原子操作，并发下也不会互相覆盖。
 */
async function writeUniqueFile(
  directory: string,
  clock: string,
  stem: string,
  extension: string,
  bytes: Buffer,
): Promise<{ name: string; path: string }> {
  const middle = stem ? `-${stem}` : '';
  for (let n = 0; n < 1_000; n++) {
    const suffix = n === 0 ? '' : `-${n}`;
    const name = `${clock}${middle}${suffix}${extension}`;
    const path = join(directory, name);
    try {
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
      return { name, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`附件同名过多，无法避让：${clock}${middle}${extension}`);
}

export async function downloadQqAttachments(raw: unknown, baseDir?: string): Promise<QqAttachment[]> {
  const urls = new Set<string>();
  collectUrls(raw, urls);
  if (urls.size === 0) return [];

  // 目录：<baseDir>/YYYY-MM-DD/ ；文件名：HHMMSS[.ext]，同名递增避让。
  // baseDir 由调用方传入（通常是该机器人的工作目录），不传则回退到旧位置。
  const now = new Date();
  const directory = join(baseDir ?? join(homedir(), '.botmux', 'qq-attachments'), dayInShanghai(now));
  const clock = clockInShanghai(now);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const attachments: QqAttachment[] = [];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_ATTACHMENT_BYTES) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ATTACHMENT_BYTES) continue;
      const contentType = response.headers.get('content-type');
      const extension = extensionFromUrl(url) || extensionFor(contentType);
      const { name, path } = await writeUniqueFile(directory, clock, originalStem(url), extension, bytes);
      const isImage = contentType?.startsWith('image/') || IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
      attachments.push({ type: isImage ? 'image' : 'file', name, path, url });
    } catch {
      // Best-effort attachment download: the text turn still proceeds.
    }
  }
  return attachments;
}

export function formatQqAttachments(attachments: QqAttachment[]): string {
  if (attachments.length === 0) return '';
  return [
    '[QQ 附件（已下载到本地）]',
    ...attachments.map((attachment, index) => `${attachment.type === 'image' ? '图片' : '文件'} ${index + 1}：${attachment.path}（${attachment.name}）`),
    '请按需读取这些本地路径；不要仅凭文件名推断内容。',
  ].join('\n');
}
