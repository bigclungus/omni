import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { OmnichannelEvent } from '@omnichannel/core'

export function openDatabase(dbPath: string): Database {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE IF NOT EXISTS ingress_queue (
      id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ingress_expires ON ingress_queue (expires_at);
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS reply_handles (
      id TEXT PRIMARY KEY NOT NULL,
      omni_channel_id TEXT NOT NULL,
      route_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reply_handles_expires ON reply_handles (expires_at);
  `)
  return db
}

export function insertQueuedEvent(
  db: Database,
  event: OmnichannelEvent,
  expiresAt: number,
): void {
  db.run(
    `INSERT INTO ingress_queue (id, channel_id, event_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      event.id,
      event.channelId,
      JSON.stringify(event),
      Date.now(),
      expiresAt,
    ],
  )
}

export function deleteQueuedEvent(db: Database, id: string): void {
  db.run(`DELETE FROM ingress_queue WHERE id = ?`, [id])
}

export function gcExpired(db: Database, now: number): number {
  const q = db.query(`DELETE FROM ingress_queue WHERE expires_at < ?`).run(now)
  return Number(q.changes ?? 0)
}

export function gcExpiredReplyHandles(db: Database, now: number): number {
  const q = db.query(`DELETE FROM reply_handles WHERE expires_at < ?`).run(now)
  return Number(q.changes ?? 0)
}

export function listPendingEvents(db: Database, now: number): OmnichannelEvent[] {
  const rows = db
    .query(
      `SELECT event_json FROM ingress_queue WHERE expires_at >= ? ORDER BY created_at ASC`,
    )
    .all(now) as { event_json: string }[]
  return rows.map(r => JSON.parse(r.event_json) as OmnichannelEvent)
}

export function insertReplyHandle(
  db: Database,
  id: string,
  omniChannelId: string,
  routeJson: string,
  expiresAt: number,
): void {
  db.run(
    `INSERT INTO reply_handles (id, omni_channel_id, route_json, expires_at)
     VALUES (?, ?, ?, ?)`,
    [id, omniChannelId, routeJson, expiresAt],
  )
}

export function getReplyHandleRow(
  db: Database,
  id: string,
): { omni_channel_id: string; route_json: string } | null {
  const row = db
    .query(
      `SELECT omni_channel_id, route_json FROM reply_handles WHERE id = ? AND expires_at >= ?`,
    )
    .get(id, Date.now()) as
    | { omni_channel_id: string; route_json: string }
    | undefined
  return row ?? null
}
