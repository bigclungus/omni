import type { OmnichannelEvent } from '@omnichannel/core'

/** Gateway injects DB writes for ingress + reply-handle rows. */
export interface DiscordIngressStore {
  insertReplyHandle(
    id: string,
    omniChannelId: string,
    routeJson: string,
    expiresAt: number,
  ): void
  insertQueuedEvent(event: OmnichannelEvent, expiresAt: number): void
  deleteQueuedEvent(eventId: string): void
}

/** Minimal hub surface for live fan-out (matches gateway IPC hub). */
export interface DiscordIngressHub {
  readonly clientCount: number
  broadcastEvent(event: OmnichannelEvent): void
}
