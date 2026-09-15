<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Bell,
  BellOff,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
  UserRoundPlus,
  Users
} from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import type { LocalAppConfigDto, RecordingInfoDto } from '../../types/api';
import FollowImportModal from './FollowImportModal.vue';

type FilterType = 'all' | 'living' | 'offline' | 'notification' | 'public' | 'private';
type SortType = 'live-first' | 'message-desc' | 'default';

const props = defineProps<{
  recordings: RecordingInfoDto[];
  localConfig: LocalAppConfigDto;
  refreshingRecordings: boolean;
  addingRecording: boolean;
  removingRecordingUid: number | null;
  updatingRecordingUid: number | null;
  importingFollows: boolean;
  importFollowsProgress: { done: number; total: number };
}>();

const emit = defineEmits<{
  (e: 'refresh-recordings'): void;
  (e: 'add-recording', uid: number): void;
  (e: 'remove-recording', uid: number): void;
  (e: 'update-recording-public', uid: number, isPublic: boolean): void;
  (e: 'import-follows', uids: number[]): void;
}>();

const newRecordingUid = ref<string | number>('');
const searchQuery = ref('');
const activeFilter = ref<FilterType>('all');
const activeSort = ref<SortType>('live-first');
const showFollowImportModal = ref(false);

const isRecordingLiveNotificationEnabled = (uid: number): boolean =>
  props.localConfig.recordingLiveNotificationUids.includes(uid);

const updateRecordingLiveNotification = (uid: number, enabled: boolean) => {
  const normalizedUid = Math.floor(Number(uid));
  if (!Number.isFinite(normalizedUid) || normalizedUid <= 0) {
    return;
  }

  const next = new Set(props.localConfig.recordingLiveNotificationUids);
  if (enabled) {
    next.add(normalizedUid);
  } else {
    next.delete(normalizedUid);
  }

  props.localConfig.recordingLiveNotificationUids = Array.from(next).sort((left, right) => left - right);
};

const batchSetLiveNotification = (enable: boolean) => {
  const allUids = props.recordings
    .map((item) => Number(item.channel?.uId))
    .filter((uid) => Number.isFinite(uid) && uid > 0)
    .map((uid) => Math.floor(uid));

  if (enable) {
    props.localConfig.recordingLiveNotificationUids = Array.from(new Set(allUids)).sort((left, right) => left - right);
  } else {
    props.localConfig.recordingLiveNotificationUids = [];
  }
};

const submitAddRecording = () => {
  const rawUid = newRecordingUid.value;
  const uid = typeof rawUid === 'string' ? Number(rawUid.trim()) : rawUid;
  if (!Number.isFinite(uid) || uid <= 0) {
    return;
  }
  emit('add-recording', Math.floor(uid));
  newRecordingUid.value = '';
};

const stats = computed(() => {
  const total = props.recordings.length;
  const living = props.recordings.filter((item) => item.channel?.isLiving).length;
  const notificationCount = props.recordings.filter((item) =>
    isRecordingLiveNotificationEnabled(Number(item.channel?.uId))
  ).length;
  const publicCount = props.recordings.filter((item) => Boolean(item.setting?.isPublic)).length;
  const totalProvidedMessages = props.recordings.reduce(
    (sum, item) => sum + Number(item.providedMessageCount ?? 0),
    0
  );

  return { total, living, notificationCount, publicCount, totalProvidedMessages };
});

const filteredRecordings = computed(() => {
  let list = [...props.recordings];

  const query = searchQuery.value.trim().toLowerCase();
  if (query) {
    list = list.filter((item) => {
      const name = (item.channel?.uName || '').toLowerCase();
      const uid = String(item.channel?.uId || '');
      const roomId = String(item.channel?.roomId || '');
      return name.includes(query) || uid.includes(query) || roomId.includes(query);
    });
  }

  switch (activeFilter.value) {
    case 'living':
      list = list.filter((item) => Boolean(item.channel?.isLiving));
      break;
    case 'offline':
      list = list.filter((item) => !item.channel?.isLiving && !item.channel?.isDeleted);
      break;
    case 'notification':
      list = list.filter((item) => isRecordingLiveNotificationEnabled(Number(item.channel?.uId)));
      break;
    case 'public':
      list = list.filter((item) => Boolean(item.setting?.isPublic));
      break;
    case 'private':
      list = list.filter((item) => !item.setting?.isPublic);
      break;
  }

  list.sort((a, b) => {
    if (activeSort.value === 'live-first') {
      const liveA = a.channel?.isLiving ? 1 : 0;
      const liveB = b.channel?.isLiving ? 1 : 0;
      if (liveA !== liveB) return liveB - liveA;
    } else if (activeSort.value === 'message-desc') {
      const msgA = Number(a.providedMessageCount ?? 0);
      const msgB = Number(b.providedMessageCount ?? 0);
      if (msgA !== msgB) return msgB - msgA;
    }
    return 0;
  });

  return list;
});
</script>

<template>
  <div class="space-y-4">
    <TooltipProvider>
      <!-- Header -->
      <div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 class="text-xl font-semibold tracking-tight">录制主播管理</h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            管理当前账号添加的弹幕录制主播，录制数据将贡献至全站供历史查询
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" @click="showFollowImportModal = true">
            <UserRoundPlus class="h-3.5 w-3.5" />
            导入关注
          </Button>
          <Button variant="outline" size="sm" :disabled="refreshingRecordings" @click="emit('refresh-recordings')">
            <RefreshCw :class="['h-3.5 w-3.5', refreshingRecordings && 'animate-spin']" />
            刷新列表
          </Button>
        </div>
      </div>

      <!-- Overview Stats Strip -->
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="flex items-center gap-3 rounded-lg border bg-card/60 px-3.5 py-2.5 shadow-xs">
          <div class="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Users class="h-4 w-4" />
          </div>
          <div>
            <p class="text-[11px] text-muted-foreground">录制主播</p>
            <p class="text-base font-semibold tabular-nums">{{ stats.total }} <span class="text-xs font-normal text-muted-foreground">人</span></p>
          </div>
        </div>

        <div class="flex items-center gap-3 rounded-lg border bg-card/60 px-3.5 py-2.5 shadow-xs">
          <div class="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Radio class="h-4 w-4" />
          </div>
          <div>
            <p class="text-[11px] text-muted-foreground">正在直播</p>
            <p class="text-base font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {{ stats.living }} <span class="text-xs font-normal text-muted-foreground">人</span>
            </p>
          </div>
        </div>

        <div class="flex items-center gap-3 rounded-lg border bg-card/60 px-3.5 py-2.5 shadow-xs">
          <div class="flex h-8 w-8 items-center justify-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
            <Bell class="h-4 w-4" />
          </div>
          <div>
            <p class="text-[11px] text-muted-foreground">开播提醒</p>
            <p class="text-base font-semibold tabular-nums">{{ stats.notificationCount }} <span class="text-xs font-normal text-muted-foreground">人</span></p>
          </div>
        </div>

        <div class="flex items-center gap-3 rounded-lg border bg-card/60 px-3.5 py-2.5 shadow-xs">
          <div class="flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Globe class="h-4 w-4" />
          </div>
          <div>
            <p class="text-[11px] text-muted-foreground">公开录制</p>
            <p class="text-base font-semibold tabular-nums">{{ stats.publicCount }} <span class="text-xs font-normal text-muted-foreground">人</span></p>
          </div>
        </div>
      </div>

      <!-- Add streamer card -->
      <Card class="bg-card/60">
        <CardHeader class="pb-2.5">
          <div class="flex items-center justify-between">
            <div>
              <CardTitle class="text-sm">添加录制主播</CardTitle>
              <CardDescription>输入 Bilibili 主播 UID 添加到录制计划</CardDescription>
            </div>
            <div v-if="recordings.length > 0" class="flex items-center gap-1.5 text-xs">
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                title="为全部主播开启系统开播提醒"
                @click="batchSetLiveNotification(true)"
              >
                <Bell class="mr-1 h-3 w-3" />
                全开提醒
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                title="为全部主播关闭系统开播提醒"
                @click="batchSetLiveNotification(false)"
              >
                <BellOff class="mr-1 h-3 w-3" />
                全关提醒
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div class="relative flex-1">
              <Input
                v-model="newRecordingUid"
                type="number"
                min="1"
                placeholder="输入主播 UID (如 39420959)"
                class="h-9"
                @keydown.enter.prevent="submitAddRecording"
              />
            </div>
            <Button size="sm" :disabled="addingRecording" class="h-9" @click="submitAddRecording">
              <Loader2 v-if="addingRecording" class="h-3.5 w-3.5 animate-spin" />
              <Plus v-else class="h-3.5 w-3.5" />
              添加录制
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- Filter & Search Toolbar -->
      <div class="flex flex-col gap-2.5 rounded-lg border bg-card/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            v-model="searchQuery"
            placeholder="搜索主播名、UID、房间号..."
            class="h-8 pl-8 text-xs"
          />
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            :variant="activeFilter === 'all' ? 'secondary' : 'ghost'"
            class="h-7 px-2.5 text-xs"
            @click="activeFilter = 'all'"
          >
            全部 ({{ stats.total }})
          </Button>
          <Button
            size="sm"
            :variant="activeFilter === 'living' ? 'secondary' : 'ghost'"
            class="h-7 px-2.5 text-xs text-emerald-600 dark:text-emerald-400"
            @click="activeFilter = 'living'"
          >
            <Radio class="mr-1 h-3 w-3" />
            直播中 ({{ stats.living }})
          </Button>
          <Button
            size="sm"
            :variant="activeFilter === 'notification' ? 'secondary' : 'ghost'"
            class="h-7 px-2.5 text-xs"
            @click="activeFilter = 'notification'"
          >
            <Bell class="mr-1 h-3 w-3" />
            已开提醒 ({{ stats.notificationCount }})
          </Button>
          <Button
            size="sm"
            :variant="activeFilter === 'public' ? 'secondary' : 'ghost'"
            class="h-7 px-2.5 text-xs"
            @click="activeFilter = 'public'"
          >
            <Globe class="mr-1 h-3 w-3" />
            公开 ({{ stats.publicCount }})
          </Button>
        </div>

        <div class="flex items-center gap-1.5 self-end sm:self-auto">
          <span class="text-[11px] text-muted-foreground">排序：</span>
          <select
            v-model="activeSort"
            class="h-7 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-hidden focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="live-first">开播中优先</option>
            <option value="message-desc">贡献消息降序</option>
            <option value="default">默认添加顺序</option>
          </select>
        </div>
      </div>

      <!-- Recording Streamers List -->
      <div v-if="filteredRecordings.length > 0" class="space-y-2">
        <div
          v-for="item in filteredRecordings"
          :key="item.channel.uId"
          class="flex flex-col gap-3 rounded-lg border bg-card/60 p-3 transition-colors hover:bg-card/90 sm:flex-row sm:items-center sm:justify-between"
        >
          <!-- Left: Profile & Channel Info -->
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <a
              :href="`https://space.bilibili.com/${item.channel.uId}`"
              target="_blank"
              rel="noopener noreferrer"
              class="relative shrink-0 transition-opacity hover:opacity-85"
              :title="`访问 ${item.channel.uName || item.channel.uId} 的 B 站主页`"
            >
              <img
                v-if="item.channel.faceUrl"
                :src="item.channel.faceUrl"
                :alt="item.channel.uName"
                referrerpolicy="no-referrer"
                class="h-10 w-10 rounded-full border border-border object-cover"
              />
              <div
                v-else
                class="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground"
              >
                <UserRound class="h-4 w-4" />
              </div>
              <span
                v-if="item.channel.isLiving"
                class="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-background bg-emerald-500 animate-pulse"
              />
            </a>

            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <a
                  :href="`https://space.bilibili.com/${item.channel.uId}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex items-center gap-1 truncate text-sm font-semibold hover:underline"
                >
                  <span class="truncate">{{ item.channel.uName || `UID ${item.channel.uId}` }}</span>
                  <ExternalLink class="h-3 w-3 shrink-0 text-muted-foreground" />
                </a>

                <Badge
                  v-if="item.channel.isDeleted"
                  variant="destructive"
                  class="h-4.5 shrink-0 px-1 text-[10px]"
                >
                  已注销
                </Badge>
                <Badge
                  v-else
                  variant="outline"
                  :class="
                    item.channel.isLiving
                      ? 'border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-muted-foreground/30 bg-muted/40 text-muted-foreground'
                  "
                  class="h-4.5 shrink-0 px-1.5 text-[10px]"
                >
                  {{ item.channel.isLiving ? '直播中' : '未开播' }}
                </Badge>
              </div>

              <div class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>UID: <code class="font-mono">{{ item.channel.uId }}</code></span>
                <span v-if="item.channel.roomId">
                  房间: <a :href="`https://live.bilibili.com/${item.channel.roomId}`" target="_blank" rel="noopener noreferrer" class="font-mono text-sky-600 hover:underline dark:text-sky-400">#{{ item.channel.roomId }}</a>
                </span>
                <span>贡献弹幕: <strong class="font-medium text-foreground">{{ (item.providedDanmakuDataCount ?? 0).toLocaleString() }}</strong></span>
                <span>消息: <strong class="font-medium text-foreground">{{ (item.providedMessageCount ?? 0).toLocaleString() }}</strong></span>
              </div>
            </div>
          </div>

          <!-- Right: Controls -->
          <div class="flex shrink-0 items-center justify-between gap-2.5 border-t border-border/50 pt-2 sm:border-0 sm:pt-0">
            <div class="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger as-child>
                  <div class="flex items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-xs">
                    <Bell class="h-3 w-3 text-muted-foreground" />
                    <span class="text-[11px] text-muted-foreground">开播提醒</span>
                    <Switch
                      :model-value="isRecordingLiveNotificationEnabled(item.channel.uId)"
                      :disabled="removingRecordingUid === item.channel.uId"
                      @update:model-value="updateRecordingLiveNotification(item.channel.uId, Boolean($event))"
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>开启后，该主播开播时将弹出系统通知</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger as-child>
                  <div class="flex items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-xs">
                    <component :is="item.setting?.isPublic ? Globe : Lock" class="h-3 w-3 text-muted-foreground" />
                    <span class="text-[11px] text-muted-foreground">公开</span>
                    <Switch
                      :model-value="Boolean(item.setting?.isPublic)"
                      :disabled="removingRecordingUid === item.channel.uId || updatingRecordingUid === item.channel.uId"
                      @update:model-value="emit('update-recording-public', item.channel.uId, Boolean($event))"
                    />
                    <Loader2
                      v-if="updatingRecordingUid === item.channel.uId"
                      class="h-3 w-3 animate-spin text-muted-foreground"
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>开启后其他用户可看到该主播正在由你的账号进行录制</p>
                </TooltipContent>
              </Tooltip>
            </div>

            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="取消录制此主播"
              :disabled="removingRecordingUid === item.channel.uId || updatingRecordingUid === item.channel.uId"
              @click="emit('remove-recording', item.channel.uId)"
            >
              <Loader2 v-if="removingRecordingUid === item.channel.uId" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div
        v-else
        class="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center"
      >
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Radio class="h-5 w-5" />
        </div>
        <p class="mt-3 text-sm font-medium">
          {{ searchQuery ? '未找到符合条件的主播' : '当前账号还没有录制主播' }}
        </p>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ searchQuery ? '尝试更换搜索关键词或清除过滤条件' : '在上方输入 UID 或点击「导入关注」批量添加' }}
        </p>
        <div class="mt-4 flex items-center gap-2">
          <Button v-if="searchQuery" variant="outline" size="sm" @click="searchQuery = ''">
            清除搜索
          </Button>
          <Button v-else variant="outline" size="sm" @click="showFollowImportModal = true">
            <UserRoundPlus class="mr-1 h-3.5 w-3.5" />
            从 B 站关注列表导入
          </Button>
        </div>
      </div>
    </TooltipProvider>

    <FollowImportModal
      v-model:open="showFollowImportModal"
      :recordings="recordings"
      :importing="importingFollows"
      :progress="importFollowsProgress"
      @import="(uids) => emit('import-follows', uids)"
    />
  </div>
</template>
