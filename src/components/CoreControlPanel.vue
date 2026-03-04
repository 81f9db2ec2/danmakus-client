<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import {
  addRecording,
  getCoreConfig,
  getDanmakuAreas,
  getRecordingList,
  getUserInfo,
  removeRecording,
  syncCoreRuntimeState,
  updateCoreConfig
} from '../services/account';
import { danmakuService } from '../services/DanmakuService';
import { biliNavProfileState, startNavProfileAutoRefresh, stopNavProfileAutoRefresh } from '../services/bilibili';
import { SIGNALR_URL } from '../services/env';
import { getAuthToken, setAuthToken, setServerLoggedIn } from '../services/http';
import { checkForUpdate, installLatestUpdate, updaterEnabled } from '../services/updater';
import type { CoreControlConfigDto, RecordingInfoDto, UserInfo } from '../types/api';
import AppSidebar from './AppSidebar.vue';
import BilibiliLogin from './BilibiliLogin.vue';
import CoreControlAccountTab from './core-control/CoreControlAccountTab.vue';
import CoreControlDashboardTab from './core-control/CoreControlDashboardTab.vue';
import CoreControlLoginCard from './core-control/CoreControlLoginCard.vue';
import CoreControlSettingsTab from './core-control/CoreControlSettingsTab.vue';

const token = ref(getAuthToken());
const userInfo = ref<UserInfo | null>(null);
const isLoggedIn = computed(() => !!userInfo.value);
const currentPage = ref('dashboard');
const signalrFixedUrl = SIGNALR_URL;
const coreConfig = reactive<CoreControlConfigDto>({
  maxConnections: 5,
  signalrUrl: signalrFixedUrl,
  autoReconnect: true,
  reconnectInterval: 5000,
  statusCheckInterval: 30,
  cookieCloudKey: '',
  cookieCloudPassword: '',
  cookieCloudHost: '',
  cookieRefreshInterval: 3600,
  streamers: [],
  requestServerRooms: true,
  allowedAreas: [],
  allowedParentAreas: []
});

const runtimeState = danmakuService.state;
const availableAreas = ref<Record<string, string[]>>({});
const loadingProfile = ref(false);
const savingConfig = ref(false);
const startingCore = ref(false);
const stoppingCore = ref(false);
const refreshingState = ref(false);
const forcingLock = ref(false);
const recordings = ref<RecordingInfoDto[]>([]);
const refreshingRecordings = ref(false);
const addingRecording = ref(false);
const removingRecordingUid = ref<number | null>(null);
const isUpdaterSupported = updaterEnabled();
const checkingAppUpdate = ref(false);
const installingAppUpdate = ref(false);
const availableUpdateVersion = ref<string | null>(null);
let remotePollTimer: number | undefined;
const recordingRefreshIntervalMs = 15_000;
let lastRecordingRefreshAt = 0;
const coreConfigAutoSaveThrottleMs = 1_200;
let coreConfigAutoSaveTimer: number | undefined;
let coreConfigAutoSavePending = false;
let syncingCoreConfigFromRemote = false;

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

const startRemotePoll = () => {
  if (remotePollTimer) return;
  remotePollTimer = window.setInterval(() => {
    if (!isLoggedIn.value || refreshingState.value) return;
    void (async () => {
      await refreshRuntimeState();
      const now = Date.now();
      if (now - lastRecordingRefreshAt < recordingRefreshIntervalMs) return;
      if (refreshingRecordings.value || addingRecording.value || removingRecordingUid.value !== null) return;
      lastRecordingRefreshAt = now;
      await refreshRecordingList();
    })();
  }, 5000);
};

const stopRemotePoll = () => {
  if (!remotePollTimer) return;
  clearInterval(remotePollTimer);
  remotePollTimer = undefined;
};

const clearCoreConfigAutoSaveTimer = () => {
  if (coreConfigAutoSaveTimer === undefined) return;
  clearTimeout(coreConfigAutoSaveTimer);
  coreConfigAutoSaveTimer = undefined;
};

const buildCoreConfigPayload = (): CoreControlConfigDto => ({
  ...coreConfig,
  signalrUrl: coreConfig.signalrUrl,
  allowedAreas: [...coreConfig.allowedAreas],
  allowedParentAreas: [...coreConfig.allowedParentAreas],
  streamers: []
});

const persistCoreConfig = async (silentSuccess: boolean) => {
  if (!token.value) return;
  if (savingConfig.value) return;
  try {
    savingConfig.value = true;
    await updateCoreConfig(buildCoreConfigPayload());
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
  syncingCoreConfigFromRemote = true;
  try {
    coreConfig.maxConnections = config.maxConnections;
    coreConfig.signalrUrl = config.signalrUrl || signalrFixedUrl;
    coreConfig.autoReconnect = config.autoReconnect;
    coreConfig.reconnectInterval = config.reconnectInterval;
    coreConfig.statusCheckInterval = config.statusCheckInterval;
    coreConfig.cookieCloudKey = config.cookieCloudKey ?? '';
    coreConfig.cookieCloudPassword = config.cookieCloudPassword ?? '';
    coreConfig.cookieCloudHost = config.cookieCloudHost ?? '';
    coreConfig.cookieRefreshInterval = config.cookieRefreshInterval;
    coreConfig.requestServerRooms = config.requestServerRooms;
    coreConfig.allowedAreas = Array.isArray(config.allowedAreas) ? [...config.allowedAreas] : [];
    coreConfig.allowedParentAreas = Array.isArray(config.allowedParentAreas) ? [...config.allowedParentAreas] : [];
    coreConfig.streamers.splice(0);
  } finally {
    syncingCoreConfigFromRemote = false;
  }
};

const sortRecordings = (items: RecordingInfoDto[]) => {
  return [...items].sort((a, b) => {
    const liveA = a.channel?.isLiving ? 1 : 0;
    const liveB = b.channel?.isLiving ? 1 : 0;
    if (liveA !== liveB) {
      return liveB - liveA;
    }
    const uidA = Number(a.channel?.uId ?? 0);
    const uidB = Number(b.channel?.uId ?? 0);
    return uidA - uidB;
  });
};

const syncRecordingList = (items: RecordingInfoDto[]) => {
  recordings.value = sortRecordings(items);
};

const refreshRecordingList = async () => {
  if (!ensureToken()) return;
  refreshingRecordings.value = true;
  try {
    const data = await getRecordingList();
    syncRecordingList(data);
  } finally {
    refreshingRecordings.value = false;
  }
};

const loadProfile = async () => {
  if (!ensureToken()) return;
  try {
    loadingProfile.value = true;
    setAuthToken(token.value);
    const [info, config, recordingData] = await Promise.all([
      getUserInfo(),
      getCoreConfig(),
      getRecordingList()
    ]);
    userInfo.value = info;
    setServerLoggedIn(true);
    syncConfig(config);
    syncRecordingList(recordingData);
    try {
      availableAreas.value = await getDanmakuAreas();
    } catch (error) {
      console.error(error);
      availableAreas.value = {};
      toast.warning(error instanceof Error ? `加载分区列表失败: ${error.message}` : '加载分区列表失败');
    }
    toast.success('已加载用户与配置');
    await refreshRuntimeState();
    startRemotePoll();
  } catch (error) {
    console.error(error);
    userInfo.value = null;
    recordings.value = [];
    setServerLoggedIn(false);
    stopRemotePoll();
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
  if (checkingAppUpdate.value || installingAppUpdate.value) {
    return;
  }

  checkingAppUpdate.value = true;
  try {
    const update = await checkForUpdate();
    if (!update) {
      availableUpdateVersion.value = null;
      toast.success('当前已是最新版本');
      return;
    }

    availableUpdateVersion.value = update.version;
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
  if (installingAppUpdate.value || checkingAppUpdate.value) {
    return;
  }

  installingAppUpdate.value = true;
  try {
    const update = await installLatestUpdate();
    if (!update) {
      availableUpdateVersion.value = null;
      toast.success('当前已是最新版本');
      return;
    }

    availableUpdateVersion.value = null;
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
    startingCore.value = true;
    await danmakuService.initialize();
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
    const added = await addRecording(uid);
    if (!recordings.value.some(item => item.channel.uId === added.channel.uId)) {
      syncRecordingList([...recordings.value, added]);
    } else {
      await refreshRecordingList();
    }
    toast.success(`已添加录制主播: ${added.channel.uName || added.channel.uId}`);
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
    await removeRecording(uid);
    syncRecordingList(recordings.value.filter(item => item.channel.uId !== uid));
    toast.success('已移除录制主播');
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '移除录制主播失败');
  } finally {
    removingRecordingUid.value = null;
  }
};

const handleLogout = async () => {
  stopRemotePoll();
  clearCoreConfigAutoSaveTimer();
  coreConfigAutoSavePending = false;
  try {
    await danmakuService.stop();
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? `停止核心失败: ${error.message}` : '停止核心失败');
  }

  token.value = '';
  setAuthToken('');
  userInfo.value = null;
  recordings.value = [];
  availableUpdateVersion.value = null;
  setServerLoggedIn(false);
  currentPage.value = 'dashboard';
  toast.success('已登出');
};

const refreshRuntimeState = async () => {
  refreshingState.value = true;
  try {
    await danmakuService.refreshRemoteState();
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
    setAuthToken(token.value);
    await syncCoreRuntimeState({
      clientId: danmakuService.getClientId(),
      clientVersion: 'desktop',
      isRunning: false,
      signalrConnected: false,
      cookieValid: false,
      connectedRooms: [],
      connectionInfo: [],
      serverAssignedRooms: [],
      messageCount: 0,
      lastRoomAssigned: null,
      lastError: null
    }, { force: true });
    toast.success('已强制接管核心锁');
    await refreshRuntimeState();
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '强制接管失败');
  } finally {
    forcingLock.value = false;
  }
};

watch(coreConfig, () => {
  if (syncingCoreConfigFromRemote) return;
  scheduleCoreConfigAutoSave();
}, { deep: true });

watch(isLoggedIn, (loggedIn) => {
  if (loggedIn) {
    startNavProfileAutoRefresh();
  } else {
    stopNavProfileAutoRefresh();
  }
}, { immediate: true });

onMounted(async () => {
  if (token.value) {
    await loadProfile();
  }
  startRemotePoll();
});

onBeforeUnmount(() => {
  stopRemotePoll();
  stopNavProfileAutoRefresh();
  clearCoreConfigAutoSaveTimer();
  coreConfigAutoSavePending = false;
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
        :signalr-connected="runtimeState.signalrConnected"
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
              :saving-config="savingConfig"
              :updater-supported="isUpdaterSupported"
              :checking-app-update="checkingAppUpdate"
              :installing-app-update="installingAppUpdate"
              :available-update-version="availableUpdateVersion"
              @save-config="handleSaveConfig"
              @check-app-update="handleCheckAppUpdate"
              @install-app-update="handleInstallAppUpdate"
              @refresh-recordings="refreshRecordingList"
              @add-recording="handleAddRecording"
              @remove-recording="handleRemoveRecording"
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
