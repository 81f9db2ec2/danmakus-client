<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Check, Loader2, Search, UserRoundCheck } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import type { RecordingInfoDto } from '../../types/api';
import { fetchBiliFollowings, getActiveBiliUid, queryExistingChannels, type ImportableChannel } from '../../services/followImport';

const props = defineProps<{
  open: boolean;
  recordings: RecordingInfoDto[];
  importing: boolean;
  progress: { done: number; total: number };
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'import', uids: number[]): void;
}>();

const loading = ref(false);
const loadError = ref<string | null>(null);
const channels = ref<ImportableChannel[]>([]);
const selected = ref<Set<number>>(new Set());
const searchQuery = ref('');

const recordedUids = computed(
  () => new Set(props.recordings.map((item) => Number(item.channel?.uId)).filter((uid) => uid > 0))
);

const isRecorded = (uid: number) => recordedUids.value.has(uid);

const filteredChannels = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return channels.value;
  return channels.value.filter(
    (channel) => channel.uName.toLowerCase().includes(query) || String(channel.uid).includes(query)
  );
});

const selectableChannels = computed(() => channels.value.filter((channel) => !isRecorded(channel.uid)));
const selectedCount = computed(() => selected.value.size);
const allSelectableSelected = computed(
  () => selectableChannels.value.length > 0 && selectableChannels.value.every((channel) => selected.value.has(channel.uid))
);

const loadFollowings = async () => {
  loading.value = true;
  loadError.value = null;
  selected.value = new Set();
  channels.value = [];
  try {
    const uid = getActiveBiliUid();
    if (!uid) {
      loadError.value = '请先在「Bilibili 连接管理」中登录或配置 CookieCloud';
      return;
    }

    const followings = await fetchBiliFollowings();
    if (followings.length === 0) {
      loadError.value = '没有获取到关注的主播';
      return;
    }
    const existing = await queryExistingChannels(followings.map((item) => item.uid));
    const followIndex = new Map(followings.map((item, index) => [item.uid, index]));
    channels.value = existing.sort((a, b) => (followIndex.get(a.uid) ?? 0) - (followIndex.get(b.uid) ?? 0));
    if (channels.value.length === 0) {
      loadError.value = '你关注的主播暂无本站收录的';
    }
  } catch (error) {
    console.error(error);
    loadError.value = error instanceof Error ? error.message : '加载关注列表失败';
  } finally {
    loading.value = false;
  }
};

const toggle = (uid: number) => {
  if (isRecorded(uid)) return;
  const next = new Set(selected.value);
  if (next.has(uid)) {
    next.delete(uid);
  } else {
    next.add(uid);
  }
  selected.value = next;
};

const toggleSelectAll = () => {
  if (allSelectableSelected.value) {
    selected.value = new Set();
  } else {
    selected.value = new Set(selectableChannels.value.map((channel) => channel.uid));
  }
};

const handleImport = () => {
  if (selected.value.size === 0) {
    toast.warning('请先选择要添加的主播');
    return;
  }
  emit('import', Array.from(selected.value));
};

const handleOpenChange = (value: boolean) => {
  emit('update:open', value);
};

watch(
  () => props.open,
  (open) => {
    if (open) {
      searchQuery.value = '';
      void loadFollowings();
    }
  }
);

watch(
  () => props.importing,
  (importing, previous) => {
    if (previous && !importing) {
      emit('update:open', false);
    }
  }
);
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="flex max-h-[80vh] flex-col sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>从关注列表导入</DialogTitle>
        <DialogDescription>选择本站已收录的关注主播，添加到录制列表</DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="flex min-h-50 flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 class="h-6 w-6 animate-spin" />
        <p class="text-sm">正在加载关注列表…</p>
      </div>

      <div v-else-if="loadError" class="flex min-h-[200px] flex-col items-center justify-center gap-3 px-4 text-center">
        <p class="text-sm text-muted-foreground">{{ loadError }}</p>
        <Button variant="outline" size="sm" @click="loadFollowings">重试</Button>
      </div>

      <template v-else>
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="searchQuery" placeholder="搜索主播名或 UID" class="h-8 pl-8 text-xs" />
          </div>
          <Button variant="outline" size="sm" class="h-8 shrink-0 text-xs" :disabled="selectableChannels.length === 0"
            @click="toggleSelectAll">
            {{ allSelectableSelected ? '取消全选' : '全选可选' }}
          </Button>
        </div>

        <div class="-mr-1 flex-1 space-y-1.5 overflow-y-auto pr-1">
          <button v-for="channel in filteredChannels" :key="channel.uid" type="button" :disabled="isRecorded(channel.uid)"
            class="flex w-full items-center gap-2.5 rounded-lg border bg-background/40 p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55"
            :class="selected.has(channel.uid) ? 'border-primary bg-primary/5' : 'hover:bg-accent'"
            @click="toggle(channel.uid)">
            <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded border"
              :class="selected.has(channel.uid) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'">
              <Check v-if="selected.has(channel.uid)" class="h-3.5 w-3.5" />
              <UserRoundCheck v-else-if="isRecorded(channel.uid)" class="h-3 w-3 text-muted-foreground" />
            </div>
            <img v-if="channel.faceUrl" :src="channel.faceUrl" :alt="channel.uName" referrerpolicy="no-referrer"
              class="h-8 w-8 rounded-full object-cover" />
            <div v-else class="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">?</div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ channel.uName || channel.uid }}</p>
              <p class="text-[11px] text-muted-foreground">UID: {{ channel.uid }} · 房间: {{ channel.roomId }}</p>
            </div>
            <Badge v-if="isRecorded(channel.uid)" variant="outline" class="shrink-0 text-[10px]">已添加</Badge>
            <Badge v-else-if="channel.isLiving" variant="outline"
              class="shrink-0 border-emerald-300 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300">直播中</Badge>
          </button>
          <p v-if="filteredChannels.length === 0" class="py-8 text-center text-sm text-muted-foreground">没有匹配的主播</p>
        </div>
      </template>

      <div v-if="importing" class="space-y-1">
        <div class="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>正在添加录制主播…</span>
          <span class="tabular-nums">{{ progress.done }}/{{ progress.total }}</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-muted">
          <div class="h-full rounded-full bg-primary transition-all duration-300"
            :style="{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }" />
        </div>
      </div>

      <DialogFooter class="gap-2 sm:gap-2">
        <Button variant="outline" :disabled="importing" @click="handleOpenChange(false)">取消</Button>
        <Button :disabled="importing || selectedCount === 0" @click="handleImport">
          <Loader2 v-if="importing" class="h-4 w-4 animate-spin" />
          <template v-if="importing">添加中 ({{ progress.done }}/{{ progress.total }})</template>
          <template v-else>添加选中 ({{ selectedCount }})</template>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>


