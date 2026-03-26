import type {
  AuthSourceStateSnapshot,
  AuthStateSnapshot,
  CoreRuntimeStateDto as CoreClientRuntimeStateDto,
  RuntimeRoomPullShortfallDto,
} from 'danmakus-core'
import { RUNTIME_URL } from './env'
import type { CoreControlConfigDto, RecordingInfoDto } from '../types/api'

export type ConnectionInfoSnapshot = {
  roomId: number
  priority: string
  connectedAt: number
}

export type RemoteClientSnapshot = {
  clientId: string
  clientVersion: string | null
  ip: string | null
  isRunning: boolean
  runtimeConnected: boolean
  cookieValid: boolean
  connectedRooms: number[]
  connectionInfo: ConnectionInfoSnapshot[]
  holdingRooms: number[]
  messageCount: number
  lastRoomAssigned: number | null
  lastError: string | null
  lastHeartbeat: number | null
}

const createEmptyAuthSourceState = (): AuthSourceStateSnapshot => ({
  configured: false,
  hasCookie: false,
  valid: false,
  phase: 'idle',
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastValidatedAt: null,
  lastError: null,
  profile: null,
})

export const createEmptyAuthState = (): AuthStateSnapshot => ({
  activeSource: null,
  hasUsableCookie: false,
  phase: 'idle',
  lastError: null,
  local: createEmptyAuthSourceState(),
  cookieCloud: createEmptyAuthSourceState(),
})

const cloneAuthSourceState = (source: AuthSourceStateSnapshot): AuthSourceStateSnapshot => ({
  ...source,
  profile: source.profile ? { ...source.profile } : null,
})

export const cloneAuthState = (state: AuthStateSnapshot): AuthStateSnapshot => ({
  ...state,
  local: cloneAuthSourceState(state.local),
  cookieCloud: cloneAuthSourceState(state.cookieCloud),
})

const parseServerTimeMs = (value: unknown, fieldName: string): number | null => {
  if (value === null || value === undefined || value === '') {
    return null
  }

  let ms: number
  if (typeof value === 'number') {
    ms = value
  } else {
    const raw = String(value).trim()
    if (raw && /^[0-9]+$/.test(raw)) {
      ms = Number(raw)
    } else {
      ms = Date.parse(raw)
    }
  }

  if (ms > 100000000 && ms < 10000000000) {
    ms *= 1000
  }
  if (!Number.isFinite(ms)) {
    throw new Error(`账号中心返回的 ${fieldName} 无效`)
  }
  return ms
}

const normalizeNonNegativeInteger = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }
  return Math.floor(parsed)
}

export const cloneHoldingRoomShortfall = (
  shortfall: RuntimeRoomPullShortfallDto | null | undefined
): RuntimeRoomPullShortfallDto | null => {
  if (!shortfall) {
    return null
  }
  return {
    reason: typeof shortfall.reason === 'string' ? shortfall.reason : null,
    missingCount: normalizeNonNegativeInteger(shortfall.missingCount),
    candidateCount: normalizeNonNegativeInteger(shortfall.candidateCount),
    assignableCandidateCount: normalizeNonNegativeInteger(shortfall.assignableCandidateCount),
    blockedBySameAccountCount: normalizeNonNegativeInteger(shortfall.blockedBySameAccountCount),
    blockedByOtherAccountsCount: normalizeNonNegativeInteger(shortfall.blockedByOtherAccountsCount),
  }
}

export const normalizeConnectionInfo = (info: {
  roomId: number
  priority: unknown
  connectedAt: string | number
}): ConnectionInfoSnapshot => {
  const connectedAt = parseServerTimeMs(info.connectedAt, 'connectedAt')
  if (connectedAt === null) {
    throw new Error('账号中心返回的 connectedAt 无效')
  }
  return {
    roomId: info.roomId,
    priority: String(info.priority),
    connectedAt,
  }
}

export const sortRecordings = (items: RecordingInfoDto[]): RecordingInfoDto[] => {
  return [...items].sort((a, b) => {
    const liveA = a.channel?.isLiving ? 1 : 0
    const liveB = b.channel?.isLiving ? 1 : 0
    if (liveA !== liveB) {
      return liveB - liveA
    }
    const uidA = Number(a.channel?.uId ?? 0)
    const uidB = Number(b.channel?.uId ?? 0)
    return uidA - uidB
  })
}

export const cloneRecordingInfo = (item: RecordingInfoDto): RecordingInfoDto => ({
  channel: {
    ...item.channel,
    livingInfo: item.channel.livingInfo ? { ...item.channel.livingInfo } : null,
  },
  setting: { ...item.setting },
  todayDanmakusCount: Number(item.todayDanmakusCount ?? 0),
  providedDanmakuDataCount: Number(item.providedDanmakuDataCount ?? 0),
  providedMessageCount: Number(item.providedMessageCount ?? 0),
})

export const createDefaultCoreConfig = (): CoreControlConfigDto => ({
  maxConnections: 5,
  runtimeUrl: RUNTIME_URL,
  autoReconnect: true,
  reconnectInterval: 5000,
  statusCheckInterval: 30,
  streamers: [],
  requestServerRooms: true,
  allowedAreas: [],
  allowedParentAreas: [],
  excludedServerRoomUserIds: [],
})

export const toRemoteClientSnapshot = (remote: CoreClientRuntimeStateDto): RemoteClientSnapshot => ({
  clientId: String(remote.clientId ?? '').trim(),
  clientVersion: remote.clientVersion == null ? null : String(remote.clientVersion),
  ip: remote.ip == null ? null : String(remote.ip),
  isRunning: Boolean(remote.isRunning),
  runtimeConnected: Boolean(remote.runtimeConnected),
  cookieValid: Boolean(remote.cookieValid),
  connectedRooms: remote.connectedRooms
    .map(roomId => Number(roomId))
    .filter(roomId => Number.isFinite(roomId) && roomId > 0)
    .map(roomId => Math.floor(roomId)),
  connectionInfo: remote.connectionInfo.map(normalizeConnectionInfo),
  holdingRooms: remote.holdingRooms
    .map(roomId => Number(roomId))
    .filter(roomId => Number.isFinite(roomId) && roomId > 0)
    .map(roomId => Math.floor(roomId)),
  messageCount: Number.isFinite(Number(remote.messageCount)) ? Number(remote.messageCount) : 0,
  lastRoomAssigned: Number.isFinite(Number(remote.lastRoomAssigned)) ? Number(remote.lastRoomAssigned) : null,
  lastError: typeof remote.lastError === 'string' ? remote.lastError : (remote.lastError == null ? null : String(remote.lastError)),
  lastHeartbeat: parseServerTimeMs(remote.lastHeartbeat, 'lastHeartbeat'),
})
