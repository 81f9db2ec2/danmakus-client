import { BilibiliAuthApi, type BiliAuthProfile } from 'danmakus-core'
import { reactive } from 'vue'
import { biliCookie } from './biliCookieStore'
import { onBiliCookieJarChanged } from './biliCookieStore'
import { fetchImpl } from './fetchImpl'

export type BiliNavProfile = BiliAuthProfile

const navProfileCacheTtlMs = 5 * 60_000
let navProfileInflight: Promise<BiliNavProfile | null> | null = null
let navProfileRefreshTimer: number | undefined
let navProfileRefreshRefCount = 0
const bilibiliAuthApi = new BilibiliAuthApi(fetchImpl)

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
  return await bilibiliAuthApi.getNavProfile(biliCookie.getBiliCookie())
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
