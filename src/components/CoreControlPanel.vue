<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useMessage, NTabs, NTabPane } from 'naive-ui';
import { getUserInfo, getCoreConfig, syncCoreRuntimeState, updateCoreConfig } from '../services/account';
import { danmakuService } from '../services/DanmakuService';
import { SIGNALR_URL } from '../services/env';
import { getAuthToken, setAuthToken, setServerLoggedIn } from '../services/http';
import type { CoreControlConfigDto, UserInfo } from '../types/api';
import CoreControlAccountTab from './core-control/CoreControlAccountTab.vue';
import CoreControlDashboardTab from './core-control/CoreControlDashboardTab.vue';
import CoreControlLoginCard from './core-control/CoreControlLoginCard.vue';
import CoreControlSettingsTab from './core-control/CoreControlSettingsTab.vue';

const message = useMessage();
const token = ref(getAuthToken());
const userInfo = ref<UserInfo | null>(null);
const isLoggedIn = computed(() => !!userInfo.value);
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
  requestServerRooms: true
});

const runtimeState = danmakuService.state;
const loadingProfile = ref(false);
const savingConfig = ref(false);
const startingCore = ref(false);
const stoppingCore = ref(false);
const refreshingState = ref(false);
const forcingLock = ref(false);
let remotePollTimer: number | undefined;

const localClientId = danmakuService.getClientId();
const remoteClients = computed(() => runtimeState.remoteClients);
const lastHeartbeatText = computed(() =>
  runtimeState.lastHeartbeat ? new Date(runtimeState.lastHeartbeat).toLocaleString() : '—'
);
const cookieStatusText = computed(() => runtimeState.cookieValid ? '有效' : '未知');
const cookieStatusType = computed(() => runtimeState.cookieValid ? 'success' : 'warning');

const ensureToken = () => {
  if (!token.value) {
    message.error('请先输入 Token');
    return false;
  }
  return true;
};

const startRemotePoll = () => {
  if (remotePollTimer) return;
  remotePollTimer = window.setInterval(() => {
    if (!isLoggedIn.value || refreshingState.value) return;
    void refreshRuntimeState();
  }, 5000);
};

const stopRemotePoll = () => {
  if (!remotePollTimer) return;
  clearInterval(remotePollTimer);
  remotePollTimer = undefined;
};

const syncConfig = (config: CoreControlConfigDto) => {
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
  coreConfig.streamers.splice(0, coreConfig.streamers.length, ...config.streamers.map(s => ({ ...s })));
};

const loadProfile = async () => {
  if (!ensureToken()) return;
  try {
    loadingProfile.value = true;
    setAuthToken(token.value);
    const [info, config] = await Promise.all([getUserInfo(), getCoreConfig()]);
    userInfo.value = info;
    setServerLoggedIn(true);
    syncConfig(config);
    message.success('已加载用户与配置');
    await refreshRuntimeState();
    startRemotePoll();
  } catch (error) {
    console.error(error);
    userInfo.value = null;
    setServerLoggedIn(false);
    stopRemotePoll();
    message.error(error instanceof Error ? error.message : '加载失败');
  } finally {
    loadingProfile.value = false;
  }
};

const handleSaveConfig = async () => {
  if (!ensureToken()) return;
  try {
    savingConfig.value = true;
    const updated = await updateCoreConfig({
      ...coreConfig,
      signalrUrl: coreConfig.signalrUrl,
      streamers: coreConfig.streamers.map(s => ({ ...s }))
    });
    syncConfig(updated);
    message.success('配置已保存');
  } catch (error) {
    console.error(error);
    message.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    savingConfig.value = false;
  }
};

const handleStartCore = async () => {
  try {
    if (!ensureToken()) return;
    startingCore.value = true;
    await danmakuService.initialize();
    await danmakuService.start();
    message.success('核心已启动');
    await refreshRuntimeState();
  } catch (error) {
    console.error(error);
    message.error(error instanceof Error ? error.message : '启动失败');
  } finally {
    startingCore.value = false;
  }
};

const handleStopCore = async () => {
  try {
    stoppingCore.value = true;
    await danmakuService.stop();
    message.info('核心已停止');
    await refreshRuntimeState();
  } catch (error) {
    console.error(error);
    message.error(error instanceof Error ? error.message : '停止失败');
  } finally {
    stoppingCore.value = false;
  }
};

const addStreamer = () => {
  coreConfig.streamers.push({
    roomId: 0,
    priority: 'normal',
    name: ''
  });
};

const removeStreamer = (index: number) => {
  coreConfig.streamers.splice(index, 1);
};

const handleLogout = async () => {
  stopRemotePoll();
  try {
    await danmakuService.stop();
  } catch (error) {
    console.error(error);
    message.error(error instanceof Error ? `停止核心失败: ${error.message}` : '停止核心失败');
  }

  token.value = '';
  setAuthToken('');
  userInfo.value = null;
  setServerLoggedIn(false);
  message.success('已登出');
};

const refreshRuntimeState = async () => {
  refreshingState.value = true;
  try {
    await danmakuService.refreshRemoteState();
  } catch (error) {
    console.error(error);
    message.error(error instanceof Error ? error.message : '刷新状态失败');
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
    message.success('已强制接管核心锁');
    await refreshRuntimeState();
  } catch (error) {
    console.error(error);
    message.error(error instanceof Error ? error.message : '强制接管失败');
  } finally {
    forcingLock.value = false;
  }
};

onMounted(async () => {
  if (token.value) {
    await loadProfile();
  }
  startRemotePoll();
});

onBeforeUnmount(() => {
  stopRemotePoll();
});
</script>

<template>
  <div class="core-panel">
    <CoreControlLoginCard
      v-if="!isLoggedIn"
      :token="token"
      :loading-profile="loadingProfile"
      @update:token="token = $event"
      @apply-token="loadProfile"
    />

    <n-tabs v-else type="segment" animated size="large" class="main-tabs">
      <n-tab-pane name="dashboard" tab="运行仪表盘">
        <CoreControlDashboardTab
          :runtime-state="runtimeState"
          :remote-clients="remoteClients"
          :local-client-id="localClientId"
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
      </n-tab-pane>

      <n-tab-pane name="settings" tab="核心配置">
        <CoreControlSettingsTab
          :core-config="coreConfig"
          :saving-config="savingConfig"
          @save-config="handleSaveConfig"
          @add-streamer="addStreamer"
          @remove-streamer="removeStreamer"
        />
      </n-tab-pane>

      <n-tab-pane name="account" tab="账户信息">
        <CoreControlAccountTab :user-info="userInfo" @logout="handleLogout" />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped>
.core-panel {
  max-width: 800px;
  margin: 0 auto;
  padding: 12px;
}
</style>
