import { reactive } from 'vue'
import { QueryBiliAPI } from './biliApi'
import { onBiliCookieJarChanged } from './biliCookieStore'

export interface BiliNavProfile {
  uid: number
  uname: string
  face: string
  level: number
  money: number
  vipStatus: number
  vipLabel: string
}

type BiliNavResponse = {
  code?: unknown
  message?: unknown
  data?: {
    isLogin?: unknown
    mid?: unknown
    uname?: unknown
    face?: unknown
    money?: unknown
    vipStatus?: unknown
    vip_label?: { text?: unknown }
    level_info?: { current_level?: unknown }
  }
}

const navProfileCacheTtlMs = 5 * 60_000
let navProfileInflight: Promise<BiliNavProfile | null> | null = null
let navProfileRefreshTimer: number | undefined
let navProfileRefreshRefCount = 0

export const biliNavProfileState = reactive({
  profile: null as BiliNavProfile | null,
  refreshing: false,
  lastFetchedAt: 0,
  lastError: null as string | null
})

function setNavProfileCache(profile: BiliNavProfile | null): void {
  biliNavProfileState.profile = profile
  biliNavProfileState.lastFetchedAt = Date.now()
  biliNavProfileState.lastError = null
}

function invalidateNavProfileCache(resetProfile: boolean): void {
  navProfileInflight = null
  biliNavProfileState.lastFetchedAt = 0
  biliNavProfileState.lastError = null
  if (resetProfile) {
    biliNavProfileState.profile = null
  }
}

onBiliCookieJarChanged((nextCookie) => {
  invalidateNavProfileCache(nextCookie.length === 0)
})

async function requestNavProfileAsync(): Promise<BiliNavProfile | null> {
  const url = 'https://api.bilibili.com/x/web-interface/nav'
  const response = await QueryBiliAPI(url)
  if (!response.ok) {
    throw new Error(`检查 Bilibili 登录状态失败: HTTP ${response.status}`)
  }

  const payload = await response.json() as BiliNavResponse
  const code = typeof payload.code === 'number' ? payload.code : Number(payload.code)
  if (!Number.isFinite(code)) {
    throw new Error('检查 Bilibili 登录状态失败: nav 返回无效 code')
  }

  if (code !== 0) {
    if (code === -101) {
      return null
    }
    throw new Error(`检查 Bilibili 登录状态失败: ${String(payload.message ?? code)}`)
  }

  const data = payload.data
  const isLogin = data?.isLogin === true || data?.isLogin === 1 || data?.isLogin === '1'
  if (!isLogin) {
    return null
  }

  const uidValue = typeof data?.mid === 'number' ? data.mid : Number(data?.mid)
  if (!Number.isFinite(uidValue) || uidValue <= 0) {
    throw new Error('检查 Bilibili 登录状态失败: nav 返回无效 mid')
  }
  const uid = Math.floor(uidValue)

  const levelValue = typeof data?.level_info?.current_level === 'number'
    ? data.level_info.current_level
    : Number(data?.level_info?.current_level)
  const moneyValue = typeof data?.money === 'number' ? data.money : Number(data?.money)
  const vipValue = typeof data?.vipStatus === 'number' ? data.vipStatus : Number(data?.vipStatus)

  return {
    uid,
    uname: typeof data?.uname === 'string' && data.uname.trim() ? data.uname.trim() : `UID ${uid}`,
    face: typeof data?.face === 'string' ? data.face : '',
    level: Number.isFinite(levelValue) ? Math.floor(levelValue) : 0,
    money: Number.isFinite(moneyValue) ? moneyValue : 0,
    vipStatus: Number.isFinite(vipValue) ? Math.floor(vipValue) : 0,
    vipLabel: typeof data?.vip_label?.text === 'string' ? data.vip_label.text : ''
  }
}

export async function getNavProfileAsync(options?: { force?: boolean }): Promise<BiliNavProfile | null> {
  const force = options?.force === true
  const now = Date.now()

  if (!force && biliNavProfileState.lastFetchedAt > 0 && now - biliNavProfileState.lastFetchedAt < navProfileCacheTtlMs) {
    return biliNavProfileState.profile
  }

  if (navProfileInflight) {
    return navProfileInflight
  }

  biliNavProfileState.refreshing = true
  navProfileInflight = (async () => {
    try {
      const profile = await requestNavProfileAsync()
      setNavProfileCache(profile)
      return profile
    } catch (error) {
      biliNavProfileState.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      biliNavProfileState.refreshing = false
      navProfileInflight = null
    }
  })()

  return navProfileInflight
}

export function startNavProfileAutoRefresh(): void {
  navProfileRefreshRefCount += 1
  if (navProfileRefreshTimer !== undefined) {
    return
  }

  void getNavProfileAsync().catch((error) => {
    console.error('[bili] 初始化刷新 nav 资料失败', error)
  })

  if (typeof window === 'undefined') {
    return
  }

  navProfileRefreshTimer = window.setInterval(() => {
    void getNavProfileAsync({ force: true }).catch((error) => {
      console.error('[bili] 定时刷新 nav 资料失败', error)
    })
  }, navProfileCacheTtlMs)
}

export function stopNavProfileAutoRefresh(): void {
  navProfileRefreshRefCount = Math.max(0, navProfileRefreshRefCount - 1)
  if (navProfileRefreshRefCount > 0) {
    return
  }
  if (navProfileRefreshTimer !== undefined) {
    clearInterval(navProfileRefreshTimer)
    navProfileRefreshTimer = undefined
  }
}
