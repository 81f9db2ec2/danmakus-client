<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-vue-next';

const props = defineProps<{
  page: number;
  totalPages: number;
  loading: boolean;
}>();

const emit = defineEmits<{ go: [page: number] }>();

const jump = ref('');

/** 首尾页 + 当前页左右各一页，其余折叠为省略号，最多 7 项 */
const items = computed<Array<number | 'ellipsis'>>(() => {
  const { page, totalPages: total } = props;
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const start = Math.max(2, page - 1);
  const end = Math.min(total - 1, page + 1);
  return [
    1,
    ...(start > 2 ? ['ellipsis' as const] : []),
    ...Array.from({ length: end - start + 1 }, (_, i) => start + i),
    ...(end < total - 1 ? ['ellipsis' as const] : []),
    total,
  ];
});

function go(target: number) {
  const page = Math.min(props.totalPages, Math.max(1, Math.floor(target)));
  if (page !== props.page) emit('go', page);
}

function submitJump() {
  const target = Number(jump.value.trim());
  jump.value = '';
  if (Number.isInteger(target)) go(target);
}

const navButton =
  'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:text-primary disabled:opacity-40';
</script>

<template>
  <nav class="flex flex-wrap items-center justify-center gap-1 py-1 text-xs">
    <button type="button" aria-label="上一页" :disabled="page <= 1 || loading" :class="navButton" @click="go(page - 1)">
      <ChevronLeft class="h-3.5 w-3.5" />
    </button>
    <template v-for="(item, index) in items" :key="`${item}-${index}`">
      <span v-if="item === 'ellipsis'" class="px-0.5 text-muted-foreground">…</span>
      <button
        v-else
        type="button"
        :disabled="loading"
        class="inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1 font-medium transition disabled:opacity-40"
        :class="item === page ? 'bg-primary text-white' : 'border border-border text-foreground hover:text-primary'"
        @click="go(item)"
      >
        {{ item }}
      </button>
    </template>
    <button type="button" aria-label="下一页" :disabled="page >= totalPages || loading" :class="navButton" @click="go(page + 1)">
      <ChevronRight class="h-3.5 w-3.5" />
    </button>
    <form @submit.prevent="submitJump">
      <input
        v-model="jump"
        inputmode="numeric"
        placeholder="跳至"
        :title="`输入 1-${totalPages} 回车跳转`"
        class="h-6 w-11 rounded-md border border-border bg-transparent px-1 text-center text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
      />
    </form>
    <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin text-primary" />
  </nav>
</template>
