<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { getDanmakuAreas } from '../services/account';
import { danmakuService } from '../services/DanmakuService';
import { biliNavProfileState, startNavProfileAutoRefresh, stopNavProfileAutoRefresh } from '../services/bilibili';
import { RUNTIME_URL } from '../services/env';
import { getAuthToken, setAuthToken, setServerLoggedIn } from '../services/http';
import {
  applyAutoStartEnabled,
  hideMainWindow,
  isDesktopRuntime,
  loadLocalAppConfig,
  readAutoStartEnabled,
  registerCloseToTrayHandler,
  saveLocalAppConfig,
  syncTrayHealthFromRuntime,
  setupTrayInTs
} from '../services/localApp';
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  checkForUpdate,
  installLatestUpdate,
  updaterEnabled,
  type AvailableUpdate
} from '../services/updater';
import type { CoreControlConfigDto, LocalAppConfigDto } from '../types/api';
import AppSidebar from './AppSidebar.vue';
import BilibiliLogin from './BilibiliLogin.vue';
import CoreControlAccountTab from './core-control/CoreControlAccountTab.vue';
import CoreControlAppTab from './core-control/CoreControlAppTab.vue';
import CoreControlDashboardTab from './core-control/CoreControlDashboardTab.vue';
import CoreControlLoginCard from './core-control/CoreControlLoginCard.vue';
import CoreControlSettingsTab from './core-control/CoreControlSettingsTab.vue';

const token = ref(getAuthToken());
const currentPage = ref('dashboard');
const isDesktopApp = isDesktopRuntime();
const runtimeFixedUrl = RUNTIME_URL;
const coreConfig = reactive<CoreControlConfigDto>({
  maxConnections: 5,
  runtimeUrl: runtimeFixedUrl,
  autoReconnect: true,
  reconnectInterval: 5000,
  statusCheckInterval: 30,
  streamers: [],
  requestServerRooms: true,
  allowedAreas: [],
  allowedParentAreas: []
});
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
const isUpdaterSupported = updaterEnabled();
const checkingAppUpdate = ref(false);
const installingAppUpdate = ref(false);
const autoCheckingAppUpdate = ref(false);
const appUpdateBusy = computed(() =>
  checkingAppUpdate.value || installingAppUpdate.value || autoCheckingAppUpdate.value
);
const availableUpdateVersion = ref<string | null>(null);
let autoAppUpdateTimer: number | undefined;
let announcedAppUpdateVersion: string | null = null;
const coreConfigAutoSaveThrottleMs = 1_200;
let coreConfigAutoSaveTimer: number | undefined;
let coreConfigAutoSavePending = false;
let syncingCoreConfigFromRemote = false;
let pendingRemoteCoreConfigSyncCount = 0;
let syncingAutoStartFromDesktop = false;
let closeToTrayUnlisten: (() => void) | null = null;

const localClientId = danmakuService.getClientId();
const remoteClients = computed(() => runtimeState.remoteClients);
const recordingRoomIds = computed(() =>
  recordings.value
    .map(item => Number(item.channel?.roomId))
    .filter((roomId) => Number.isFinite(roomId) && roomId > 0)
    .map(roomId => Math.floor(roomId))
);
const recordingStatsByRoom = computed(() => {
  const result: Record<string, {
    uid: number;
    username: string;
    faceUrl: string;
    todayDanmakusCount: number;
    providedDanmakuDataCount: number;
    providedMessageCount: number;
  }> = {};

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
const lastHeartbeatText = computed(() =>
  runtimeState.lastHeartbeat ? new Date(runtimeState.lastHeartbeat).toLocaleString() : '—'
);
const cookieStatusText = computed(() => biliNavProfileState.profile ? '有效' : '未知');
const cookieStatusType = computed(() => biliNavProfileState.profile ? 'success' : 'warning');

const ensureToken = () => {
  if (!token.value) {
    toast.error('请先输入 Token');
    return false;
  }
  return true;
};

const isAppUpdateBusy = () => appUpdateBusy.value;

const applyAvailableUpdate = (update: AvailableUpdate | null) => {
  availableUpdateVersion.value = update?.version ?? null;
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
    applyAvailableUpdate(update);
    if (!update || announcedAppUpdateVersion === update.version) {
      return;
    }

    announcedAppUpdateVersion = update.version;
    toast.info(`发现新版本 ${update.version}`);
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
  ...coreConfig,
  runtimeUrl: coreConfig.runtimeUrl,
  allowedAreas: [...coreConfig.allowedAreas],
  allowedParentAreas: [...coreConfig.allowedParentAreas],
  streamers: []
});

const persistCoreConfig = async (silentSuccess: boolean) => {
  if (!token.value) return;
  if (savingConfig.value) return;
  try {
    savingConfig.value = true;
    await danmakuService.saveCoreConfig(buildCoreConfigPayload());
    syncConfig(runtimeState.coreConfig);
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

const syncConfig = (config: CoreControlConfigDto) => {
  pendingRemoteCoreConfigSyncCount += 1;
  syncingCoreConfigFromRemote = true;
  try {
    coreConfig.maxConnections = config.maxConnections;
    coreConfig.runtimeUrl = config.runtimeUrl || runtimeFixedUrl;
    coreConfig.autoReconnect = config.autoReconnect;
    coreConfig.reconnectInterval = config.reconnectInterval;
    coreConfig.statusCheckInterval = config.statusCheckInterval;
    coreConfig.requestServerRooms = config.requestServerRooms;
    coreConfig.allowedAreas = Array.isArray(config.allowedAreas) ? [...config.allowedAreas] : [];
    coreConfig.allowedParentAreas = Array.isArray(config.allowedParentAreas) ? [...config.allowedParentAreas] : [];
    coreConfig.streamers.splice(0);
  } finally {
    queueMicrotask(() => {
      pendingRemoteCoreConfigSyncCount = Math.max(0, pendingRemoteCoreConfigSyncCount - 1);
      syncingCoreConfigFromRemote = pendingRemoteCoreConfigSyncCount > 0;
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
    syncConfig(runtimeState.coreConfig);
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

    applyAvailableUpdate(update);
    announcedAppUpdateVersion = update.version;
    toast.info(`发现新版本 ${update.version}`);
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '检查更新失败');
  } finally {
    checkingAppUpdate.value = false;
  }
};

const handleInstallAppUpdate = async () => {
  if (!isUpdaterSupported) {
    toast.info('仅 Tauri 桌面客户端支持安装更新');
    return;
  }
  if (isAppUpdateBusy()) {
    return;
  }

  installingAppUpdate.value = true;
  try {
    const update = await installLatestUpdate();
    if (!update) {
      applyAvailableUpdate(null);
      toast.success('当前已是最新版本');
      return;
    }

    applyAvailableUpdate(null);
    announcedAppUpdateVersion = update.version;
    toast.success(`更新 ${update.version} 已安装，请手动重启应用`);
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '安装更新失败');
  } finally {
    installingAppUpdate.value = false;
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
    const added = recordings.value.find(item => item.channel.uId === uid);
    toast.success(`已添加录制主播: ${added?.channel.uName || uid}`);
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '添加录制主播失败');
  } finally {
    addingRecording.value = false;
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
    toast.error(error instanceof Error ? error.message : '移除录制主播失败');
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

watch(coreConfig, () => {
  if (syncingCoreConfigFromRemote) return;
  scheduleCoreConfigAutoSave();
}, { deep: true });

watch(
  () => runtimeState.coreConfig,
  (config) => {
    syncConfig(config);
  },
  { deep: true, immediate: true }
);

watch(localConfig, () => {
  saveLocalAppConfig(localConfig);
}, { deep: true });

watch(() => localConfig.autoStart, (nextValue, previousValue) => {
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
});

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
    }).catch(error => {
      console.error(error);
    });
  },
  { immediate: true }
);

watch(isLoggedIn, (loggedIn) => {
  if (loggedIn) {
    startNavProfileAutoRefresh();
  } else {
    stopNavProfileAutoRefresh();
  }
}, { immediate: true });

onMounted(async () => {
  if (isDesktopApp) {
    try {
      await setupTrayInTs();
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : '初始化托盘失败');
    }
    startAutoAppUpdatePoll();
    closeToTrayUnlisten = await registerCloseToTrayHandler(() => localConfig.minimizeToTray);
    await syncDesktopLocalConfig();
    if (localConfig.startMinimized) {
      try {
        await hideMainWindow({ notify: false });
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
  stopNavProfileAutoRefresh();
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
      />

      <main class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-5xl px-6 py-6">
          <Transition name="page" mode="out-in">
            <CoreControlDashboardTab
              v-if="currentPage === 'dashboard'"
              key="dashboard"
              :runtime-state="runtimeState"
              :recording-room-ids="recordingRoomIds"
              :recording-stats-by-room="recordingStatsByRoom"
              :remote-clients="remoteClients"
              :local-client-id="localClientId"
              :account-name="accountNameForDisplay"
              :account-id="accountIdForDisplay"
              :bili-account-profile="biliNavProfileState.profile"
              :last-heartbeat-text="lastHeartbeatText"
              :cookie-status-text="cookieStatusText"
              :cookie-status-type="cookieStatusType"
              :refreshing-state="refreshingState"
              :forcing-lock="forcingLock"
              :starting-core="startingCore"
              :stopping-core="stoppingCore"
              @refresh-runtime-state="refreshRuntimeState"
              @force-takeover="handleForceTakeover"
              @start-core="handleStartCore"
              @stop-core="handleStopCore"
            />

            <CoreControlSettingsTab
              v-else-if="currentPage === 'settings'"
              key="settings"
              :core-config="coreConfig"
              :available-areas="availableAreas"
              :recordings="recordings"
              :refreshing-recordings="refreshingRecordings"
              :adding-recording="addingRecording"
              :removing-recording-uid="removingRecordingUid"
              :updating-recording-uid="updatingRecordingUid"
              :saving-config="savingConfig"
              @save-config="handleSaveConfig"
              @refresh-recordings="refreshRecordingList"
              @add-recording="handleAddRecording"
              @remove-recording="handleRemoveRecording"
              @update-recording-public="handleUpdateRecordingPublic"
            />

            <CoreControlAppTab
              v-else-if="currentPage === 'app'"
              key="app"
              :local-config="localConfig"
              :is-desktop-runtime="isDesktopApp"
              :updater-supported="isUpdaterSupported"
              :app-update-busy="appUpdateBusy"
              :checking-app-update="checkingAppUpdate"
              :installing-app-update="installingAppUpdate"
              :available-update-version="availableUpdateVersion"
              @check-app-update="handleCheckAppUpdate"
              @install-app-update="handleInstallAppUpdate"
            />

            <div v-else-if="currentPage === 'bilibili'" key="bilibili">
              <h2 class="mb-4 text-xl font-semibold tracking-tight">Bilibili 连接管理</h2>
              <p class="mb-5 text-sm text-muted-foreground">登录 Bilibili 账号后可同步 Cookie，用于连接直播间弹幕服务</p>
              <BilibiliLogin />
            </div>

            <CoreControlAccountTab
              v-else-if="currentPage === 'account'"
              key="account"
              :user-info="userInfo"
              :recordings="recordings"
              @logout="handleLogout"
            />
          </Transition>
        </div>
      </main>
    </div>
  </div>
</template>
