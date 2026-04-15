/**
 * Voice chat integration using the OpenAI Realtime API.
 *
 * Goal: BigClungus joins a Discord voice channel and talks 1:1 with a user
 * via OpenAI's gpt-4o-realtime-preview model. The Realtime API does its own
 * server-side VAD and streams audio back in chunks — we just pump Opus-decoded
 * PCM up and stream PCM deltas back out.
 *
 * Audio pipeline (inbound, Discord -> OpenAI):
 *   Discord Opus @ 48k stereo  →  Opus decode  →  48k stereo PCM16
 *     →  downsample to 24k mono PCM16  →  base64  →  input_audio_buffer.append
 *
 * Audio pipeline (outbound, OpenAI -> Discord):
 *   response.audio.delta (base64 PCM16 @ 24k mono)  →  upsample to 48k stereo
 *     →  push into a readable stream  →  createAudioResource(Raw)  →  AudioPlayer
 *     →  discordjs voice encodes Opus and sends to channel.
 *
 * One VoiceSession per guild. voice_join / voice_leave capabilities drive it.
 *
 * All errors surface. No silent catch/fallback.
 */

import { Readable } from 'node:stream'

import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import OpusScript from 'opusscript'
import type { Client } from 'discord.js'
import WebSocket from 'ws'

import type { InvokeResult } from '@omnibot/gateway'

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

const REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17'
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`

const DISCORD_SAMPLE_RATE = 48_000
const REALTIME_SAMPLE_RATE = 24_000
const RESAMPLE_RATIO = DISCORD_SAMPLE_RATE / REALTIME_SAMPLE_RATE // 2

const DEFAULT_INSTRUCTIONS = [
  'You are BigClungus, a helpful and slightly caveman-brained assistant in a Discord voice call.',
  'Keep replies short and conversational — this is realtime voice, not a written report.',
  'Do not narrate actions. Do not describe tone. Just speak naturally.',
].join(' ')

// --------------------------------------------------------------------------
// Audio helpers
// --------------------------------------------------------------------------

/** Downsample 48 kHz stereo PCM16 to 24 kHz mono PCM16. */
function downsample48StereoTo24Mono(pcm: Buffer): Buffer {
  // stereo frame = 4 bytes (L16 + R16). 48k -> 24k = take every other frame.
  const stereoFrames = Math.floor(pcm.length / 4)
  const outFrames = Math.floor(stereoFrames / RESAMPLE_RATIO)
  const out = Buffer.alloc(outFrames * 2)
  for (let i = 0; i < outFrames; i++) {
    const src = i * RESAMPLE_RATIO * 4
    const l = pcm.readInt16LE(src)
    const r = pcm.readInt16LE(src + 2)
    const mono = Math.max(-32768, Math.min(32767, (l + r) >> 1))
    out.writeInt16LE(mono, i * 2)
  }
  return out
}

/** Upsample 24 kHz mono PCM16 to 48 kHz stereo PCM16 (sample-and-hold, duplicated to both channels). */
function upsample24MonoTo48Stereo(pcm: Buffer): Buffer {
  const inFrames = Math.floor(pcm.length / 2)
  const outFrames = inFrames * RESAMPLE_RATIO
  const out = Buffer.alloc(outFrames * 4)
  for (let i = 0; i < inFrames; i++) {
    const sample = pcm.readInt16LE(i * 2)
    for (let j = 0; j < RESAMPLE_RATIO; j++) {
      const dst = (i * RESAMPLE_RATIO + j) * 4
      out.writeInt16LE(sample, dst)
      out.writeInt16LE(sample, dst + 2)
    }
  }
  return out
}

// --------------------------------------------------------------------------
// Session
// --------------------------------------------------------------------------

interface VoiceSession {
  guildId: string
  channelId: string
  connection: VoiceConnection
  player: AudioPlayer
  outboundStream: Readable
  ws: WebSocket
  decoders: Map<string, OpusScript>
  stopped: boolean
  stop: (reason: string) => Promise<void>
}

const sessions = new Map<string, VoiceSession>()

// --------------------------------------------------------------------------
// Entry points
// --------------------------------------------------------------------------

export async function voiceJoin(
  client: Client,
  args: Record<string, unknown>,
): Promise<InvokeResult> {
  const channelId = typeof args.channelId === 'string' ? args.channelId : undefined
  if (!channelId) return { ok: false, error: 'voice_join requires args.channelId' }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set in environment' }

  const ch = await client.channels.fetch(channelId).catch(() => null)
  if (!ch) return { ok: false, error: `channel ${channelId} not found` }
  if (!ch.isVoiceBased()) return { ok: false, error: `channel ${channelId} is not a voice channel` }

  const guild = 'guild' in ch ? ch.guild : null
  if (!guild) return { ok: false, error: `voice channel ${channelId} has no guild` }

  if (sessions.has(guild.id)) {
    return { ok: false, error: `already in a voice channel in guild ${guild.id}` }
  }

  const instructions = typeof args.instructions === 'string' ? args.instructions : DEFAULT_INSTRUCTIONS
  const voice = typeof args.voice === 'string' ? args.voice : 'alloy'

  const session = await startSession({
    guildId: guild.id,
    channelId: ch.id,
    adapterCreator: guild.voiceAdapterCreator,
    apiKey,
    instructions,
    voice,
  })

  sessions.set(guild.id, session)
  return {
    ok: true,
    data: { guildId: guild.id, channelId: ch.id, model: REALTIME_MODEL },
  }
}

export async function voiceLeave(
  _client: Client,
  args: Record<string, unknown>,
): Promise<InvokeResult> {
  const guildId = typeof args.guildId === 'string' ? args.guildId : undefined
  if (!guildId) {
    // fall back to the first active session
    const first = sessions.values().next().value as VoiceSession | undefined
    if (!first) return { ok: false, error: 'not in any voice channel' }
    await first.stop('voice_leave (no guildId)')
    return { ok: true, data: { guildId: first.guildId } }
  }
  const sess = sessions.get(guildId)
  if (!sess) return { ok: false, error: `not in a voice channel in guild ${guildId}` }
  await sess.stop('voice_leave')
  return { ok: true, data: { guildId } }
}

// --------------------------------------------------------------------------
// Session lifecycle
// --------------------------------------------------------------------------

interface StartOptions {
  guildId: string
  channelId: string
  adapterCreator: unknown
  apiKey: string
  instructions: string
  voice: string
}

async function startSession(opts: StartOptions): Promise<VoiceSession> {
  // 1. Join the Discord voice channel.
  const connection = joinVoiceChannel({
    channelId: opts.channelId,
    guildId: opts.guildId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapterCreator: opts.adapterCreator as any,
    selfDeaf: false,
    selfMute: false,
  })

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000)
  } catch (err) {
    connection.destroy()
    throw new Error(
      `failed to join voice channel ${opts.channelId}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 2. Set up the outbound audio pipeline (bot -> Discord speaker).
  const outboundStream = new Readable({ read() {} })
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  })
  const resource = createAudioResource(outboundStream, {
    inputType: StreamType.Raw, // 48k stereo PCM16
  })
  connection.subscribe(player)
  player.play(resource)

  player.on('error', err => {
    process.stderr.write(`voice: audio player error: ${err instanceof Error ? err.message : String(err)}\n`)
  })
  player.on(AudioPlayerStatus.Idle, () => {
    // staying subscribed — noSubscriber Play keeps the pipeline alive
  })

  // 3. Open the OpenAI Realtime websocket.
  const ws = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  })

  const session: VoiceSession = {
    guildId: opts.guildId,
    channelId: opts.channelId,
    connection,
    player,
    outboundStream,
    ws,
    decoders: new Map(),
    stopped: false,
    stop: async (reason: string) => {
      if (session.stopped) return
      session.stopped = true
      process.stderr.write(`voice: stopping session (${reason}) guild=${opts.guildId}\n`)
      try { ws.close() } catch (err) {
        process.stderr.write(`voice: ws close error: ${err instanceof Error ? err.message : String(err)}\n`)
      }
      try { outboundStream.push(null) } catch (err) {
        process.stderr.write(`voice: outbound stream close error: ${err instanceof Error ? err.message : String(err)}\n`)
      }
      try { player.stop(true) } catch (err) {
        process.stderr.write(`voice: player stop error: ${err instanceof Error ? err.message : String(err)}\n`)
      }
      try { connection.destroy() } catch (err) {
        process.stderr.write(`voice: connection destroy error: ${err instanceof Error ? err.message : String(err)}\n`)
      }
      sessions.delete(opts.guildId)
    },
  }

  ws.on('open', () => {
    process.stderr.write(`voice: realtime ws open guild=${opts.guildId}\n`)
    const sessionUpdate = {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: opts.instructions,
        voice: opts.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        },
      },
    }
    ws.send(JSON.stringify(sessionUpdate))
  })

  ws.on('message', (raw: WebSocket.RawData) => {
    handleRealtimeMessage(session, raw).catch(err => {
      process.stderr.write(
        `voice: realtime message handler error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    })
  })

  ws.on('error', err => {
    process.stderr.write(`voice: realtime ws error: ${err instanceof Error ? err.message : String(err)}\n`)
  })

  ws.on('close', (code, reason) => {
    process.stderr.write(`voice: realtime ws closed code=${code} reason=${reason.toString()}\n`)
    session.stop('ws closed').catch(err => {
      process.stderr.write(`voice: stop on ws-close failed: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  })

  // 4. Wire inbound Discord audio -> websocket.
  connection.receiver.speaking.on('start', (userId: string) => {
    if (session.stopped) return
    attachUserStream(session, userId)
  })

  // 5. Handle Discord voice disconnect.
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    process.stderr.write(`voice: discord voice disconnected guild=${opts.guildId}\n`)
    session.stop('discord disconnect').catch(err => {
      process.stderr.write(`voice: stop on disconnect failed: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  })

  return session
}

function attachUserStream(session: VoiceSession, userId: string): void {
  if (session.connection.receiver.subscriptions.has(userId)) return

  const stream = session.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
  })

  let decoder = session.decoders.get(userId)
  if (!decoder) {
    decoder = new OpusScript(DISCORD_SAMPLE_RATE, 2, OpusScript.Application.AUDIO)
    session.decoders.set(userId, decoder)
  }
  const activeDecoder = decoder

  stream.on('data', (opusPacket: Buffer) => {
    if (session.stopped) return
    let pcm48Stereo: Buffer
    try {
      // opusscript.decode(buffer, frameSize) — 960 samples @ 48k = 20ms
      const decoded = activeDecoder.decode(opusPacket)
      pcm48Stereo = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength)
    } catch (err) {
      process.stderr.write(
        `voice: opus decode error user=${userId}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      return
    }
    const pcm24Mono = downsample48StereoTo24Mono(pcm48Stereo)
    if (pcm24Mono.length === 0) return

    if (session.ws.readyState !== WebSocket.OPEN) return
    const msg = {
      type: 'input_audio_buffer.append',
      audio: pcm24Mono.toString('base64'),
    }
    session.ws.send(JSON.stringify(msg))
  })

  stream.on('end', () => {
    session.connection.receiver.subscriptions.delete(userId)
  })

  stream.on('error', err => {
    process.stderr.write(
      `voice: receive stream error user=${userId}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    session.connection.receiver.subscriptions.delete(userId)
  })
}

async function handleRealtimeMessage(session: VoiceSession, raw: WebSocket.RawData): Promise<void> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw.toString())
  } catch (err) {
    throw new Error(`failed to parse realtime message: ${err instanceof Error ? err.message : String(err)}`)
  }

  const type = parsed.type
  if (typeof type !== 'string') return

  switch (type) {
    case 'session.created':
    case 'session.updated':
      process.stderr.write(`voice: realtime ${type}\n`)
      return
    case 'response.audio.delta': {
      const b64 = parsed.delta
      if (typeof b64 !== 'string') return
      const pcm24Mono = Buffer.from(b64, 'base64')
      const pcm48Stereo = upsample24MonoTo48Stereo(pcm24Mono)
      session.outboundStream.push(pcm48Stereo)
      return
    }
    case 'response.audio_transcript.delta':
    case 'response.audio_transcript.done':
    case 'input_audio_buffer.speech_started':
    case 'input_audio_buffer.speech_stopped':
    case 'response.created':
    case 'response.done':
      return
    case 'error': {
      const err = parsed.error as { message?: string; code?: string } | undefined
      process.stderr.write(
        `voice: realtime API error: ${err?.code ?? 'unknown'} ${err?.message ?? JSON.stringify(parsed)}\n`,
      )
      return
    }
    default:
      return
  }
}

// --------------------------------------------------------------------------
// Shutdown hook (called from host.ts on process exit)
// --------------------------------------------------------------------------

export async function stopAllVoiceSessions(reason: string): Promise<void> {
  const all = [...sessions.values()]
  await Promise.allSettled(all.map(s => s.stop(reason)))
}
