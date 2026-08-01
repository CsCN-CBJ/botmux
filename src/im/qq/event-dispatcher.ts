import WebSocket from 'ws';
import { logger } from '../../utils/logger.js';
import { getQqAccessToken, getQqGateway, type QqBotCredentials } from './client.js';

const GROUP_AND_C2C_EVENT_INTENT = 1 << 25;

interface QqGatewayPayload {
  op?: number;
  d?: any;
  s?: number;
  t?: string;
}

export interface QqInboundMessage {
  eventId: string;
  messageId: string;
  conversationId: string;
  conversationType: 'group' | 'c2c';
  senderId: string;
  content: string;
  raw: unknown;
}

export interface QqEventHandlers {
  onMessage: (message: QqInboundMessage) => Promise<void>;
  onReady?: (botOpenId: string) => void;
}

export interface QqDispatcherHandle {
  close(): void;
}

export async function startQqEventDispatcher(
  credentials: QqBotCredentials,
  handlers: QqEventHandlers,
): Promise<QqDispatcherHandle> {
  const gateway = await getQqGateway(credentials);
  const token = await getQqAccessToken(credentials);
  let sequence: number | null = null;
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;

  const connect = (): void => {
    if (closed) return;
    socket = new WebSocket(gateway);
    socket.on('message', (frame) => {
      let payload: QqGatewayPayload;
      try { payload = JSON.parse(frame.toString()); } catch { return; }
      if (typeof payload.s === 'number') sequence = payload.s;
      if (payload.op === 10) {
        const interval = Number(payload.d?.heartbeat_interval) || 45_000;
        socket?.send(JSON.stringify({ op: 2, d: {
          token: `QQBot ${token}`,
          intents: GROUP_AND_C2C_EVENT_INTENT,
          shard: [0, 1],
          properties: { $os: process.platform, $browser: 'botmux', $device: 'botmux' },
        } }));
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 1, d: sequence }));
        }, interval);
        heartbeat.unref();
        return;
      }
      if (payload.op !== 0) return;
      if (payload.t === 'READY') {
        const botOpenId = payload.d?.user?.id;
        if (typeof botOpenId === 'string') handlers.onReady?.(botOpenId);
        logger.info(`[qq] gateway ready for app ${credentials.appId}`);
        return;
      }
      const group = payload.t === 'GROUP_AT_MESSAGE_CREATE';
      const c2c = payload.t === 'C2C_MESSAGE_CREATE';
      if (!group && !c2c) return;
      const data = payload.d ?? {};
      const senderId = data.author?.member_openid ?? data.author?.user_openid ?? data.author?.id;
      const conversationId = group ? data.group_openid : data.author?.user_openid;
      const content = typeof data.content === 'string' ? data.content.trim() : '';
      const eventId = data.id ?? data.event_id;
      if (!senderId || !conversationId || !eventId || !content) return;
      void handlers.onMessage({
        eventId,
        messageId: data.id ?? eventId,
        conversationId,
        conversationType: group ? 'group' : 'c2c',
        senderId,
        content,
        raw: data,
      }).catch(error => logger.error(`[qq] inbound message failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    socket.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      if (!closed) {
        logger.warn('[qq] gateway closed; reconnecting in 3 seconds');
        reconnectTimer = setTimeout(connect, 3_000);
        reconnectTimer.unref();
      }
    });
    socket.on('error', error => logger.warn(`[qq] gateway error: ${error.message}`));
  };

  connect();
  return {
    close() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
