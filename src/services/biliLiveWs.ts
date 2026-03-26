import { buildDanmuInfoUrl, QueryBiliAPI, warmupBiliSession } from './biliApi'
import { getStoredBuvid, getStoredCookieJar, readCookieValue } from './biliCookieStore'
import { getNavProfileAsync } from './biliNavProfile'

function buildWssAddress(host: string, wssPort: number): string {
  const trimmed = host.trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new Error('host 为空')
  }

  let base = trimmed
  if (/^wss?:\/\//i.test(base)) {
    base = base.replace(/^ws:\/\//i, 'wss://')
  } else {
    const portSuffix = Number.isFinite(wssPort) && wssPort > 0 && wssPort !== 443
      ? `:${wssPort}`
      : ''
    base = `wss://${base}${portSuffix}`
  }

  return base.endsWith('/sub') ? base : `${base}/sub`
}

type DanmuInfoPayload = {
  code?: unknown
  message?: unknown
  msg?: unknown
  data?: {
    token?: unknown
    host_list?: Array<{ host?: unknown; wss_port?: unknown }>
  }
}

export async function getLiveWsRoomConfigAsync(roomId: number): Promise<{
  roomId?: number
  address: string
  key: string
  uid: number
  buvid?: string
  protover: 3
}> {
  if (!Number.isFinite(roomId) || roomId <= 0) {
    throw new Error(`无效房间号: ${roomId}`)
  }
  await warmupBiliSession()

  const url = await buildDanmuInfoUrl(roomId)

  const queryDanmuInfo = async (): Promise<{ payload: DanmuInfoPayload; vVoucher: string; hasCookie: boolean }> => {
    const response = await QueryBiliAPI(url)
    if (!response.ok) {
      const message = await response.text().catch(() => '')
      throw new Error(`获取房间 ${roomId} 鉴权信息失败: HTTP ${response.status}${message ? ` ${message}` : ''}`)
    }
    const payload = await response.json() as DanmuInfoPayload
    const vVoucher = response.headers.get('x-bili-gaia-vvoucher')
      ?? response.headers.get('X-Bili-Gaia-VVoucher')
      ?? ''
    return {
      payload,
      vVoucher: vVoucher.trim(),
      hasCookie: getStoredCookieJar().trim().length > 0
    }
  }

  let first = await queryDanmuInfo()
  let payload = first.payload
  let vVoucher = first.vVoucher
  let hasCookie = first.hasCookie
  if (payload.code === -352) {
    console.warn(
      `[BiliLiveWS] 房间 ${roomId} 首次 getDanmuInfo 返回 -352，准备重试 (cookie=${hasCookie ? 'present' : 'missing'}, vvoucher=${vVoucher || 'none'})`
    )
    await warmupBiliSession()
    const second = await queryDanmuInfo()
    payload = second.payload
    vVoucher = second.vVoucher
    hasCookie = second.hasCookie
  }

  if (payload.code !== 0) {
    const message = typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : (typeof payload.msg === 'string' && payload.msg.trim()
        ? payload.msg.trim()
        : `code=${String(payload.code)}`)
    if (payload.code === -352) {
      throw new Error(`获取房间 ${roomId} 鉴权信息失败: ${message} (wbi=on,cookie=${hasCookie ? 'present' : 'missing'},vvoucher=${vVoucher || 'none'})`)
    }
    throw new Error(`获取房间 ${roomId} 鉴权信息失败: ${message}`)
  }

  const token = typeof payload.data?.token === 'string' ? payload.data.token.trim() : ''
  if (!token) {
    throw new Error(`获取房间 ${roomId} 鉴权信息失败: token 为空`)
  }

  const validHosts = (payload.data?.host_list ?? []).filter((item): item is { host: string; wss_port?: unknown } => {
    return typeof item?.host === 'string' && item.host.trim().length > 0
  })
  if (validHosts.length === 0) {
    throw new Error(`获取房间 ${roomId} 鉴权信息失败: host_list 为空`)
  }
  const hostInfo = validHosts[Math.floor(Math.random() * validHosts.length)]!

  const address = buildWssAddress(hostInfo.host, Number(hostInfo.wss_port))

  const roomInitResponse = await QueryBiliAPI(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`)
  if (!roomInitResponse.ok) {
    throw new Error(`获取房间 ${roomId} 初始化信息失败: HTTP ${roomInitResponse.status}`)
  }
  const roomInitPayload = await roomInitResponse.json() as {
    code?: unknown
    message?: unknown
    data?: { room_id?: unknown }
  }
  if (roomInitPayload.code !== 0) {
    throw new Error(`获取房间 ${roomId} 初始化信息失败: ${String(roomInitPayload.message ?? roomInitPayload.code)}`)
  }
  const resolvedRoomIdRaw = roomInitPayload.data?.room_id
  const resolvedRoomId = typeof resolvedRoomIdRaw === 'number' ? resolvedRoomIdRaw : Number(resolvedRoomIdRaw)
  if (!Number.isFinite(resolvedRoomId) || resolvedRoomId <= 0) {
    throw new Error(`获取房间 ${roomId} 初始化信息失败: room_id 无效`)
  }

  let apiUid = 0
  try {
    const navProfile = await getNavProfileAsync()
    apiUid = navProfile?.uid ?? 0
  } catch (error) {
    console.warn(`[BiliLiveWS] 房间 ${roomId} 通过 nav 获取 UID 失败，回退 cookie`, error)
  }

  const cookie = getStoredCookieJar().trim()
  const uidText = readCookieValue(cookie, 'DedeUserID')
  const cookieUid = uidText && /^[0-9]+$/.test(uidText) ? Number(uidText) : 0
  const uid = apiUid > 0 ? apiUid : cookieUid
  const uidSource = apiUid > 0 ? 'nav' : (cookieUid > 0 ? 'cookie' : 'none')
  const buvid = getStoredBuvid()
    || (readCookieValue(cookie, 'buvid3')
      ?? readCookieValue(cookie, 'buvid4')
      ?? readCookieValue(cookie, 'buvid_fp'))

  const addressHost = address.replace(/^wss?:\/\//i, '').split('/')[0] || 'unknown'
  console.info(
    `[BiliLiveWS] 房间 ${roomId} 鉴权成功: wsRoom=${resolvedRoomId}, tokenLen=${token.length}, hostCount=${validHosts.length}, selectedHost=${addressHost}, uid=${uid}(${uidSource}), buvid=${buvid ? 'present' : 'missing'}`
  )

  return {
    roomId: resolvedRoomId,
    address,
    key: token,
    uid,
    buvid,
    protover: 3
  }
}
