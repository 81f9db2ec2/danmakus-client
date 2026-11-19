<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  ExternalLink,
  Loader2,
  PlusCircle,
  Search,
} from 'lucide-vue-next';
import {
  addChannelToAccountRecording,
  fetchChannelOverview,
  getChannelPageUrl,
  getLivePageUrl,
  getRecorderStateFromBackground,
  updateRecorderConfigInBackground,
} from '../utils/api';
import { attachBiliMainWorldBridge, detectCurrentBiliPage, type BiliPageTarget } from '../utils/bili-dom';
import { formatCompactNumber, formatCurrency } from '../utils/decoder';
import { onStorageStateChanged } from '../utils/storage';
import {
  type ChannelDetailResponse,
  type ExtensionRecorderConfig,
  type ExtensionRecorderState,
} from '../utils/types';
import UserLookupDrawer from './UserLookupDrawer.vue';

const pageTarget = ref<BiliPageTarget>({
  mode: 'other',
  roomId: null,
  streamerUid: null,
  spaceUid: null,
});

const channelOverview = ref<ChannelDetailResponse | null>(null);
const loadingChannel = ref(false);
const submittingChannel = ref(false);
const submitFeedback = ref<string | null>(null);

const recorderState = ref<ExtensionRecorderState | null>(null);
const recorderConfig = ref<ExtensionRecorderConfig | null>(null);

const drawerOpen = ref(false);
const lookupUid = ref<number | null>(null);
const lookupName = ref<string | undefined>(undefined);
const togglingRecorder = ref(false);
const hasRecorderToken = computed(() =>
  Boolean(recorderState.value?.hasToken || recorderConfig.value?.accountToken),
);

const activeLive = computed(() => {
  const ch = channelOverview.value?.channel;
  if (!ch) return null;
  if (ch.livingInfo && !ch.livingInfo.isFinish) return ch.livingInfo;
  const firstActive = channelOverview.value?.lives?.find((l) => !l.isFinish);
  return firstActive ?? channelOverview.value?.lives?.[0] ?? null;
});

const isIndexedChannel = computed(() => Boolean(channelOverview.value?.channel?.uId));

const currentTargetUid = computed(
  () => pageTarget.value.streamerUid || pageTarget.value.spaceUid || null,
);

const isCurrentRoomBeingRecordedByMe = computed(() => {
  const rid = pageTarget.value.roomId;
  if (!rid || !recorderState.value) return false;
  return recorderState.value.connectedRooms.includes(rid);
});

const openUserDrawer = (uid: number, name?: string) => {
  lookupUid.value = uid;
  lookupName.value = name;
  drawerOpen.value = true;
};

let overviewSeq = 0;

const loadTargetOverview = async () => {
  const seq = ++overviewSeq;
  const target = await detectCurrentBiliPage();
  if (seq !== overviewSeq) return;
  pageTarget.value = target;
  submitFeedback.value = null;

  const uid = target.streamerUid || target.spaceUid;
  if (!uid || uid <= 0) {
    channelOverview.value = null;
    return;
  }

  loadingChannel.value = true;
  try {
    const overview = await fetchChannelOverview(uid);
    if (seq === overviewSeq) {
      channelOverview.value = overview;
    }
  } finally {
    if (seq === overviewSeq) {
      loadingChannel.value = false;
    }
  }
};

const handleAddChannel = async () => {
  const uid = currentTargetUid.value;
  if (!uid || submittingChannel.value) return;

  if (!hasRecorderToken.value) {
    window.open(`${getChannelPageUrl(uid)}`, '_blank', 'noopener,noreferrer');
    return;
  }

  submittingChannel.value = true;
  submitFeedback.value = null;
  try {
    await addChannelToAccountRecording(uid);
    submitFeedback.value = '已提交收录并加入录制';
    channelOverview.value = await fetchChannelOverview(uid);
  } catch (err) {
    submitFeedback.value = err instanceof Error ? err.message : '提交失败';
  } finally {
    submittingChannel.value = false;
  }
};

const toggleQuickRecorder = async () => {
  if (!recorderConfig.value || togglingRecorder.value) return;
  const nextEnabled = !recorderConfig.value.enabled;
  togglingRecorder.value = true;
  try {
    const res = await updateRecorderConfigInBackground({ enabled: nextEnabled });
    recorderConfig.value = res.config;
    recorderState.value = res.state;
  } catch (err) {
    submitFeedback.value = err instanceof Error ? err.message : '切换录制状态失败';
  } finally {
    togglingRecorder.value = false;
  }
};

let stopStorageWatch: (() => void) | null = null;
let stopMainWorldBridge: (() => void) | null = null;
let routeCheckTimer: ReturnType<typeof setInterval> | null = null;
let liveRefreshTimer: ReturnType<typeof setInterval> | null = null;
let removeRouteListeners: (() => void) | null = null;
/** 只比较 host + path：query、hash 变化不影响页面目标，无需重新拉取 */
const currentRouteKey = () => `${window.location.host}${window.location.pathname}`;
let lastRouteKey = '';

const checkRouteChange = () => {
  const routeKey = currentRouteKey();
  if (routeKey !== lastRouteKey) {
    lastRouteKey = routeKey;
    void loadTargetOverview();
  }
};

const refreshLiveOverviewIfVisible = () => {
  if (document.hidden || pageTarget.value.mode !== 'live' || !currentTargetUid.value) return;
  const uid = currentTargetUid.value;
  void fetchChannelOverview(uid).then((res) => {
    if (res && currentTargetUid.value === uid) channelOverview.value = res;
  });
};

onMounted(async () => {
  lastRouteKey = currentRouteKey();
  let bridgeReady = false;

  stopMainWorldBridge = attachBiliMainWorldBridge({
    onPageContext: (ctx) => {
      if (ctx.streamerUid && pageTarget.value.streamerUid !== ctx.streamerUid) {
        pageTarget.value = {
          ...pageTarget.value,
          roomId: ctx.roomId ?? pageTarget.value.roomId,
          streamerUid: ctx.streamerUid,
        };
        if (bridgeReady) {
          void loadTargetOverview();
        }
      }
    },
    onUserClick: (user) => {
      openUserDrawer(user.uid, user.uname);
    },
  });
  bridgeReady = true;

  await loadTargetOverview();

  try {
    const initRes = await getRecorderStateFromBackground();
    recorderConfig.value = initRes.config;
    recorderState.value = initRes.state;
  } catch {
    // 后台尚未就绪时由后续 storage 变更补齐
  }

  stopStorageWatch = onStorageStateChanged(
    (state, config) => {
      recorderState.value = state;
      recorderConfig.value = config;
    },
    { redactToken: true },
  );

  const onVisibility = () => {
    if (!document.hidden) {
      checkRouteChange();
      refreshLiveOverviewIfVisible();
    }
  };
  window.addEventListener('popstate', checkRouteChange);
  document.addEventListener('visibilitychange', onVisibility);

  const nav = (window as { navigation?: EventTarget }).navigation;
  if (nav) {
    nav.addEventListener('navigatesuccess', checkRouteChange);
  } else {
    // 缺少 Navigation API 时保留低频兜底，仅在标签页可见时检查 SPA pushState
    routeCheckTimer = setInterval(() => {
      if (!document.hidden) checkRouteChange();
    }, 2000);
  }

  removeRouteListeners = () => {
    window.removeEventListener('popstate', checkRouteChange);
    document.removeEventListener('visibilitychange', onVisibility);
    nav?.removeEventListener('navigatesuccess', checkRouteChange);
  };

  liveRefreshTimer = setInterval(refreshLiveOverviewIfVisible, 20_000);
});

onUnmounted(() => {
  stopStorageWatch?.();
  stopMainWorldBridge?.();
  removeRouteListeners?.();
  if (routeCheckTimer) clearInterval(routeCheckTimer);
  if (liveRefreshTimer) clearInterval(liveRefreshTimer);
});
</script>

<template>
  <div class="font-sans text-foreground select-none">
    <!-- 顶部/右下角悬浮增强胶囊（根据直播间或个人空间自适应显示） -->
    <div
      class="fixed bottom-5 right-5 z-[2147483640] flex flex-col items-end gap-2"
    >
      <!-- 主播空间 / 直播间实时流水增强条 -->
      <div
        v-if="pageTarget.mode === 'live' || pageTarget.mode === 'space'"
        class="flex items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1.5 shadow-lg backdrop-blur-md transition-all"
      >
        <span
          class="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
        >
          D
        </span>

        <!-- 已收录主播展示实时流水/场次胶囊与一键跳转 -->
        <template v-if="isIndexedChannel && channelOverview?.channel">
          <div class="flex items-center gap-2 text-xs">
            <span class="font-semibold max-w-[110px] truncate">
              {{ channelOverview.channel.uName }}
            </span>

            <span
              v-if="channelOverview.channel.agencyName"
              class="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            >
              {{ channelOverview.channel.agencyName }}
            </span>

            <!-- 直播中显示本场实时营收与弹幕数 -->
            <template v-if="activeLive && !activeLive.isFinish">
              <span
                class="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-500"
              >
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>本场 {{ formatCurrency(activeLive.totalIncome) }}</span>
                <span class="opacity-75">· {{ formatCompactNumber(activeLive.danmakusCount) }}弹幕</span>
              </span>

              <a
                :href="getLivePageUrl(activeLive.liveId)"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 transition"
              >
                <span>实时大屏</span>
                <ExternalLink class="h-3 w-3" />
              </a>
            </template>

            <!-- 未开播时显示累计收录场次 -->
            <template v-else>
              <span class="text-[11px] text-muted-foreground">
                收录 {{ channelOverview.channel.totalLiveCount ?? channelOverview.totalLives }} 场
              </span>
            </template>

            <a
              v-if="channelOverview.channel.uId"
              :href="getChannelPageUrl(channelOverview.channel.uId)"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/70 px-2.5 py-0.5 text-[11px] font-medium text-secondary-foreground hover:bg-secondary transition"
            >
              <span>本站主页</span>
              <ExternalLink class="h-3 w-3" />
            </a>
          </div>
        </template>

        <!-- 未收录主播：展示一键提交收录 + 查该 UID 发言 -->
        <template v-else-if="currentTargetUid">
          <div class="flex items-center gap-2 text-xs">
            <span class="text-[11px] text-muted-foreground">UID {{ currentTargetUid }}</span>
            <button
              type="button"
              :disabled="submittingChannel"
              class="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20 transition"
              @click="handleAddChannel"
            >
              <Loader2 v-if="submittingChannel" class="h-3 w-3 animate-spin" />
              <PlusCircle v-else class="h-3 w-3" />
              <span>{{ submitFeedback || '提交主播收录' }}</span>
            </button>
          </div>
        </template>

        <!-- 快捷查当前空间用户 / 打开弹幕发言抽屉按钮 -->
        <button
          v-if="currentTargetUid"
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent transition"
          @click="openUserDrawer(currentTargetUid, channelOverview?.channel?.uName ?? undefined)"
        >
          <Search class="h-3 w-3 text-primary" />
          <span>{{ pageTarget.mode === 'space' ? '查TA全站发言' : '查观众发言' }}</span>
        </button>
      </div>

      <!-- 后台兼职录制迷你状态胶囊 -->
      <div
        class="flex items-center gap-2 rounded-full border border-border bg-background/90 px-3 py-1 text-[11px] shadow-md backdrop-blur-md transition"
      >
        <span
          class="h-2 w-2 rounded-full"
          :class="
            recorderState?.isRunning && recorderState?.runtimeConnected
              ? 'bg-emerald-500 animate-pulse'
              : recorderConfig?.enabled
                ? 'bg-amber-500'
                : 'bg-muted-foreground/50'
          "
        />
        <span v-if="recorderConfig?.enabled && recorderState?.isRunning">
          后台录制 {{ recorderState.connectedRooms.length }}/{{ recorderConfig.maxRooms }} 房
          <span v-if="isCurrentRoomBeingRecordedByMe" class="text-emerald-500 font-medium">
            (含本房)
          </span>
          · 已传 {{ formatCompactNumber(recorderState.messageCount) }}
        </span>
        <span v-else class="text-muted-foreground">
          {{ hasRecorderToken ? '兼职录制已暂停' : '未绑定录制账号' }}
        </span>

        <button
          v-if="hasRecorderToken && recorderConfig"
          type="button"
          :disabled="togglingRecorder"
          class="rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] font-medium hover:bg-accent transition disabled:opacity-50"
          @click="toggleQuickRecorder"
        >
          {{ recorderConfig.enabled ? '暂停' : '开启录制' }}
        </button>
      </div>
    </div>

    <!-- 网页内嵌滑出抽屉 (In-page Drawer) -->
    <UserLookupDrawer
      :open="drawerOpen"
      :uid="lookupUid"
      :initial-name="lookupName"
      :current-streamer-uid="pageTarget.mode === 'live' ? pageTarget.streamerUid : null"
      @close="drawerOpen = false"
      @select-uid="(uid, name) => openUserDrawer(uid, name)"
    />
  </div>
</template>
