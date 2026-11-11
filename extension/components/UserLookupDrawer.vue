<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  ExternalLink,
  Filter,
  Loader2,
  Search,
  ShieldAlert,
  X,
} from 'lucide-vue-next';
import HistoryPager from './HistoryPager.vue';
import DanmakuContent from './DanmakuContent.vue';
import {
  fetchLiveContextDanmakus,
  fetchUserBootstrap,
  fetchUserHistoryPage,
  getChannelPageUrl,
  getLivePageUrl,
  getUserPageUrl,
} from '../utils/api';
import {
  formatDateTime,
  formatTimeOnly,
} from '../utils/decoder';
import {
  type DecodedDanmakuItem,
  type DecodedUserLiveGroup,
  type UserBlockHistoryItemV3,
  type WatchedChannelSummaryV3,
} from '../utils/types';

const logoUrl = chrome.runtime.getURL('icon/128.png');

const props = defineProps<{
  open: boolean;
  uid: number | null;
  initialName?: string;
  currentStreamerUid?: number | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'selectUid', uid: number, name?: string): void;
}>();

const searchInput = ref('');
const PAGE_SIZE = 15;

const loading = ref(false);
const loadingPage = ref(false);
const errorMsg = ref<string | null>(null);
const pageError = ref<string | null>(null);

const historyUserNames = ref<string[]>([]);
const watchedChannels = ref<WatchedChannelSummaryV3[]>([]);
const blocks = ref<UserBlockHistoryItemV3[]>([]);
const liveGroups = ref<DecodedUserLiveGroup[]>([]);
const totalLives = ref(0);
const currentPage = ref(1);
const listScroller = ref<HTMLElement | null>(null);

const selectedChannelUid = ref<number | undefined>(undefined);
const activeTab = ref<'lives' | 'channels' | 'blocks'>('lives');

// 某条弹幕的前后文弹窗状态
const contextModal = ref<{
  open: boolean;
  liveId: string;
  liveTitle: string;
  targetTs: number;
  loading: boolean;
  items: DecodedDanmakuItem[];
}>({
  open: false,
  liveId: '',
  liveTitle: '',
  targetTs: 0,
  loading: false,
  items: [],
});

const displayName = computed(() => {
  if (historyUserNames.value.length > 0) {
    return historyUserNames.value[0];
  }
  return props.initialName || (props.uid ? `UID ${props.uid}` : '用户查询');
});

const formerNames = computed(() => historyUserNames.value.slice(1));

const totalPages = computed(() => Math.max(1, Math.ceil(totalLives.value / PAGE_SIZE)));

function newestFirst(groups: DecodedUserLiveGroup[]) {
  return [...groups].sort((a, b) => b.live.startDate - a.live.startDate);
}

const loadUserData = async (targetUid: number, filterChannelUid?: number) => {
  if (!targetUid || targetUid <= 0) return;
  loading.value = true;
  errorMsg.value = null;
  pageError.value = null;
  currentPage.value = 1;

  try {
    const boot = await fetchUserBootstrap(targetUid, PAGE_SIZE, filterChannelUid);
    if (!filterChannelUid) {
      historyUserNames.value = boot.historyUserNames;
      watchedChannels.value = boot.watchedChannels;
      blocks.value = boot.blocks;
    }
    totalLives.value = boot.history.total;
    liveGroups.value = newestFirst(boot.history.groups);
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : '加载用户数据失败';
  } finally {
    loading.value = false;
  }
};

const goToPage = async (page: number) => {
  if (!props.uid || loadingPage.value) return;
  loadingPage.value = true;
  pageError.value = null;
  try {
    const res = await fetchUserHistoryPage(props.uid, page, PAGE_SIZE, selectedChannelUid.value);
    liveGroups.value = newestFirst(res.groups);
    totalLives.value = res.total;
    currentPage.value = res.page;
    await nextTick();
    listScroller.value?.scrollTo({ top: 0 });
  } catch (err) {
    pageError.value = err instanceof Error ? err.message : '翻页失败';
  } finally {
    loadingPage.value = false;
  }
};

const toggleChannelFilter = (channelUid?: number) => {
  if (selectedChannelUid.value === channelUid) {
    selectedChannelUid.value = undefined;
  } else {
    selectedChannelUid.value = channelUid;
  }
  activeTab.value = 'lives';
  if (props.uid) {
    void loadUserData(props.uid, selectedChannelUid.value);
  }
};

const handleManualSearch = () => {
  const num = Number(searchInput.value.trim().replace(/^UID[:：\s]*/i, ''));
  if (Number.isFinite(num) && num > 0) {
    selectedChannelUid.value = undefined;
    emit('selectUid', Math.floor(num));
    searchInput.value = '';
  }
};

const openDanmakuContext = async (liveId: string, liveTitle: string, sendDate: number) => {
  contextModal.value = {
    open: true,
    liveId,
    liveTitle,
    targetTs: sendDate,
    loading: true,
    items: [],
  };
  try {
    const items = await fetchLiveContextDanmakus(liveId, sendDate, 45);
    contextModal.value.items = items;
  } catch {
    contextModal.value.items = [];
  } finally {
    contextModal.value.loading = false;
  }
};

watch(
  () => [props.open, props.uid] as const,
  ([isOpen, newUid]) => {
    if (isOpen && newUid && newUid > 0) {
      selectedChannelUid.value = undefined;
      activeTab.value = 'lives';
      void loadUserData(newUid);
    }
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[2147483645] flex justify-end bg-black/40 backdrop-blur-[2px] transition-opacity"
    @click.self="emit('close')"
  >
    <aside
      class="relative flex h-full w-[480px] max-w-[92vw] flex-col border-l border-border bg-background/95 text-foreground shadow-2xl backdrop-blur-xl"
    >
      <!-- 顶部栏与快捷查 UID -->
      <header class="flex flex-col gap-3 border-b border-border px-4 py-3.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <img :src="logoUrl" alt="" class="h-7 w-7 shrink-0 rounded-lg" />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h2 class="truncate text-sm font-semibold">{{ displayName }}</h2>
                <span v-if="uid" class="shrink-0 font-mono text-xs text-muted-foreground">
                  #{{ uid }}
                </span>
              </div>
              <p v-if="formerNames.length > 0" class="truncate text-[11px] text-muted-foreground">
                曾用名：{{ formerNames.join(' / ') }}
              </p>
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <a
              v-if="uid"
              :href="getUserPageUrl(uid)"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/60 px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary transition"
              title="在 Danmakus 主站打开完整用户分析"
            >
              <span>主站详情</span>
              <ExternalLink class="h-3 w-3" />
            </a>
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition"
              @click="emit('close')"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
        </div>

        <!-- 搜索框与当前直播间快捷筛选 -->
        <div class="flex items-center gap-2">
          <form class="relative flex-1" @submit.prevent="handleManualSearch">
            <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              v-model="searchInput"
              type="text"
              placeholder="输入任意 B站 UID 回车查询..."
              class="h-8 w-full rounded-md border border-input bg-muted/40 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
          </form>

          <button
            v-if="currentStreamerUid && currentStreamerUid > 0"
            type="button"
            class="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition"
            :class="
              selectedChannelUid === currentStreamerUid
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-accent'
            "
            @click="toggleChannelFilter(currentStreamerUid)"
          >
            <Filter class="h-3 w-3" />
            <span>只看本房</span>
          </button>
        </div>

        <!-- 子导航 Tabs -->
        <div class="flex items-center justify-between border-t border-border/60 pt-2 text-xs">
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="rounded-md px-2.5 py-1 font-medium transition"
              :class="
                activeTab === 'lives'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              "
              @click="activeTab = 'lives'"
            >
              发言场次 ({{ totalLives }})
            </button>
            <button
              type="button"
              class="rounded-md px-2.5 py-1 font-medium transition"
              :class="
                activeTab === 'channels'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              "
              @click="activeTab = 'channels'"
            >
              常看主播 ({{ watchedChannels.length }})
            </button>
            <button
              v-if="blocks.length > 0"
              type="button"
              class="rounded-md px-2.5 py-1 font-medium transition"
              :class="
                activeTab === 'blocks'
                  ? 'bg-destructive/15 text-destructive'
                  : 'text-muted-foreground hover:text-foreground'
              "
              @click="activeTab = 'blocks'"
            >
              禁言记录 ({{ blocks.length }})
            </button>
          </div>

          <button
            v-if="selectedChannelUid"
            type="button"
            class="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            @click="toggleChannelFilter(undefined)"
          >
            <span>清除主播筛选</span>
            <X class="h-3 w-3" />
          </button>
        </div>
      </header>

      <!-- 主体内容区 -->
      <div ref="listScroller" class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        <div v-if="loading" class="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 class="h-6 w-6 animate-spin text-primary" />
          <span class="text-xs">正在查询全站直播发言档案...</span>
        </div>

        <div
          v-else-if="errorMsg"
          class="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
        >
          {{ errorMsg }}
        </div>

        <!-- Tab 1: 常看主播列表 -->
        <template v-else-if="activeTab === 'channels'">
          <div v-if="watchedChannels.length === 0" class="py-12 text-center text-xs text-muted-foreground">
            暂无常看主播统计
          </div>
          <div class="grid grid-cols-1 gap-2">
            <div
              v-for="ch in watchedChannels"
              :key="ch.uId"
              class="flex items-center justify-between rounded-lg border border-border bg-card/70 px-3 py-2 hover:border-primary/40 transition"
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <img
                  v-if="ch.faceUrl"
                  :src="ch.faceUrl"
                  referrerpolicy="no-referrer"
                  class="h-8 w-8 rounded-full object-cover border border-border"
                />
                <div class="min-w-0">
                  <div class="truncate text-xs font-medium">{{ ch.uName }}</div>
                  <div class="text-[11px] text-muted-foreground font-mono">UID {{ ch.uId }}</div>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <span class="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  互动 {{ ch.count }} 场
                </span>
                <button
                  type="button"
                  class="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-accent transition"
                  @click="toggleChannelFilter(ch.uId)"
                >
                  只看TA
                </button>
                <a
                  :href="getChannelPageUrl(ch.uId)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="rounded-md border border-border p-1 text-muted-foreground hover:text-foreground"
                  title="打开主播档案"
                >
                  <ExternalLink class="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          </div>
        </template>

        <!-- Tab 2: 禁言记录 -->
        <template v-else-if="activeTab === 'blocks'">
          <div class="space-y-2">
            <div
              v-for="(b, idx) in blocks"
              :key="idx"
              class="flex items-center justify-between rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs"
            >
              <div class="flex items-center gap-2">
                <ShieldAlert class="h-4 w-4 text-destructive shrink-0" />
                <div>
                  <div class="font-medium">{{ b.uName }} 直播间被禁言</div>
                  <div class="text-[11px] text-muted-foreground">{{ formatDateTime(b.date) }}</div>
                </div>
              </div>
              <a
                :href="getLivePageUrl(b.liveId)"
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary hover:underline text-[11px]"
              >
                查看当场
              </a>
            </div>
          </div>
        </template>

        <!-- Tab 3: 按场次发言记录 -->
        <template v-else>
          <!-- 常看主播横向速览胶囊 -->
          <div v-if="watchedChannels.length > 0 && !selectedChannelUid" class="flex items-center gap-1.5 overflow-x-auto pb-1">
            <button
              v-for="ch in watchedChannels.slice(0, 8)"
              :key="ch.uId"
              type="button"
              class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] hover:border-primary/50 transition"
              @click="toggleChannelFilter(ch.uId)"
            >
              <img
                v-if="ch.faceUrl"
                :src="ch.faceUrl"
                referrerpolicy="no-referrer"
                class="h-4 w-4 rounded-full object-cover"
              />
              <span class="max-w-[90px] truncate font-medium">{{ ch.uName }}</span>
              <span class="text-muted-foreground">{{ ch.count }}</span>
            </button>
          </div>

          <HistoryPager
            v-if="totalPages > 1"
            :page="currentPage"
            :total-pages="totalPages"
            :loading="loadingPage"
            @go="goToPage"
          />

          <div v-if="liveGroups.length === 0" class="py-14 text-center text-xs text-muted-foreground">
            未找到该用户的公开互动弹幕记录
          </div>

          <div
            v-for="group in liveGroups"
            :key="group.live.liveId"
            class="rounded-xl border border-border bg-card/80 overflow-hidden shadow-xs transition-opacity"
            :class="loadingPage ? 'pointer-events-none opacity-40' : ''"
          >
            <!-- 场次头部 -->
            <div class="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
              <div class="flex items-center gap-2 min-w-0">
                <img
                  v-if="group.channel.faceUrl"
                  :src="group.channel.faceUrl"
                  referrerpolicy="no-referrer"
                  class="h-6 w-6 rounded-full object-cover shrink-0"
                />
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <a
                      v-if="group.channel.uId"
                      :href="getChannelPageUrl(group.channel.uId)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="truncate text-xs font-semibold hover:text-primary"
                    >
                      {{ group.channel.uName }}
                    </a>
                    <span
                      v-if="!group.live.isFinish"
                      class="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500"
                    >
                      ● 直播中
                    </span>
                  </div>
                  <div class="truncate text-[11px] text-muted-foreground">
                    {{ group.live.title }} · {{ formatDateTime(group.live.startDate) }}
                  </div>
                </div>
              </div>

              <a
                :href="getLivePageUrl(group.live.liveId)"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition"
              >
                <span>本场详情</span>
                <ExternalLink class="h-3 w-3" />
              </a>
            </div>

            <!-- 弹幕明细列表 -->
            <div class="divide-y divide-border/40 px-3 py-1.5 max-h-72 overflow-y-auto">
              <div
                v-for="dm in group.danmakus"
                :key="dm.id"
                class="group flex items-start justify-between gap-2 py-1.5 text-xs"
              >
                <div class="flex items-start gap-2 min-w-0">
                  <span class="shrink-0 font-mono text-[11px] text-muted-foreground pt-0.5">
                    {{ formatTimeOnly(dm.sendDate) }}
                  </span>
                  <DanmakuContent :item="dm" />
                </div>

                <button
                  type="button"
                  class="opacity-0 group-hover:opacity-100 shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition"
                  title="查看当时前后45秒全场弹幕语境"
                  @click="openDanmakuContext(group.live.liveId, group.live.title, dm.sendDate)"
                >
                  上下文
                </button>
              </div>
            </div>
          </div>

          <p v-if="pageError" class="text-center text-xs text-destructive">{{ pageError }}</p>

          <HistoryPager
            v-if="totalPages > 1"
            class="pb-3"
            :page="currentPage"
            :total-pages="totalPages"
            :loading="loadingPage"
            @go="goToPage"
          />
        </template>
      </div>

      <!-- 弹幕前后文还原浮层 -->
      <div
        v-if="contextModal.open"
        class="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-md"
      >
        <div class="flex items-center justify-between border-b border-border px-4 py-3">
          <div class="min-w-0">
            <div class="text-xs font-semibold">弹幕前后文还原 (±45秒)</div>
            <div class="truncate text-[11px] text-muted-foreground">{{ contextModal.liveTitle }}</div>
          </div>
          <button
            type="button"
            class="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            @click="contextModal.open = false"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto px-4 py-2 divide-y divide-border/40">
          <div v-if="contextModal.loading" class="py-12 text-center text-xs text-muted-foreground">
            正在加载该时间点附近的全场弹幕...
          </div>
          <div
            v-else-if="contextModal.items.length === 0"
            class="py-12 text-center text-xs text-muted-foreground"
          >
            未找到附近时间点的其他弹幕
          </div>
          <div
            v-for="item in contextModal.items"
            :key="item.id"
            class="flex items-start gap-2 py-1.5 text-xs"
            :class="item.uId === uid ? 'bg-primary/10 -mx-2 px-2 rounded' : ''"
          >
            <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
              {{ formatTimeOnly(item.sendDate) }}
            </span>
            <button
              type="button"
              class="shrink-0 font-medium text-primary hover:underline"
              @click="
                contextModal.open = false;
                emit('selectUid', item.uId, item.uName);
              "
            >
              {{ item.uName || `UID:${item.uId}` }}:
            </button>
            <span class="break-all">{{ item.message }}</span>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>
