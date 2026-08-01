import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
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

function fileNameFor(url: string, index: number, contentType: string | null, isImage: boolean): string {
  const pathname = new URL(url).pathname;
  const candidate = basename(pathname).replace(/[^a-zA-Z0-9._-]/g, '_');
  // Prefer a meaningful original basename with a real extension, otherwise fall
  // back to a distinguishable generated name (img-<n>.<ext> / file-<n>.<ext>).
  if (candidate && candidate !== '.' && candidate !== '/' && !/^download$/i.test(candidate)) {
    const dot = candidate.lastIndexOf('.');
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
    const extension = dot > 0 ? candidate.slice(dot) : extensionFor(contentType);
    return `${stem.slice(0, 24)}${extension}`;
  }
  const prefix = isImage ? 'img' : 'file';
  return `${prefix}-${index}${extensionFor(contentType)}`;
}

export async function downloadQqAttachments(raw: unknown): Promise<QqAttachment[]> {
  const urls = new Set<string>();
  collectUrls(raw, urls);
  if (urls.size === 0) return [];

  // Use a human-readable timestamp directory (e.g. 20260801-1438) so paths
  // are meaningful to users and agents while remaining unique per message.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); // YYYYMMDDHHMM (UTC)
  const directory = join(homedir(), '.botmux', 'qq-attachments', `${stamp.slice(0, 8)}-${stamp.slice(8)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const attachments: QqAttachment[] = [];
  let index = 0;
  for (const url of urls) {
    index++;
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_ATTACHMENT_BYTES) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ATTACHMENT_BYTES) continue;
      const contentType = response.headers.get('content-type');
      const name = fileNameFor(url, index, contentType, contentType?.startsWith('image/') ?? false);
      const path = join(directory, name);
      await writeFile(path, bytes, { mode: 0o600 });
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
