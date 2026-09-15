<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { getDanmakuAreas } from '../services/account';
import { danmakuService } from '../services/DanmakuService';
import { RUNTIME_URL } from '../services/env';
import { getAuthToken, setAuthToken, setServerLoggedIn } from '../services/http';
import { applyAutoStartEnabled, hideMainWindow, isDesktopRuntime, isMacosDesktopRuntime, loadLocalAppConfig, readAutoStartEnabled, registerCloseToTrayHandler, saveLocalAppConfig, sendSystemNotification, syncTrayHealthFromRuntime, setupTrayInTs } from '../services/localApp';
import { liveSessionOutbox, type LiveSessionOutboxDatabaseInfo } from '../services/liveSessionOutbox';
import { APP_UPDATE_CHECK_INTERVAL_MS, checkForUpdate, installLatestUpdate, updaterEnabled, type AvailableUpdate } from '../services/updater';
import { activeFallbackAlert, dismissFallbackAlert } from '../services/apiNodes';
import type { CoreControlConfigDto, LocalAppConfigDto } from '../types/api';
import ApiNodeSelectorModal from './ApiNodeSelectorModal.vue';
import AppSidebar from './AppSidebar.vue';
import CoreControlAccountTab from './core-control/CoreControlAccountTab.vue';
import CoreControlAppTab from './core-control/CoreControlAppTab.vue';
import CoreControlBilibiliTab from './core-control/CoreControlBilibiliTab.vue';
import CoreControlDashboardTab from './core-control/CoreControlDashboardTab.vue';
import CoreControlLoginCard from './core-control/CoreControlLoginCard.vue';
import CoreControlRecordingsTab from './core-control/CoreControlRecordingsTab.vue';
import CoreControlSettingsTab from './core-control/CoreControlSettingsTab.vue';

const token = ref(getAuthToken());
const currentPage = ref('dashboard');
const showApiNodeModal = ref(false);
const isDesktopApp = isDesktopRuntime();
const isMacosDesktopApp = isMacosDesktopRuntime();
const runtimeFixedUrl = RUNTIME_URL;
const createCoreConfigDraft = (): CoreControlConfigDto => ({
  maxConnections: 5,
  runtimeUrl: runtimeFixedUrl,
  autoReconnect: true,
  reconnectInterval: 5000,
  statusCheckInterval: 30,
  streamers: [],
  requestServerRooms: true,
  allowedAreas: [],
  allowedParentAreas: [],
  excludedServerRoomUserIds: []
});
const cloneCoreConfigDraft = (config: CoreControlConfigDto): CoreControlConfigDto => ({
  ...config,
  runtimeUrl: config.runtimeUrl || runtimeFixedUrl,
  allowedAreas: Array.isArray(config.allowedAreas) ? [...config.allowedAreas] : [],
  allowedParentAreas: Array.isArray(config.allowedParentAreas) ? [...config.allowedParentAreas] : [],
  excludedServerRoomUserIds: Array.isArray(config.excludedServerRoomUserIds) ? [...config.excludedServerRoomUserIds] : [],
  streamers: []
});
const buildCoreConfigSyncKey = (config: CoreControlConfigDto): string =>
  JSON.stringify({
    maxConnections: config.maxConnections,
    runtimeUrl: config.runtimeUrl || runtimeFixedUrl,
    autoReconnect: config.autoReconnect,
    reconnectInterval: config.reconnectInterval,
    statusCheckInterval: config.statusCheckInterval,
    requestServerRooms: config.requestServerRooms,
    allowedAreas: config.allowedAreas,
    allowedParentAreas: config.allowedParentAreas,
    excludedServerRoomUserIds: config.excludedServerRoomUserIds
  });
const coreConfigDraft = reactive<CoreControlConfigDto>(createCoreConfigDraft());
const localConfig = reactive<LocalAppConfigDto>(loadLocalAppConfig());
const runtimeState = danmakuService.state;
const userInfo = computed(() => runtimeState.userInfo);
const isLoggedIn = computed(() => !!userInfo.value);
const accountNameForDisplay = computed(() => {
  if (!userInfo.value) return '未知用户';
  const name = userInfo.value.name?.trim();
  return name ? name : `用户${userInfo.value.id}`;
});
const accountIdForDisplay = computed<number | null>(() => userInfo.value?.id ?? null);
const availableAreas = ref<Record<string, string[]>>({});
const loadingProfile = ref(false);
const savingConfig = ref(false);
const startingCore = ref(false);
const stoppingCore = ref(false);
const refreshingState = ref(false);
const forcingLock = ref(false);
const recordings = computed(() => runtimeState.recordings);
const refreshingRecordings = ref(false);
const addingRecording = ref(false);
const removingRecordingUid = ref<number | null>(null);
const updatingRecordingUid = ref<number | null>(null);
const importingFollows = ref(false);
const importFollowsProgress = ref({ done: 0, total: 0 });
const isUpdaterSupported = updaterEnabled();
const checkingAppUpdate = ref(false);
const installingAppUpdate = ref(false);
const autoCheckingAppUpdate = ref(false);
const appUpdateBusy = computed(() => checkingAppUpdate.value || installingAppUpdate.value || autoCheckingAppUpdate.value);
const availableUpdateVersion = ref<string | null>(null);
const databaseInfo = ref<LiveSessionOutboxDatabaseInfo | null>(null);
const loadingDatabaseInfo = ref(false);
const rebuildingDatabase = ref(false);
let autoAppUpdateTimer: number | undefined;
let announcedAppUpdateVersion: string | null = null;
const coreConfigAutoSaveThrottleMs = 1_200;
let coreConfigAutoSaveTimer: number | undefined;
let coreConfigAutoSavePending = false;
let localConfigApplyTimer: number | undefined;
let hydratingCoreConfigDraft = false;
let syncingAutoStartFromDesktop = false;
let closeToTrayUnlisten: (() => void) | null = null;

const localClientId = danmakuService.getClientId();
const remoteClients = computed(() => runtimeState.remoteClients);
const recordingRoomIds = computed(() =>
  recordings.value
    .map((item) => Number(item.channel?.roomId))
    .filter((roomId) => Number.isFinite(roomId) && roomId > 0)
    .map((roomId) => Math.floor(roomId))
);
const recordingStatsByRoom = computed(() => {
  const result: Record<
    string,
    {
      uid: number;
      username: string;
      faceUrl: string;
      todayDanmakusCount: number;
      providedDanmakuDataCount: number;
      providedMessageCount: number;
    }
  > = {};

  for (const item of recordings.value) {
    const roomId = Number(item.channel?.roomId);
    if (!Number.isFinite(roomId) || roomId <= 0) {
      continue;
    }
    result[String(Math.floor(roomId))] = {
      uid: Number(item.channel?.uId ?? 0),
      username: item.channel?.uName ?? '',
      faceUrl: item.channel?.faceUrl ?? '',
      todayDanmakusCount: Number(item.todayDanmakusCount ?? 0),
      providedDanmakuDataCount: Number(item.providedDanmakuDataCount ?? 0),
      providedMessageCount: Number(item.providedMessageCount ?? 0)
    };
  }

  return result;
});
const recordingLiveSnapshots = computed(() =>
  recordings.value
    .map((item) => {
      const uid = Math.floor(Number(item.channel?.uId));
      const roomId = Math.floor(Number(item.channel?.roomId));
      if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(roomId) || roomId <= 0) {
        return null;
      }

      return {
        uid,
        roomId,
        username: item.channel?.uName?.trim() || `UID ${uid}`,
        isLiving: Boolean(item.channel?.isLiving)
      };
    })
    .filter((item): item is { uid: number; roomId: number; username: string; isLiving: boolean } => item !== null)
);
const knownRecordingLiveStateByUid = new Map<number, boolean>();
const ensureToken = () => {
  if (!token.value) {
    toast.error('请先输入 Token');
    return false;
  }
  return true;
};

const isAppUpdateBusy = (options?: { ignoreAutoCheck?: boolean }) => (options?.ignoreAutoCheck ? checkingAppUpdate.value || installingAppUpdate.value : appUpdateBusy.value);
const APP_UPDATE_TOAST_ID = 'app-update-available';
const APP_UPDATE_AUTO_INSTALL_TOAST_ID = 'app-update-auto-install';

const applyAvailableUpdate = (update: AvailableUpdate | null) => {
  availableUpdateVersion.value = update?.version ?? null;
};

const stopCoreForAppUpdate = async () => {
  if (!runtimeState.isRunning) {
    return;
  }

  stoppingCore.value = true;
  try {
    await danmakuService.stop();
  } finally {
    stoppingCore.value = false;
  }

  try {
    await danmakuService.refreshRuntimeState();
  } catch (error) {
    console.error(error);
  }
};

const performAppUpdateInstall = async (options?: { notifyIfNoUpdate?: boolean; allowDuringAutoCheck?: boolean }) => {
  if (!isUpdaterSupported) {
    toast.info('仅 Tauri 桌面客户端支持安装更新');
    return;
  }
  if (
    isAppUpdateBusy({
      ignoreAutoCheck: options?.allowDuringAutoCheck
    })
  ) {
    return;
  }

  installingAppUpdate.value = true;
  try {
    await stopCoreForAppUpdate();
    const update = await installLatestUpdate({
      relaunchAfterInstall: true
    });
    if (!update) {
      applyAvailableUpdate(null);
      if (options?.notifyIfNoUpdate ?? true) {
        toast.success('当前已是最新版本');
      }
      return;
    }

    applyAvailableUpdate(null);
    announcedAppUpdateVersion = update.version;
    toast.success(`更新 ${update.version} 已安装，正在重启应用`);
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '安装更新失败');
  } finally {
    installingAppUpdate.value = false;
  }
};

const showRunningAppUpdateToast = (update: AvailableUpdate) => {
  toast.info(`发现新版本 ${update.version}`, {
    id: `${APP_UPDATE_TOAST_ID}-${update.version}`,
    description: '核心正在运行，请在合适的时间安装更新',
    duration: 12_000,
    action: {
      label: '开始更新',
      onClick: () => {
        void performAppUpdateInstall({
          notifyIfNoUpdate: true
        });
      }
    }
  });
};

const handleDiscoveredAppUpdate = async (update: AvailableUpdate, source: 'auto' | 'manual') => {
  applyAvailableUpdate(update);
  const shouldAnnounce = announcedAppUpdateVersion !== update.version;
  announcedAppUpdateVersion = update.version;

  if (runtimeState.isRunning) {
    if (source === 'manual' || shouldAnnounce) {
      showRunningAppUpdateToast(update);
    }
    return;
  }

  if (source === 'manual' || shouldAnnounce) {
    toast.info(`发现新版本 ${update.version}，正在自动更新并重启应用`, {
      id: `${APP_UPDATE_AUTO_INSTALL_TOAST_ID}-${update.version}`,
      duration: 4_000
    });
  }

  await performAppUpdateInstall({
    notifyIfNoUpdate: false,
    allowDuringAutoCheck: source === 'auto'
  });
};

const startAutoAppUpdatePoll = () => {
  if (!isUpdaterSupported || autoAppUpdateTimer !== undefined) {
    return;
  }

  void runAutoAppUpdateCheck();
  autoAppUpdateTimer = window.setInterval(() => {
    void runAutoAppUpdateCheck();
  }, APP_UPDATE_CHECK_INTERVAL_MS);
};

const stopAutoAppUpdatePoll = () => {
  if (autoAppUpdateTimer === undefined) {
    return;
  }

  clearInterval(autoAppUpdateTimer);
  autoAppUpdateTimer = undefined;
};

const runAutoAppUpdateCheck = async () => {
  if (!isUpdaterSupported || isAppUpdateBusy()) {
    return;
  }

  autoCheckingAppUpdate.value = true;
  try {
    const update = await checkForUpdate();
    if (!update) {
      applyAvailableUpdate(null);
      return;
    }
    await handleDiscoveredAppUpdate(update, 'auto');
  } catch (error) {
    console.error(error);
  } finally {
    autoCheckingAppUpdate.value = false;
  }
};

const clearCoreConfigAutoSaveTimer = () => {
  if (coreConfigAutoSaveTimer === undefined) return;
  clearTimeout(coreConfigAutoSaveTimer);
  coreConfigAutoSaveTimer = undefined;
};

const buildCoreConfigPayload = (): CoreControlConfigDto => ({
  ...coreConfigDraft,
  runtimeUrl: coreConfigDraft.runtimeUrl,
  allowedAreas: [...coreConfigDraft.allowedAreas],
  allowedParentAreas: [...coreConfigDraft.allowedParentAreas],
  excludedServerRoomUserIds: [...(coreConfigDraft.excludedServerRoomUserIds ?? [])],
  streamers: []
});

const persistCoreConfig = async (silentSuccess: boolean) => {
  if (!token.value) return;
  if (savingConfig.value) return;
  try {
    savingConfig.value = true;
    await danmakuService.saveCoreConfig(buildCoreConfigPayload());
    if (!silentSuccess) {
      toast.success('配置已保存');
    }
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    savingConfig.value = false;
  }
};

const flushCoreConfigAutoSave = async () => {
  if (!coreConfigAutoSavePending) return;
  if (!isLoggedIn.value || !token.value) {
    coreConfigAutoSavePending = false;
    return;
  }
  if (savingConfig.value) {
    scheduleCoreConfigAutoSave();
    return;
  }

  coreConfigAutoSavePending = false;
  await persistCoreConfig(true);

  if (coreConfigAutoSavePending) {
    scheduleCoreConfigAutoSave();
  }
};

const scheduleCoreConfigAutoSave = () => {
  if (!isLoggedIn.value || !token.value) return;
  coreConfigAutoSavePending = true;
  if (coreConfigAutoSaveTimer !== undefined) return;
  coreConfigAutoSaveTimer = window.setTimeout(() => {
    coreConfigAutoSaveTimer = undefined;
    void flushCoreConfigAutoSave();
  }, coreConfigAutoSaveThrottleMs);
};

const applyCoreConfigDraft = (config: CoreControlConfigDto) => {
  hydratingCoreConfigDraft = true;
  try {
    const nextConfig = cloneCoreConfigDraft(config);
    coreConfigDraft.maxConnections = nextConfig.maxConnections;
    coreConfigDraft.runtimeUrl = nextConfig.runtimeUrl;
    coreConfigDraft.autoReconnect = nextConfig.autoReconnect;
    coreConfigDraft.reconnectInterval = nextConfig.reconnectInterval;
    coreConfigDraft.statusCheckInterval = nextConfig.statusCheckInterval;
    coreConfigDraft.requestServerRooms = nextConfig.requestServerRooms;
    coreConfigDraft.allowedAreas = nextConfig.allowedAreas;
    coreConfigDraft.allowedParentAreas = nextConfig.allowedParentAreas;
    coreConfigDraft.excludedServerRoomUserIds = nextConfig.excludedServerRoomUserIds ?? [];
    coreConfigDraft.streamers.splice(0);
  } finally {
    queueMicrotask(() => {
      hydratingCoreConfigDraft = false;
    });
  }
};
const refreshRecordingList = async () => {
  if (!ensureToken()) return;
  refreshingRecordings.value = true;
  try {
    await danmakuService.refreshRecordingState();
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '刷新录制列表失败');
  } finally {
    refreshingRecordings.value = false;
  }
};

const loadProfile = async () => {
  if (!ensureToken()) return;
  try {
    loadingProfile.value = true;
    setAuthToken(token.value);
    await danmakuService.initialize(localConfig);
    await danmakuService.refreshControlState();
    setServerLoggedIn(true);
    try {
      availableAreas.value = await getDanmakuAreas();
    } catch (error) {
      console.error(error);
      availableAreas.value = {};
      toast.warning(error instanceof Error ? `加载分区列表失败: ${error.message}` : '加载分区列表失败');
    }
    toast.success('已加载用户与配置');
  } catch (error) {
    console.error(error);
    availableAreas.value = {};
    setServerLoggedIn(false);
    try {
      await danmakuService.dispose();
    } catch (disposeError) {
      console.error(disposeError);
    }
    toast.error(error instanceof Error ? error.message : '加载失败');
  } finally {
    loadingProfile.value = false;
  }
};

const handleSaveConfig = async () => {
  if (!ensureToken()) return;
  coreConfigAutoSavePending = false;
  clearCoreConfigAutoSaveTimer();
  await persistCoreConfig(false);
};

const handleCheckAppUpdate = async () => {
  if (!isUpdaterSupported) {
    toast.info('仅 Tauri 桌面客户端支持检查更新');
    return;
  }
  if (isAppUpdateBusy()) {
    return;
  }

  checkingAppUpdate.value = true;
  try {
    const update = await checkForUpdate();
    if (!update) {
      applyAvailableUpdate(null);
      toast.success('当前已是最新版本');
      return;
    }
    await handleDiscoveredAppUpdate(update, 'manual');
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '检查更新失败');
  } finally {
    checkingAppUpdate.value = false;
  }
};

const handleInstallAppUpdate = async () => {
  await performAppUpdateInstall({
    notifyIfNoUpdate: true
  });
};

const refreshDatabaseInfo = async (silent = false) => {
  if (!isDesktopApp || loadingDatabaseInfo.value || rebuildingDatabase.value) {
    return;
  }

  loadingDatabaseInfo.value = true;
  try {
    databaseInfo.value = await liveSessionOutbox.getDatabaseInfo();
  } catch (error) {
    console.error(error);
    if (!silent) {
      toast.error(error instanceof Error ? error.message : '读取本地数据库信息失败');
    }
  } finally {
    loadingDatabaseInfo.value = false;
  }
};

const handleRebuildDatabase = async () => {
  if (!isDesktopApp || rebuildingDatabase.value) {
    return;
  }

  rebuildingDatabase.value = true;
  try {
    databaseInfo.value = await liveSessionOutbox.rebuildDatabase();
    await danmakuService.refreshArchiveStats();
    toast.success('本地数据库已重建');
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '重建本地数据库失败');
  } finally {
    rebuildingDatabase.value = false;
  }
};

const handleStartCore = async () => {
  try {
    if (!ensureToken()) return;
    if (runtimeState.isRunning || startingCore.value) return;
    startingCore.value = true;
    await danmakuService.initialize(localConfig);
    await danmakuService.start();
    toast.success('核心已启动');
    await refreshRuntimeState();
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '启动失败');
  } finally {
    startingCore.value = false;
  }
};

const handleStopCore = async () => {
  try {
    stoppingCore.value = true;
    await danmakuService.stop();
    toast.info('核心已停止');
    await refreshRuntimeState();
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '停止失败');
  } finally {
    stoppingCore.value = false;
  }
};

const handleAddRecording = async (uid: number) => {
  if (!ensureToken()) return;
  if (!Number.isFinite(uid) || uid <= 0) {
    toast.error('请输入有效的主播 UID');
    return;
  }
  addingRecording.value = true;
  try {
    await danmakuService.addRecording(uid);
    const added = recordings.value.find((item) => item.channel.uId === uid);
    toast.success(`已添加录制主播: ${added?.channel.uName || uid}`);
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '添加录制主播失败');
  } finally {
    addingRecording.value = false;
  }
};

const handleImportFollows = async (uids: number[]) => {
  if (!ensureToken()) return;
  const targets = Array.from(new Set(uids.filter((uid) => Number.isFinite(uid) && uid > 0)));
  if (targets.length === 0) return;

  importingFollows.value = true;
  importFollowsProgress.value = { done: 0, total: targets.length };
  let success = 0;
  const failed: number[] = [];
  try {
    for (const uid of targets) {
      try {
        await danmakuService.addRecording(uid);
        success += 1;
      } catch (error) {
        console.error(error);
        failed.push(uid);
      } finally {
        importFollowsProgress.value = { done: importFollowsProgress.value.done + 1, total: targets.length };
      }
    }

    if (success > 0) {
      toast.success(`已添加 ${success} 个录制主播${failed.length ? `，${failed.length} 个失败` : ''}`);
    } else {
      toast.error('添加录制主播失败');
    }
  } finally {
    importingFollows.value = false;
  }
};

const handleRemoveRecording = async (uid: number) => {
  if (!ensureToken()) return;
  if (!Number.isFinite(uid) || uid <= 0) {
    toast.error('主播 UID 无效');
    return;
  }
  removingRecordingUid.value = uid;
  try {
    await danmakuService.removeRecording(uid);
    toast.success('已移除录制主播');
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '取消添加录制主播失败');
  } finally {
    removingRecordingUid.value = null;
  }
};

const handleUpdateRecordingPublic = async (uid: number, isPublic: boolean) => {
  if (!ensureToken()) return;
  if (!Number.isFinite(uid) || uid <= 0) {
    toast.error('主播 UID 无效');
    return;
  }

  updatingRecordingUid.value = uid;
  try {
    await danmakuService.updateRecordingPublic(uid, isPublic);
    toast.success(isPublic ? '已设为公开录制' : '已设为私有录制');
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '更新录制公开状态失败');
  } finally {
    updatingRecordingUid.value = null;
  }
};

const handleLogout = async () => {
  clearCoreConfigAutoSaveTimer();
  coreConfigAutoSavePending = false;
  try {
    await danmakuService.dispose();
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? `停止核心失败: ${error.message}` : '停止核心失败');
  }

  token.value = '';
  setAuthToken('');
  availableAreas.value = {};
  availableUpdateVersion.value = null;
  setServerLoggedIn(false);
  currentPage.value = 'dashboard';
  toast.success('已登出');
};

const refreshRuntimeState = async () => {
  refreshingState.value = true;
  try {
    await danmakuService.refreshRuntimeState();
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '刷新状态失败');
  } finally {
    refreshingState.value = false;
  }
};

const handleClearRuntimeError = (error: string) => {
  danmakuService.clearRuntimeError(error);
};

watch(
  () => [runtimeState.isRunning, availableUpdateVersion.value] as const,
  ([isRunning, nextVersion], [prevIsRunning, prevVersion]) => {
    if (!isUpdaterSupported || isRunning || !nextVersion || isAppUpdateBusy()) {
      return;
    }
    if (prevIsRunning === false && prevVersion === nextVersion) {
      return;
    }
    void performAppUpdateInstall({
      notifyIfNoUpdate: false
    });
  }
);

const handleSyncCookieCloud = async () => {
  if (!ensureToken()) return;
  try {
    await danmakuService.syncCookieCloud();
    toast.success('CookieCloud 同步完成');
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : 'CookieCloud 同步失败');
  }
};

const handleForceTakeover = async () => {
  if (!ensureToken()) return;
  forcingLock.value = true;
  try {
    await danmakuService.forceTakeoverRuntimeState();
    toast.success('已强制接管核心锁');
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '强制接管失败');
  } finally {
    forcingLock.value = false;
  }
};

const syncDesktopLocalConfig = async () => {
  if (!isDesktopApp) {
    return;
  }

  const autoStartEnabled = await readAutoStartEnabled();
  if (autoStartEnabled === null) {
    return;
  }
  syncingAutoStartFromDesktop = true;
  localConfig.autoStart = autoStartEnabled;
  syncingAutoStartFromDesktop = false;
};

watch(
  coreConfigDraft,
  () => {
    if (hydratingCoreConfigDraft) return;
    scheduleCoreConfigAutoSave();
  },
  { deep: true }
);

watch(
  () => buildCoreConfigSyncKey(runtimeState.coreConfig),
  () => {
    applyCoreConfigDraft(runtimeState.coreConfig);
  },
  { immediate: true, flush: 'post' }
);

watch(
  localConfig,
  () => {
    saveLocalAppConfig(localConfig);
    if (localConfigApplyTimer !== undefined) {
      clearTimeout(localConfigApplyTimer);
    }
    localConfigApplyTimer = window.setTimeout(() => {
      danmakuService.applyLocalConfig(localConfig);
    }, 400);
  },
  { deep: true }
);

watch(
  () => localConfig.autoStart,
  (nextValue, previousValue) => {
    if (!isDesktopApp || syncingAutoStartFromDesktop) {
      return;
    }
    void (async () => {
      try {
        await applyAutoStartEnabled(nextValue);
      } catch (error) {
        console.error(error);
        syncingAutoStartFromDesktop = true;
        localConfig.autoStart = previousValue ?? false;
        syncingAutoStartFromDesktop = false;
        toast.error(error instanceof Error ? error.message : '更新开机自启失败');
      }
    })();
  }
);

watch(
  () => [runtimeState.isRunning, runtimeState.runtimeConnected, runtimeState.lastError] as const,
  ([isRunning, runtimeConnected, lastError]) => {
    if (!isDesktopApp) {
      return;
    }
    void syncTrayHealthFromRuntime({
      isRunning,
      runtimeConnected,
      lastError
    }).catch((error) => {
      console.error(error);
    });
  },
  { immediate: true }
);

watch(
  currentPage,
  (page) => {
    if (page === 'app') {
      void refreshDatabaseInfo(true);
    }
  }
);

watch(
  recordingLiveSnapshots,
  (nextSnapshots) => {
    const enabledNotificationUids = new Set(localConfig.recordingLiveNotificationUids);
    const nextStateByUid = new Map<number, boolean>();

    for (const snapshot of nextSnapshots) {
      const previousIsLiving = knownRecordingLiveStateByUid.get(snapshot.uid);
      if (previousIsLiving === false && snapshot.isLiving && enabledNotificationUids.has(snapshot.uid)) {
        void sendSystemNotification(
          '录制主播开播提醒',
          `${snapshot.username} 已开播，房间 ${snapshot.roomId}`
        ).catch((error) => {
          console.error(error);
        });
      }

      nextStateByUid.set(snapshot.uid, snapshot.isLiving);
    }

    knownRecordingLiveStateByUid.clear();
    for (const [uid, isLiving] of nextStateByUid) {
      knownRecordingLiveStateByUid.set(uid, isLiving);
    }
  },
  { immediate: true }
);

onMounted(async () => {
  if (isDesktopApp) {
    try {
      await setupTrayInTs(() => localConfig.hideDockIconWhenWindowHidden);
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : '初始化托盘失败');
    }
    startAutoAppUpdatePoll();
    closeToTrayUnlisten = await registerCloseToTrayHandler(
      () => localConfig.minimizeToTray,
      () => localConfig.hideDockIconWhenWindowHidden
    );
    await syncDesktopLocalConfig();
    if (localConfig.startMinimized) {
      try {
        await hideMainWindow({
          notify: false,
          hideDockIcon: localConfig.hideDockIconWhenWindowHidden
        });
      } catch (error) {
        console.error(error);
      }
    }
  }

  if (token.value) {
    await loadProfile();
    if (isDesktopApp && localConfig.autoStartRecording && userInfo.value && !runtimeState.isRunning) {
      await handleStartCore();
    }
  }
});

onBeforeUnmount(() => {
  stopAutoAppUpdatePoll();
  if (localConfigApplyTimer !== undefined) {
    clearTimeout(localConfigApplyTimer);
    localConfigApplyTimer = undefined;
  }
  clearCoreConfigAutoSaveTimer();
  coreConfigAutoSavePending = false;
  if (closeToTrayUnlisten) {
    closeToTrayUnlisten();
    closeToTrayUnlisten = null;
  }
});
</script>

<template>
  <div class="h-screen w-full">
    <!-- Login screen -->
    <CoreControlLoginCard
      v-if="!isLoggedIn"
      :token="token"
      :loading-profile="loadingProfile"
      @update:token="token = $event"
      @apply-token="loadProfile"
      @open-api-selector="showApiNodeModal = true"
    />

    <!-- Main app layout -->
    <div v-else class="flex h-screen">
      <AppSidebar
        :current-page="currentPage"
        :user-info="userInfo"
        :is-running="runtimeState.isRunning"
        :runtime-connected="runtimeState.runtimeConnected"
        :message-count="runtimeState.messageCount"
        :connected-rooms-count="runtimeState.connectedRooms.length"
        @navigate="currentPage = $event"
        @logout="handleLogout"
        @open-api-selector="showApiNodeModal = true"
      />

      <main class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-5xl px-6 py-6">
          <!-- API Fallback Alert -->
          <div
            v-if="activeFallbackAlert"
            class="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-500/10 px-4 py-3 text-xs text-amber-900 dark:border-amber-500/30 dark:text-amber-200"
          >
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              <span>
                主 API 节点响应异常，已自动无缝切换到备用节点：
                <code class="font-mono font-semibold">{{ activeFallbackAlert.fallbackOrigin }}</code>
              </span>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded border border-amber-400/50 bg-amber-500/20 px-2 py-1 text-[11px] font-medium transition-colors hover:bg-amber-500/30"
                @click="showApiNodeModal = true"
              >
                测速与切换
              </button>
              <button
                type="button"
                class="text-amber-700 hover:text-amber-900 dark:text-amber-300"
                title="关闭提示"
                @click="dismissFallbackAlert"
              >
                ✕
              </button>
            </div>
          </div>

          <Transition name="page" mode="out-in">
            <CoreControlDashboardTab v-if="currentPage === 'dashboard'" key="dashboard" :runtime-state="runtimeState" :recording-room-ids="recordingRoomIds" :recording-stats-by-room="recordingStatsByRoom" :remote-clients="remoteClients" :local-client-id="localClientId" :account-name="accountNameForDisplay" :account-id="accountIdForDisplay" :refreshing-state="refreshingState" :forcing-lock="forcingLock" :starting-core="startingCore" :stopping-core="stoppingCore" :app-update-busy="appUpdateBusy" :installing-app-update="installingAppUpdate" :available-update-version="availableUpdateVersion" @refresh-runtime-state="refreshRuntimeState" @clear-runtime-error="handleClearRuntimeError" @force-takeover="handleForceTakeover" @start-core="handleStartCore" @stop-core="handleStopCore" @install-app-update="handleInstallAppUpdate" />

            <CoreControlRecordingsTab
              v-else-if="currentPage === 'recordings'"
              key="recordings"
              :recordings="recordings"
              :local-config="localConfig"
              :refreshing-recordings="refreshingRecordings"
              :adding-recording="addingRecording"
              :removing-recording-uid="removingRecordingUid"
              :updating-recording-uid="updatingRecordingUid"
              :importing-follows="importingFollows"
              :import-follows-progress="importFollowsProgress"
              @refresh-recordings="refreshRecordingList"
              @add-recording="handleAddRecording"
              @remove-recording="handleRemoveRecording"
              @update-recording-public="handleUpdateRecordingPublic"
              @import-follows="handleImportFollows"
            />

            <CoreControlSettingsTab
              v-else-if="currentPage === 'settings'"
              key="settings"
              :core-config="coreConfigDraft"
              :local-config="localConfig"
              :available-areas="availableAreas"
              :saving-config="savingConfig"
              @save-config="handleSaveConfig"
            />

            <CoreControlAppTab
              v-else-if="currentPage === 'app'"
              key="app"
              :local-config="localConfig"
              :is-desktop-runtime="isDesktopApp"
              :is-macos-desktop-runtime="isMacosDesktopApp"
              :updater-supported="isUpdaterSupported"
              :app-update-busy="appUpdateBusy"
              :checking-app-update="checkingAppUpdate"
              :installing-app-update="installingAppUpdate"
              :available-update-version="availableUpdateVersion"
              :database-info="databaseInfo"
              :loading-database-info="loadingDatabaseInfo"
              :rebuilding-database="rebuildingDatabase"
              @check-app-update="handleCheckAppUpdate"
              @install-app-update="handleInstallAppUpdate"
              @refresh-database-info="refreshDatabaseInfo(false)"
              @rebuild-database="handleRebuildDatabase"
            />

            <CoreControlBilibiliTab
              v-else-if="currentPage === 'bilibili'"
              key="bilibili"
              :local-config="localConfig"
              :auth-state="runtimeState.authState"
              :core-running="runtimeState.isRunning"
              @sync-cookie-cloud="handleSyncCookieCloud"
            />

            <CoreControlAccountTab v-else-if="currentPage === 'account'" key="account" :user-info="userInfo" :recordings="recordings" @logout="handleLogout" />
          </Transition>
        </div>
      </main>
    </div>

    <!-- API Node Selector Modal -->
    <ApiNodeSelectorModal v-model:open="showApiNodeModal" />
  </div>
</template>
