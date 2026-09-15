<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AuthStateSnapshot, RuntimeRoomPullShortfallDto } from 'danmakus-core';
import { useTimeAgoIntl } from '@vueuse/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { toast } from 'vue-sonner';
import {
  AlertCircle,
  BarChart3,
  Cookie,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
  Play,
  PlugZap,
  RefreshCw,
  Search,
  Server,
  StopCircle,
  TvMinimal,
  UserRound,
  X
} from 'lucide-vue-next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type ConnectionInfo = {
  roomId: number;
  priority: string;
  connectedAt: number;
};

type StreamerStatus = {
  roomId: number;
  uId?: number;
  isLive: boolean;
  username?: string;
  faceUrl?: string;
};

type RecordingRoomStats = {
  uid: number;
  username: string;
  faceUrl: string;
  todayDanmakusCount: number;
  providedDanmakuDataCount: number;
  providedMessageCount: number;
};

type RemoteClientSnapshot = {
  clientId: string;
  ip: string | null;
  isRunning: boolean;
  runtimeConnected: boolean;
  connectedRooms: number[];
  messageCount: number;
  lastHeartbeat: number | null;
};

type RuntimeStateSnapshot = {
  isRunning: boolean;
  runtimeConnected: boolean;
  connectedRooms: number[];
  connectionInfo: ConnectionInfo[];
  messageCount: number;
  pendingMessageCount: number;
  messageCmdCountMap: Record<string, number>;
  roomMessageCountMap: Record<string, number>;
  holdingRooms: number[];
  holdingRoomShortfall: RuntimeRoomPullShortfallDto | null;
  streamerStatuses: StreamerStatus[];
  lastError: string | null;
  lockConflict: boolean;
  lockConflictOwnerClientId: string | null;
  lastRoomAssigned: number | null;
  authState: AuthStateSnapshot;
};

const RUNTIME_ERROR_AUTO_DISMISS_MS = 5 * 60 * 1000;

const getRuntimeErrorAutoDismissDelay = (startedAt: number | null, now: number = Date.now()): number | null => {
  if (startedAt === null) {
    return null;
  }
  return startedAt + RUNTIME_ERROR_AUTO_DISMISS_MS - now;
};

const normalizeRoomId = (value: unknown): number | null => {
  const roomId = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(roomId) || roomId <= 0) {
    return null;
  }
  return Math.floor(roomId);
};

const props = defineProps<{
  runtimeState: RuntimeStateSnapshot;
  recordingRoomIds: number[];
  recordingStatsByRoom: Record<string, RecordingRoomStats>;
  remoteClients: RemoteClientSnapshot[];
  localClientId: string;
  accountName: string;
  accountId: number | null;
  refreshingState: boolean;
  forcingLock: boolean;
  startingCore: boolean;
  stoppingCore: boolean;
  appUpdateBusy: boolean;
  installingAppUpdate: boolean;
  availableUpdateVersion: string | null;
}>();

const authState = computed(() => props.runtimeState.authState);
const isCoreRunning = computed(() => props.runtimeState.isRunning);

const activeAuthProfile = computed(() => authState.value.cookieCloud.profile ?? authState.value.local.profile ?? null);

const cookieStatusText = computed(() => {
  if (authState.value.phase === 'syncing') return '同步中';
  if (authState.value.hasUsableCookie) {
    if (authState.value.activeSource === 'cookieCloud') {
      return isCoreRunning.value ? 'CookieCloud 有效' : 'CookieCloud 已就绪';
    }
    return isCoreRunning.value ? '本地登录有效' : '本地 Cookie 已就绪';
  }
  if (!isCoreRunning.value && authState.value.cookieCloud.configured) return '等待同步';
  if (!isCoreRunning.value && authState.value.local.hasCookie) return '待校验';
  if (!isCoreRunning.value) return '核心未启动';
  if (authState.value.lastError) return '无效';
  return '未配置';
});

const cookieStatusType = computed(() => (authState.value.hasUsableCookie ? 'success' : 'warning'));

const getHoldingRoomShortfallReasonText = (shortfall: RuntimeRoomPullShortfallDto | null | undefined): string => {
  const reason = shortfall?.reason;
  const blockedBySameAccountCount = Number.isFinite(Number(shortfall?.blockedBySameAccountCount))
    ? Math.max(0, Math.floor(Number(shortfall?.blockedBySameAccountCount)))
    : 0;
  const blockedByOtherAccountsCount = Number.isFinite(Number(shortfall?.blockedByOtherAccountsCount))
    ? Math.max(0, Math.floor(Number(shortfall?.blockedByOtherAccountsCount)))
    : 0;

  switch (reason) {
    case 'no_candidates':
      return '暂时没有更多需要录制的直播间，请等待主播开播或状态更新';
    case 'blocked_by_reservations':
      return blockedBySameAccountCount > 0 && blockedByOtherAccountsCount <= 0
        ? '可分配的直播间已被同账号下的其他客户端占用'
        : '暂时没有更多需要录制的直播间';
    case 'candidate_pool_exhausted':
      return '已补充部分直播间，但是暂时已经没有更多需要录制的主播';
    default:
      return '暂时还不能补满录制位';
  }
};

const authSourceText = computed(() => {
  if (authState.value.activeSource === 'cookieCloud') {
    return isCoreRunning.value ? '当前使用 CookieCloud' : '核心启动后将使用 CookieCloud';
  }
  if (authState.value.activeSource === 'local') {
    return isCoreRunning.value ? '当前使用本地扫码登录' : '核心启动后将使用本地扫码登录';
  }
  if (!isCoreRunning.value && authState.value.cookieCloud.configured) {
    return '核心未启动，CookieCloud 正在后台同步';
  }
  if (!isCoreRunning.value) {
    return '核心未启动，尚未建立鉴权状态';
  }
  return '当前无可用鉴权';
});

const barColors = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-primary/60',
  'bg-primary/40',
  'bg-primary/30',
  'bg-muted-foreground/30'
] as const;

const messageCmdRows = computed(() =>
  Object.entries(props.runtimeState.messageCmdCountMap)
    .map(([cmd, count]) => ({ cmd, count }))
    .sort((a, b) => b.count - a.count || a.cmd.localeCompare(b.cmd))
);

const messageTypeRows = computed(() => {
  const total = props.runtimeState.messageCount || 1;
  const colorCount = barColors.length;
  return messageCmdRows.value.map((r, i) => ({
    ...r,
    percentage: (r.count / total) * 100,
    colorIndex: i % colorCount
  }));
});

const roomSearchQuery = ref('');
type RoomFilterType = 'all' | 'recording' | 'assigned' | 'connected';
const roomFilter = ref<RoomFilterType>('all');

const connectionRoomCards = computed(() => {
  const statusMap = new Map<number, StreamerStatus>();
  for (const status of props.runtimeState.streamerStatuses) {
    const roomId = normalizeRoomId(status.roomId);
    if (roomId === null) continue;
    statusMap.set(roomId, {
      ...status,
      roomId
    });
  }

  const connectionMap = new Map<number, ConnectionInfo>();
  for (const info of props.runtimeState.connectionInfo) {
    const roomId = normalizeRoomId(info.roomId);
    if (roomId === null) continue;
    connectionMap.set(roomId, {
      ...info,
      roomId
    });
  }

  const connectedSet = new Set(
    props.runtimeState.connectedRooms.map(normalizeRoomId).filter((id): id is number => id !== null)
  );
  const serverAssignedSet = new Set(
    props.runtimeState.holdingRooms.map(normalizeRoomId).filter((id): id is number => id !== null)
  );
  const recordingSet = new Set(
    props.recordingRoomIds.map(normalizeRoomId).filter((id): id is number => id !== null)
  );

  const roomIds = Array.from(new Set([...serverAssignedSet, ...connectedSet]));

  return roomIds
    .map((roomId) => {
      const status = statusMap.get(roomId);
      const connection = connectionMap.get(roomId);
      const recordingMeta = props.recordingStatsByRoom[String(roomId)];
      const isConnected = connectedSet.has(roomId);
      const priority = connection?.priority ?? '';
      const isRecording = recordingSet.has(roomId);
      const uid = normalizeRoomId(recordingMeta?.uid ?? status?.uId);
      const sessionMessageCountRaw = props.runtimeState.roomMessageCountMap[String(roomId)];
      const sessionMessageCount = Number.isFinite(Number(sessionMessageCountRaw)) ? Number(sessionMessageCountRaw) : 0;
      const sourceKind =
        isRecording || (connection && priority !== 'server')
          ? 'recording'
          : serverAssignedSet.has(roomId)
            ? 'assigned'
            : 'unknown';
      const sourceText = sourceKind === 'recording' ? '关注主播' : sourceKind === 'assigned' ? '本站分配' : '未知来源';
      const sourceClass =
        sourceKind === 'recording'
          ? 'text-sky-500/80 dark:text-sky-400'
          : sourceKind === 'assigned'
            ? 'text-emerald-500/80 dark:text-emerald-400'
            : 'text-muted-foreground';

      return {
        roomId,
        uid,
        sourceKind,
        username: recordingMeta?.username || status?.username || `房间 ${roomId}`,
        faceUrl: recordingMeta?.faceUrl || status?.faceUrl || '',
        isConnected,
        stateText: isConnected ? '已连接' : '等待连接',
        stateClass: isConnected
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
        sourceText,
        sourceClass,
        connectedAt: connection?.connectedAt ?? null,
        sessionMessageCount,
        todayDanmakusCount: Number(recordingMeta?.todayDanmakusCount ?? 0),
        providedDanmakuDataCount: Number(recordingMeta?.providedDanmakuDataCount ?? 0),
        providedMessageCount: Number(recordingMeta?.providedMessageCount ?? 0)
      };
    })
    .sort((a, b) => {
      if (a.isConnected !== b.isConnected) {
        return a.isConnected ? -1 : 1;
      }
      const timeA = a.connectedAt ?? 0;
      const timeB = b.connectedAt ?? 0;
      if (timeA !== timeB) {
        return timeB - timeA;
      }
      return a.roomId - b.roomId;
    });
});

const filteredConnectionRoomCards = computed(() => {
  let list = connectionRoomCards.value;

  const query = roomSearchQuery.value.trim().toLowerCase();
  if (query) {
    list = list.filter(
      (room) =>
        room.username.toLowerCase().includes(query) ||
        String(room.roomId).includes(query) ||
        (room.uid && String(room.uid).includes(query))
    );
  }

  switch (roomFilter.value) {
    case 'recording':
      list = list.filter((r) => r.sourceKind === 'recording');
      break;
    case 'assigned':
      list = list.filter((r) => r.sourceKind === 'assigned');
      break;
    case 'connected':
      list = list.filter((r) => r.isConnected);
      break;
  }

  return list;
});

const connectionShortfall = computed(() => {
  if (!props.runtimeState.isRunning || !props.runtimeState.runtimeConnected) {
    return null;
  }

  const shortfall = props.runtimeState.holdingRoomShortfall;
  const missingCount = Number.isFinite(Number(shortfall?.missingCount))
    ? Math.max(0, Math.floor(Number(shortfall?.missingCount)))
    : 0;
  if (missingCount <= 0) {
    return null;
  }

  const detailParts: string[] = [];
  const assignableCandidateCount = Number.isFinite(Number(shortfall?.assignableCandidateCount))
    ? Math.max(0, Math.floor(Number(shortfall?.assignableCandidateCount)))
    : 0;
  const blockedBySameAccountCount = Number.isFinite(Number(shortfall?.blockedBySameAccountCount))
    ? Math.max(0, Math.floor(Number(shortfall?.blockedBySameAccountCount)))
    : 0;
  const blockedByOtherAccountsCount = Number.isFinite(Number(shortfall?.blockedByOtherAccountsCount))
    ? Math.max(0, Math.floor(Number(shortfall?.blockedByOtherAccountsCount)))
    : 0;
  const showSameAccountReservationDetails =
    shortfall?.reason === 'blocked_by_reservations' &&
    blockedBySameAccountCount > 0 &&
    blockedByOtherAccountsCount <= 0;
  const showCandidatePoolDetails = shortfall?.reason === 'candidate_pool_exhausted';

  if (showCandidatePoolDetails && assignableCandidateCount > 0) {
    detailParts.push(`已分配 ${assignableCandidateCount} 个`);
  }
  if (showSameAccountReservationDetails && blockedBySameAccountCount > 0) {
    detailParts.push(`同账号占用 ${blockedBySameAccountCount} 个`);
  }

  return {
    missingCount,
    compactText: `还差 ${missingCount} 个`,
    title: `当前未连满，还差 ${missingCount} 个房间`,
    reasonText: getHoldingRoomShortfallReasonText(shortfall),
    detailText: detailParts.join('，')
  };
});

const cookieBadgeClass = computed(() =>
  cookieStatusType.value === 'success'
    ? 'border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : 'border-amber-300 bg-amber-500/10 text-amber-700 dark:text-amber-300'
);

const selectedRoomId = ref<number | null>(null);
const nowTimestamp = ref(Date.now());
const retainedRuntimeError = ref<string | null>(null);
const retainedRuntimeErrorStartedAt = ref<number | null>(null);
const dismissedRuntimeError = ref<string | null>(null);
let nowTimer: number | undefined;
let runtimeErrorAutoDismissTimer: number | undefined;

const visibleRuntimeError = computed(() => {
  const error = retainedRuntimeError.value;
  if (error === null || dismissedRuntimeError.value === error) {
    return null;
  }
  return error;
});

const isRuntimeErrorRecovered = computed(
  () => visibleRuntimeError.value !== null && props.runtimeState.lastError === null
);

const runtimeErrorOccurredAgo = useTimeAgoIntl(
  computed(() => retainedRuntimeErrorStartedAt.value ?? Date.now()),
  {
    locale: 'zh-CN',
    relativeTimeFormatOptions: {
      numeric: 'always',
      style: 'long'
    },
    updateInterval: 1000
  }
);

const selectedRoom = computed(() =>
  selectedRoomId.value === null
    ? null
    : connectionRoomCards.value.find((room) => room.roomId === selectedRoomId.value) ?? null
);

const formatDateTime = (ts?: number | null): string => {
  if (!ts) {
    return '—';
  }
  return new Date(ts).toLocaleString();
};

const formatDuration = (startTs?: number | null): string => {
  if (!startTs) {
    return '—';
  }
  const ms = Math.max(0, nowTimestamp.value - startTs);
  const seconds = Math.floor(ms / 1000);
  const hh = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, '0');
  const mm = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const ss = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const copyErrorText = async () => {
  if (!visibleRuntimeError.value) return;
  try {
    await navigator.clipboard.writeText(visibleRuntimeError.value);
    toast.success('错误信息已复制到剪贴板');
  } catch {
    toast.error('复制失败');
  }
};

const emit = defineEmits<{
  (e: 'refresh-runtime-state'): void;
  (e: 'clear-runtime-error', error: string): void;
  (e: 'force-takeover'): void;
  (e: 'start-core'): void;
  (e: 'stop-core'): void;
  (e: 'install-app-update'): void;
}>();

const pendingAppUpdate = computed(() =>
  props.runtimeState.isRunning && props.availableUpdateVersion
    ? {
        version: props.availableUpdateVersion,
        description: `检测到新版本 ${props.availableUpdateVersion}，建议尽快更新以获得更好的体验和稳定性`
      }
    : null
);

const openLiveRoom = async (roomId: number) => {
  try {
    await openUrl(`https://live.bilibili.com/${roomId}`);
  } catch (error) {
    console.error('打开直播间失败:', error);
  }
};

const openUserSpace = async (uid: number) => {
  if (!Number.isFinite(uid) || uid <= 0) {
    return;
  }
  try {
    await openUrl(`https://space.bilibili.com/${uid}`);
  } catch (error) {
    console.error('打开主播主页失败:', error);
  }
};

const openRoomDetails = (roomId: number) => {
  selectedRoomId.value = roomId;
};

const closeRoomDetails = () => {
  selectedRoomId.value = null;
};

const clearRuntimeErrorAutoDismissTimer = () => {
  if (runtimeErrorAutoDismissTimer !== undefined) {
    clearTimeout(runtimeErrorAutoDismissTimer);
    runtimeErrorAutoDismissTimer = undefined;
  }
};

const dismissRuntimeError = () => {
  const error = visibleRuntimeError.value;
  if (error === null) {
    return;
  }
  dismissedRuntimeError.value = error;
  retainedRuntimeError.value = null;
  retainedRuntimeErrorStartedAt.value = null;
  clearRuntimeErrorAutoDismissTimer();
  emit('clear-runtime-error', error);
};

watch(
  () => props.runtimeState.lastError,
  (nextError, previousError) => {
    if (nextError) {
      if (nextError !== previousError) {
        dismissedRuntimeError.value = null;
        retainedRuntimeErrorStartedAt.value = Date.now();
      } else if (retainedRuntimeErrorStartedAt.value === null) {
        retainedRuntimeErrorStartedAt.value = Date.now();
      }

      retainedRuntimeError.value = nextError;
      return;
    }

    if (!previousError) {
      retainedRuntimeError.value = null;
      retainedRuntimeErrorStartedAt.value = null;
      return;
    }

    if (dismissedRuntimeError.value === previousError) {
      retainedRuntimeError.value = null;
      retainedRuntimeErrorStartedAt.value = null;
      return;
    }

    retainedRuntimeError.value = previousError;
    if (retainedRuntimeErrorStartedAt.value === null) {
      retainedRuntimeErrorStartedAt.value = Date.now();
    }
  },
  { immediate: true }
);

watch(
  () => [visibleRuntimeError.value, retainedRuntimeErrorStartedAt.value] as const,
  ([nextError, startedAt]) => {
    clearRuntimeErrorAutoDismissTimer();

    if (nextError === null) {
      return;
    }

    const remainingMs = getRuntimeErrorAutoDismissDelay(startedAt);
    if (remainingMs === null) {
      return;
    }

    if (remainingMs <= 0) {
      dismissRuntimeError();
      return;
    }

    const closingError = nextError;
    runtimeErrorAutoDismissTimer = window.setTimeout(() => {
      if (visibleRuntimeError.value !== closingError) {
        return;
      }
      dismissRuntimeError();
    }, remainingMs);
  },
  { immediate: true }
);

onMounted(() => {
  nowTimer = window.setInterval(() => {
    nowTimestamp.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (nowTimer) {
    clearInterval(nowTimer);
    nowTimer = undefined;
  }
  clearRuntimeErrorAutoDismissTimer();
});
</script>

<template>
  <div class="space-y-4">
    <!-- Page header with actions -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">运行仪表盘</h2>
        <p class="mt-0.5 text-sm text-muted-foreground">实时监控核心连接状态与弹幕吞吐统计</p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="refreshingState"
          title="刷新运行状态"
          @click="emit('refresh-runtime-state')"
        >
          <RefreshCw :class="['h-3.5 w-3.5', refreshingState && 'animate-spin']" />
          刷新状态
        </Button>
        <Button
          v-if="!runtimeState.isRunning"
          size="sm"
          :disabled="startingCore"
          title="启动弹幕核心服务"
          @click="emit('start-core')"
        >
          <Loader2 v-if="startingCore" class="h-3.5 w-3.5 animate-spin" />
          <Play v-else class="h-3.5 w-3.5" />
          启动核心
        </Button>
        <Button
          v-else
          variant="destructive"
          size="sm"
          :disabled="stoppingCore"
          title="停止弹幕核心服务"
          @click="emit('stop-core')"
        >
          <Loader2 v-if="stoppingCore" class="h-3.5 w-3.5 animate-spin" />
          <StopCircle v-else class="h-3.5 w-3.5" />
          停止核心
        </Button>
      </div>
    </div>

    <!-- Alerts -->
    <Alert v-if="runtimeState.lockConflict" class="border-amber-300/80 bg-amber-500/10">
      <AlertCircle class="h-4 w-4 text-amber-600 dark:text-amber-300" />
      <AlertTitle>核心锁冲突</AlertTitle>
      <AlertDescription class="flex items-center justify-between gap-3">
        <span>
          当前账号下已有同 IP 客户端持有核心锁
          <template v-if="runtimeState.lockConflictOwnerClientId">
            ：<code class="rounded bg-muted px-1 text-xs">{{ runtimeState.lockConflictOwnerClientId }}</code>
          </template>
        </span>
        <Button variant="outline" size="sm" :disabled="forcingLock" @click="emit('force-takeover')">
          <Loader2 v-if="forcingLock" class="h-3.5 w-3.5 animate-spin" />
          强制接管
        </Button>
      </AlertDescription>
    </Alert>

    <Alert v-if="visibleRuntimeError" variant="destructive" class="gap-3">
      <AlertCircle class="h-4 w-4" />
      <div class="min-w-0 flex-1 space-y-1.5">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <AlertTitle class="flex items-center gap-2">
              <span>最近运行异常</span>
              <Button
                variant="ghost"
                size="sm"
                class="h-5 px-1.5 text-[11px] text-destructive-foreground hover:bg-destructive/20"
                title="复制错误信息"
                @click="copyErrorText"
              >
                <Copy class="mr-1 h-3 w-3" />
                复制
              </Button>
            </AlertTitle>
            <AlertDescription class="mt-1 break-all font-mono text-xs">{{ visibleRuntimeError }}</AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="h-6 w-6 shrink-0 text-destructive-foreground hover:bg-destructive/20"
            title="关闭提示"
            @click="dismissRuntimeError"
          >
            <X class="h-3.5 w-3.5" />
          </Button>
        </div>
        <p class="text-xs text-destructive/80">
          发生于 {{ runtimeErrorOccurredAgo }}
          <span v-if="isRuntimeErrorRecovered">，当前已恢复连接</span>
        </p>
      </div>
    </Alert>

    <Alert v-if="pendingAppUpdate" class="border-sky-300/80 bg-sky-500/10">
      <Download class="h-4 w-4 text-sky-600 dark:text-sky-300" />
      <AlertTitle>发现新版本 {{ pendingAppUpdate.version }}</AlertTitle>
      <AlertDescription class="flex items-center justify-between gap-3">
        <span>{{ pendingAppUpdate.description }}</span>
        <Button size="sm" variant="outline" class="shrink-0" :disabled="props.appUpdateBusy" @click="emit('install-app-update')">
          <Loader2 v-if="props.installingAppUpdate" class="h-3.5 w-3.5 animate-spin" />
          <Download v-else class="h-3.5 w-3.5" />
          立即更新
        </Button>
      </AlertDescription>
    </Alert>

    <!-- Status Banner -->
    <Card
      :class="[
        'border transition-all',
        runtimeState.isRunning
          ? 'border-emerald-500/40 bg-linear-to-r from-emerald-500/5 via-transparent to-transparent'
          : 'bg-card/60'
      ]"
    >
      <CardContent class="flex items-center gap-4 p-4">
        <div
          :class="[
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors',
            runtimeState.isRunning ? 'bg-emerald-500/15' : 'bg-muted'
          ]"
        >
          <Server
            :class="[
              'h-5 w-5',
              runtimeState.isRunning ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
            ]"
          />
        </div>
        <div class="flex-1">
          <div class="flex items-center gap-2">
            <p class="font-semibold">
              {{ runtimeState.isRunning ? '弹幕核心正在运行' : '弹幕核心已停止' }}
            </p>
            <span
              v-if="runtimeState.isRunning"
              class="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse-dot"
            />
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span class="flex items-center gap-1.5">
              <PlugZap class="h-3.5 w-3.5 text-primary" />
              {{ runtimeState.runtimeConnected ? '服务端运行态已连接' : '服务端通道离线' }}
            </span>
            <span class="flex items-center gap-1.5">
              <TvMinimal class="h-3.5 w-3.5 text-primary" />
              已连接 {{ runtimeState.connectedRooms.length }} 个房间
            </span>
            <span class="flex items-center gap-1.5">
              <MessageSquare class="h-3.5 w-3.5 text-primary" />
              已接收 {{ runtimeState.messageCount.toLocaleString() }} 条弹幕消息
            </span>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- Stat Cards (Equal Height & Structured Grid) -->
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card class="flex flex-col justify-between bg-card/60 p-3.5 shadow-xs">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-muted-foreground">B 站凭据状态</p>
          <Cookie class="h-4 w-4 text-muted-foreground/70" />
        </div>
        <div class="my-1.5">
          <Badge variant="outline" :class="cookieBadgeClass" class="text-xs font-normal">{{ cookieStatusText }}</Badge>
        </div>
        <p
          v-if="activeAuthProfile"
          class="truncate text-[11px] text-muted-foreground"
          :title="`${activeAuthProfile.uname} (UID ${activeAuthProfile.uid})`"
        >
          {{ activeAuthProfile.uname }} (UID {{ activeAuthProfile.uid }})
        </p>
        <p v-else class="truncate text-[11px] text-muted-foreground">
          {{ authSourceText }}
        </p>
      </Card>

      <Card class="flex flex-col justify-between bg-card/60 p-3.5 shadow-xs">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-muted-foreground">在线客户端</p>
          <MonitorSmartphone class="h-4 w-4 text-muted-foreground/70" />
        </div>
        <div class="my-1 text-2xl font-bold tabular-nums">
          {{ remoteClients.length }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          同账号协同客户端总数
        </p>
      </Card>

      <Card class="flex flex-col justify-between bg-card/60 p-3.5 shadow-xs">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-muted-foreground">已连接房间</p>
          <TvMinimal class="h-4 w-4 text-muted-foreground/70" />
        </div>
        <div class="my-1 text-2xl font-bold tabular-nums">
          {{ runtimeState.connectedRooms.length }}
        </div>
        <p v-if="connectionShortfall" class="truncate text-[11px] text-amber-700 dark:text-amber-300" :title="connectionShortfall.reasonText">
          {{ connectionShortfall.compactText }} · {{ connectionShortfall.reasonText }}
        </p>
        <p v-else class="text-[11px] text-muted-foreground">
          当前已稳定承载弹幕连接
        </p>
      </Card>

      <Card class="flex flex-col justify-between bg-card/60 p-3.5 shadow-xs">
        <div class="flex items-center justify-between">
          <p class="text-xs font-medium text-muted-foreground">待上传队列</p>
          <MessageSquare class="h-4 w-4 text-muted-foreground/70" />
        </div>
        <div class="my-1 text-2xl font-bold tabular-nums">
          {{ runtimeState.pendingMessageCount.toLocaleString() }}
        </div>
        <p class="text-[11px] text-muted-foreground">
          等待持久化或同步到后端
        </p>
      </Card>
    </div>

    <!-- Shortfall Alert -->
    <Alert v-if="connectionShortfall" class="border-amber-300/80 bg-amber-500/10">
      <AlertCircle class="h-4 w-4 text-amber-600 dark:text-amber-300" />
      <AlertTitle>{{ connectionShortfall.title }}</AlertTitle>
      <AlertDescription class="text-xs leading-5">
        {{ connectionShortfall.reasonText }}
        <span v-if="connectionShortfall.detailText"> · {{ connectionShortfall.detailText }}</span>
      </AlertDescription>
    </Alert>

    <!-- Online Clients Section -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <MonitorSmartphone class="h-4 w-4 text-primary" />
            <CardTitle class="text-sm">在线客户端集群</CardTitle>
          </div>
          <Badge variant="secondary" class="text-[10px]">{{ remoteClients.length }} 个客户端</Badge>
        </div>
        <CardDescription>
          账号: {{ accountName }}<span v-if="accountId !== null"> #{{ accountId }}</span> · 本机标识:
          <code class="font-mono text-[11px]">{{ localClientId.slice(0, 8) }}...</code>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="remoteClients.length > 0" class="grid gap-2 sm:grid-cols-2">
          <div
            v-for="client in remoteClients"
            :key="client.clientId"
            class="flex items-center justify-between rounded-lg border bg-background/40 p-2.5 transition-colors hover:bg-background/70"
          >
            <div class="flex items-center gap-2.5">
              <div
                :class="[
                  'h-2 w-2 shrink-0 rounded-full',
                  client.isRunning ? 'bg-emerald-500 animate-pulse-dot' : 'bg-muted-foreground/40'
                ]"
              />
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-xs font-medium">
                    {{ client.clientId === localClientId ? '本机客户端' : client.clientId.slice(0, 10) + '...' }}
                  </span>
                  <Badge v-if="client.clientId === localClientId" class="h-4 px-1 text-[9px]">本机</Badge>
                  <Badge v-if="client.runtimeConnected" variant="outline" class="h-4 px-1 text-[9px]">RT</Badge>
                </div>
                <p class="mt-0.5 text-[11px] text-muted-foreground">
                  {{ client.connectedRooms.length }} 房间 · {{ client.messageCount.toLocaleString() }} 条消息
                  <span v-if="client.ip"> · {{ client.ip }}</span>
                </p>
              </div>
            </div>
            <span v-if="client.lastHeartbeat" class="shrink-0 font-mono text-[10px] text-muted-foreground">
              {{ new Date(client.lastHeartbeat).toLocaleTimeString() }}
            </span>
          </div>
        </div>
        <div v-else class="flex h-24 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
          暂无在线客户端
        </div>
      </CardContent>
    </Card>

    <!-- Connection Details with Search & Filter -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div class="flex items-center gap-2">
              <TvMinimal class="h-4 w-4 text-primary" />
              <CardTitle class="text-sm">房间连接监控</CardTitle>
            </div>
            <CardDescription class="mt-0.5">
              已连接 {{ runtimeState.connectedRooms.length }} / 总分配 {{ connectionRoomCards.length }} 房间
              <span v-if="runtimeState.lastRoomAssigned"> · 最近分配: #{{ runtimeState.lastRoomAssigned }}</span>
            </CardDescription>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <div class="relative w-44">
              <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                v-model="roomSearchQuery"
                placeholder="搜索房间或主播..."
                class="h-7.5 pl-8 text-xs"
              />
            </div>
            <div class="flex items-center gap-1 rounded-md border bg-background/50 p-0.5 text-xs">
              <Button
                size="sm"
                :variant="roomFilter === 'all' ? 'secondary' : 'ghost'"
                class="h-6 px-2 text-[11px]"
                @click="roomFilter = 'all'"
              >
                全部
              </Button>
              <Button
                size="sm"
                :variant="roomFilter === 'recording' ? 'secondary' : 'ghost'"
                class="h-6 px-2 text-[11px]"
                @click="roomFilter = 'recording'"
              >
                关注
              </Button>
              <Button
                size="sm"
                :variant="roomFilter === 'assigned' ? 'secondary' : 'ghost'"
                class="h-6 px-2 text-[11px]"
                @click="roomFilter = 'assigned'"
              >
                分配
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div v-if="filteredConnectionRoomCards.length > 0" class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="room in filteredConnectionRoomCards"
            :key="room.roomId"
            class="flex items-center justify-between rounded-lg border bg-background/40 p-2.5 transition-colors hover:bg-background/80"
          >
            <div class="flex min-w-0 items-center gap-2.5">
              <img
                v-if="room.faceUrl"
                :src="room.faceUrl"
                :alt="room.username"
                referrerpolicy="no-referrer"
                class="h-8 w-8 rounded-full border border-border object-cover"
              />
              <div
                v-else
                class="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground"
              >
                <UserRound class="h-4 w-4" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-semibold" :title="room.username">
                  {{ room.username }}
                </p>
                <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span class="font-mono text-foreground/80">#{{ room.roomId }}</span>
                  <span>·</span>
                  <span :class="room.sourceClass">{{ room.sourceText }}</span>
                </div>
                <p class="text-[10px] text-muted-foreground">
                  本次 <strong class="font-medium text-foreground">{{ room.sessionMessageCount.toLocaleString() }}</strong> 条
                </p>
              </div>
            </div>

            <div class="flex flex-col items-end gap-1.5 shrink-0 pl-2">
              <Badge variant="outline" :class="room.stateClass" class="h-4.5 px-1.5 text-[9px]">
                {{ room.stateText }}
              </Badge>
              <div class="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  class="h-5.5 px-1.5 text-[10px]"
                  @click.stop="openRoomDetails(room.roomId)"
                >
                  详情
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  class="h-5.5 px-1.5 text-[10px]"
                  @click.stop="openLiveRoom(room.roomId)"
                >
                  <ExternalLink class="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="flex h-28 flex-col items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
          <p>{{ connectionRoomCards.length === 0 ? '暂无连接中的直播间，启动核心后将自动建立连接' : '没有匹配当前条件的直播间' }}</p>
        </div>
      </CardContent>
    </Card>

    <!-- Message Type Distribution -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <BarChart3 class="h-4 w-4 text-primary" />
            <CardTitle class="text-sm">接收弹幕消息分布</CardTitle>
          </div>
          <Badge variant="outline" class="text-[10px]">
            {{ messageCmdRows.length }} 种指令 · 共 {{ runtimeState.messageCount.toLocaleString() }} 条
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div v-if="messageTypeRows.length > 0" class="max-h-72 space-y-2 overflow-y-auto pr-1">
          <div
            v-for="row in messageTypeRows"
            :key="row.cmd"
            class="group flex items-center gap-2.5 text-xs"
            :title="`${row.cmd}: ${row.count.toLocaleString()} 条 (${row.percentage.toFixed(1)}%)`"
          >
            <span class="w-28 shrink-0 truncate font-mono text-muted-foreground" :title="row.cmd">{{ row.cmd }}</span>
            <div class="h-4 flex-1 overflow-hidden rounded-sm bg-muted/60">
              <div
                class="bar-fill h-full rounded-sm"
                :class="barColors[row.colorIndex]"
                :style="{ width: Math.max(row.percentage, 0.6) + '%' }"
              />
            </div>
            <span class="w-16 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
              {{ row.count.toLocaleString() }}
            </span>
          </div>
        </div>
        <div v-else class="flex h-24 items-center justify-center text-xs text-muted-foreground">
          暂无接收消息数据
        </div>
      </CardContent>
    </Card>

    <!-- Room Details Dialog -->
    <Dialog
      :open="selectedRoom !== null"
      @update:open="
        (opened) => {
          if (!opened) closeRoomDetails();
        }
      "
    >
      <DialogContent v-if="selectedRoom" class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2.5">
            <img
              v-if="selectedRoom.faceUrl"
              :src="selectedRoom.faceUrl"
              :alt="selectedRoom.username"
              referrerpolicy="no-referrer"
              class="h-7 w-7 rounded-full object-cover"
            />
            <span class="truncate">{{ selectedRoom.username }}</span>
          </DialogTitle>
          <DialogDescription>
            房间 #{{ selectedRoom.roomId }} · {{ selectedRoom.sourceText }} · {{ selectedRoom.stateText }}
          </DialogDescription>
        </DialogHeader>

        <div class="grid grid-cols-2 gap-2.5 rounded-lg border bg-background/50 p-3 text-xs">
          <div>
            <p class="text-muted-foreground">本次录制开始</p>
            <p class="mt-0.5 font-medium">{{ formatDateTime(selectedRoom.connectedAt) }}</p>
          </div>
          <div>
            <p class="text-muted-foreground">录制持续时长</p>
            <p class="mt-0.5 font-medium">{{ formatDuration(selectedRoom.connectedAt) }}</p>
          </div>
          <div>
            <p class="text-muted-foreground">本次接收弹幕</p>
            <p class="mt-0.5 font-medium tabular-nums">{{ selectedRoom.sessionMessageCount.toLocaleString() }} 条</p>
          </div>
          <div>
            <p class="text-muted-foreground">今日收录弹幕</p>
            <p class="mt-0.5 font-medium tabular-nums">{{ selectedRoom.todayDanmakusCount.toLocaleString() }} 条</p>
          </div>
          <div>
            <p class="text-muted-foreground">累计贡献数据</p>
            <p class="mt-0.5 font-medium tabular-nums">{{ selectedRoom.providedDanmakuDataCount.toLocaleString() }}</p>
          </div>
          <div>
            <p class="text-muted-foreground">累计贡献消息</p>
            <p class="mt-0.5 font-medium tabular-nums">{{ selectedRoom.providedMessageCount.toLocaleString() }}</p>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" @click="openLiveRoom(selectedRoom.roomId)">
            <ExternalLink class="mr-1 h-3.5 w-3.5" />
            前往直播间
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="!selectedRoom.uid"
            @click="selectedRoom.uid && openUserSpace(selectedRoom.uid)"
          >
            <ExternalLink class="mr-1 h-3.5 w-3.5" />
            前往主播主页
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
