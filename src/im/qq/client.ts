import { logger } from '../../utils/logger.js';

const QQ_API_BASE = 'https://api.sgroup.qq.com';

export interface QqBotCredentials {
  appId: string;
  appSecret: string;
  apiBase?: string;
}

interface TokenState {
  value: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenState>();

export async function getQqAccessToken(credentials: QqBotCredentials): Promise<string> {
  const cached = tokens.get(credentials.appId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: credentials.appId, clientSecret: credentials.appSecret }),
  });
  if (!response.ok) throw new Error(`QQ access-token request failed: HTTP ${response.status}`);
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('QQ access-token response did not contain access_token');
  tokens.set(credentials.appId, {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, data.expires_in ?? 7_200) * 1000,
  });
  return data.access_token;
}

async function qqRequest(credentials: QqBotCredentials, path: string, body?: unknown): Promise<any> {
  const token = await getQqAccessToken(credentials);
  const response = await fetch(`${credentials.apiBase ?? QQ_API_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `QQBot ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`QQ API ${path} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

export async function getQqGateway(credentials: QqBotCredentials): Promise<string> {
  const data = await qqRequest(credentials, '/gateway/bot');
  if (typeof data?.url !== 'string') throw new Error('QQ gateway response did not contain url');
  return data.url;
}

export async function replyToQqGroupMessage(
  credentials: QqBotCredentials,
  groupOpenId: string,
  eventId: string,
  content: string,
  msgSeq = 1,
): Promise<string | undefined> {
  const data = await qqRequest(credentials, `/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, {
    content,
    msg_type: 0,
    msg_id: eventId,
    msg_seq: msgSeq,
  });
  return data?.id;
}

export async function replyToQqC2cMessage(
  credentials: QqBotCredentials,
  openid: string,
  eventId: string,
  content: string,
  msgSeq = 1,
): Promise<string | undefined> {
  const data = await qqRequest(credentials, `/v2/users/${encodeURIComponent(openid)}/messages`, {
    content,
    msg_type: 0,
    msg_id: eventId,
    msg_seq: msgSeq,
  });
  return data?.id;
}

export function logQqApiFailure(scope: string, error: unknown): void {
  logger.warn(`[qq] ${scope}: ${error instanceof Error ? error.message : String(error)}`);
}
