<script setup lang="ts">
import { computed } from 'vue';
import DanmakuContent from './DanmakuContent.vue';
import { getChannelPageUrl, getLivePageUrl } from '../utils/api';
import { formatCompactNumber, formatDateTime, formatTimeOnly } from '../utils/decoder';
import type { DecodedUserLiveGroup } from '../utils/types';

const props = defineProps<{ group: DecodedUserLiveGroup; showCover: boolean }>();

// B 站图床支持 @宽w 裁剪，缩略图只需 2x 尺寸
const coverUrl = computed(() => {
  const url = props.group.live.coverUrl;
  return url ? `${url.replace(/^http:/, 'https:')}@160w_90h_1c.webp` : null;
});

const duration = computed(() => {
  const { startDate, stopDate } = props.group.live;
  if (!stopDate) return null;
  const minutes = Math.round((stopDate - startDate) / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
});
</script>

<template>
  <article class="rounded-md bg-[var(--graph_bg_thin,rgba(0,0,0,0.03))] p-2">
    <header class="flex gap-2">
      <a
        v-if="showCover && coverUrl"
        :href="getLivePageUrl(group.live.liveId)"
        target="_blank"
        rel="noopener noreferrer"
        class="relative h-[45px] w-20 shrink-0 overflow-hidden rounded"
      >
        <img :src="coverUrl" alt="" referrerpolicy="no-referrer" loading="lazy" class="h-full w-full object-cover" />
        <span
          v-if="!group.live.isFinish"
          class="absolute left-0.5 top-0.5 rounded-sm bg-[var(--brand_pink,#ff6699)] px-1 text-[10px] leading-4 text-white"
        >
          直播中
        </span>
      </a>
      <div class="flex min-w-0 flex-1 flex-col justify-between">
        <a
          :href="getLivePageUrl(group.live.liveId)"
          target="_blank"
          rel="noopener noreferrer"
          class="truncate text-xs font-medium text-foreground transition hover:text-primary"
          :title="group.live.title"
        >
          {{ group.live.title }}
        </a>
        <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <a
            v-if="group.channel.uId"
            :href="getChannelPageUrl(group.channel.uId)"
            target="_blank"
            rel="noopener noreferrer"
            class="truncate transition hover:text-primary"
          >
            {{ group.channel.uName }}
          </a>
          <span class="shrink-0">{{ formatDateTime(group.live.startDate) }}</span>
          <span v-if="duration" class="shrink-0">{{ duration }}</span>
          <span v-if="!group.live.isFinish && !(showCover && coverUrl)" class="shrink-0 text-[var(--brand_pink,#ff6699)]">直播中</span>
        </div>
        <div class="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>弹幕 {{ formatCompactNumber(group.live.danmakusCount) }}</span>
          <span>看过 {{ formatCompactNumber(group.live.watchCount) }}</span>
          <span class="ml-auto">本场 {{ group.danmakus.length }} 条</span>
        </div>
      </div>
    </header>
    <div v-if="group.danmakus.length" class="mt-1.5 max-h-36 overflow-y-auto overscroll-contain pr-1">
      <div v-for="dm in group.danmakus" :key="dm.id" class="flex items-start gap-1.5 py-px text-xs">
        <span class="shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">{{ formatTimeOnly(dm.sendDate) }}</span>
        <DanmakuContent :item="dm" />
      </div>
    </div>
  </article>
</template>
