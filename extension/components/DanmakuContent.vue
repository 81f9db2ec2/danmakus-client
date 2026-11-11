<script setup lang="ts">
import { formatCurrency } from '../utils/decoder';
import { DanmakuType, type DecodedDanmakuItem } from '../utils/types';

defineProps<{ item: DecodedDanmakuItem }>();
</script>

<template>
  <span
    v-if="item.type === DanmakuType.SuperChat"
    class="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500"
  >
    SC {{ formatCurrency(item.price) }}
  </span>
  <span
    v-else-if="item.type === DanmakuType.Guard"
    class="shrink-0 rounded bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-purple-500"
  >
    上舰 {{ formatCurrency(item.price) }}
  </span>
  <span
    v-else-if="item.type === DanmakuType.Gift"
    class="shrink-0 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-pink-500"
  >
    投喂 {{ item.price ? formatCurrency(item.price) : '' }}
  </span>

  <div
    class="min-w-0 break-all leading-relaxed"
    :class="item.type === DanmakuType.Enter ? 'font-medium text-emerald-600' : 'text-foreground'"
  >
    <img
      v-if="item.roomEmojiUrl"
      :src="item.roomEmojiUrl"
      referrerpolicy="no-referrer"
      class="mr-1 inline-block h-5 w-auto align-middle"
    />
    <span>{{ item.message }}</span>
    <span v-if="item.type !== DanmakuType.Enter && item.count && item.count > 1" class="ml-1 text-muted-foreground">
      ×{{ item.count }}
    </span>
  </div>
</template>
