<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ExternalLink, Loader2, RotateCw } from 'lucide-vue-next';
import CardLiveGroup from './CardLiveGroup.vue';
import HistoryPager from './HistoryPager.vue';
import {
  fetchCardBootstrap,
  fetchCardHistoryPage,
  getUserPageUrl,
  type UserBootstrap,
  type UserHistoryPage,
} from '../utils/api';
import type { CardSettings } from '../utils/card-settings';
import { DanmakuType } from '../utils/types';

const props = defineProps<{ uid: number; settings: CardSettings }>();

const logoUrl = chrome.runtime.getURL('icon/128.png');

// 跟随 B 站自身主题变量，卡片在亮 / 暗色下都与原生内容一致
const themeVars = {
  '--foreground': 'var(--text1, #18191c)',
  '--muted-foreground': 'var(--text3, #9499a0)',
  '--primary': 'var(--brand_blue, #00aeec)',
  '--border': 'var(--line_regular, #e3e5e7)',
  fontFamily: 'var(--bili-font-family, "PingFang SC", "HarmonyOS_Regular", "Microsoft YaHei", sans-serif)',
};

const requested = ref(false);
const boot = ref<UserBootstrap | null>(null);
const history = ref<UserHistoryPage | null>(null);
const channelUid = ref<number>();
const page = ref(1);
const loading = ref(false);
const error = ref<string | null>(null);

const totalPages = computed(() => Math.max(1, Math.ceil((history.value?.total ?? 0) / props.settings.pageSize)));
const formerNames = computed(() => boot.value?.historyUserNames.slice(1) ?? []);
const groups = computed(() =>
  (history.value?.groups ?? [])
    .map((group) =>
      props.settings.hideOnlyEnter
        ? { ...group, danmakus: group.danmakus.filter((item) => item.type !== DanmakuType.Enter) }
        : group,
    )
    .sort((a, b) => b.live.startDate - a.live.startDate),
);

async function load() {
  const { uid, settings } = props;
  const target = { uid, page: page.value, channel: channelUid.value };
  loading.value = true;
  error.value = null;
  try {
    if (!boot.value) {
      boot.value = await fetchCardBootstrap(uid, settings.pageSize, settings.hideOnlyEnter);
      if (uid === props.uid) history.value = boot.value.history;
    } else {
      const res = await fetchCardHistoryPage(uid, target.page, settings.pageSize, target.channel, settings.hideOnlyEnter);
      // 期间切了用户 / 页 / 主播，丢弃过期结果
      if (uid === props.uid && target.page === page.value && target.channel === channelUid.value) history.value = res;
    }
  } catch (err) {
    if (uid === props.uid) error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (uid === props.uid) loading.value = false;
  }
}

function start() {
  requested.value = true;
  void load();
}

function goPage(next: number) {
  page.value = next;
  void load();
}

function selectChannel(uid?: number) {
  channelUid.value = channelUid.value === uid ? undefined : uid;
  page.value = 1;
  // 回到全部时 bootstrap 已有第一页，直接复用
  if (!channelUid.value && boot.value) {
    history.value = boot.value.history;
    return;
  }
  void load();
}

watch(
  () => [props.uid, props.settings.pageSize, props.settings.hideOnlyEnter] as const,
  () => {
    boot.value = null;
    history.value = null;
    channelUid.value = undefined;
    page.value = 1;
    error.value = null;
    requested.value = props.settings.autoLoad;
    if (requested.value) void load();
  },
  { immediate: true },
);
</script>

<template>
  <section class="border-t px-5 pb-3 pt-2.5 text-xs" :style="themeVars">
    <header class="flex items-center gap-1.5">
      <img :src="logoUrl" alt="" class="h-3.5 w-3.5" />
      <span class="font-medium text-foreground">弹幕记录</span>
      <span v-if="history" class="text-muted-foreground">{{ history.total }} 场</span>
      <Loader2 v-if="loading" class="h-3 w-3 animate-spin text-muted-foreground" />
      <a
        :href="getUserPageUrl(uid)"
        target="_blank"
        rel="noopener noreferrer"
        title="在 Danmakus 查看"
        class="ml-auto text-muted-foreground transition hover:text-primary"
      >
        <ExternalLink class="h-3 w-3" />
      </a>
    </header>

    <button
      v-if="!requested"
      type="button"
      class="mt-2 w-full rounded-md border py-1.5 text-muted-foreground transition hover:border-primary hover:text-primary"
      @click="start"
    >
      查询弹幕记录
    </button>

    <template v-else>
      <p v-if="formerNames.length" class="mt-1 truncate text-[11px] text-muted-foreground" :title="formerNames.join(' / ')">
        曾用名 {{ formerNames.join(' / ') }}
      </p>

      <div v-if="boot && boot.watchedChannels.length > 1" class="mt-1.5 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
        <button
          v-for="ch in boot.watchedChannels"
          :key="ch.uId"
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px] transition"
          :class="channelUid === ch.uId ? 'border-primary text-primary' : 'text-muted-foreground hover:text-foreground'"
          @click="selectChannel(ch.uId)"
        >
          <img v-if="ch.faceUrl" :src="`${ch.faceUrl}@32w_32h.webp`" alt="" referrerpolicy="no-referrer" class="h-4 w-4 rounded-full" />
          <span class="max-w-20 truncate">{{ ch.uName }}</span>
          <span class="opacity-70">{{ ch.count }}</span>
        </button>
      </div>

      <p v-if="error" class="mt-1.5 flex items-center gap-1 text-destructive">
        <span class="truncate">{{ error }}</span>
        <button type="button" class="shrink-0" title="重试" @click="load"><RotateCw class="h-3 w-3" /></button>
      </p>
      <p v-else-if="history && groups.length === 0" class="mt-1.5 text-muted-foreground">暂无记录</p>
      <div
        v-else-if="history"
        class="mt-1.5 max-h-[min(420px,50vh)] space-y-1.5 overflow-y-auto overscroll-contain transition-opacity"
        :class="loading ? 'opacity-50' : ''"
      >
        <CardLiveGroup v-for="group in groups" :key="group.live.liveId" :group="group" :show-cover="settings.showCover" />
      </div>

      <HistoryPager v-if="totalPages > 1" class="mt-1" :page="page" :total-pages="totalPages" :loading="loading" @go="goPage" />
    </template>
  </section>
</template>
