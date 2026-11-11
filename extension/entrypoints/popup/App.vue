<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Power,
  Radio,
  Search,
  Server,
  ShieldCheck,
  Tv,
  User,
} from 'lucide-vue-next';
import CardSettingsPanel from './CardSettingsPanel.vue';
import { getChannelPageUrl, getUserPageUrl } from '../../utils/api';
import { formatCompactNumber } from '../../utils/decoder';
import { clampMaxRooms, onStorageStateChanged } from '../../utils/storage';
import {
  DANMAKUS_SITE_ORIGIN,
  MAX_EXTENSION_ROOMS,
  type ExtensionMessage,
  type ExtensionRecorderConfig,
  type ExtensionRecorderState,
} from '../../utils/types';

const logoUrl = chrome.runtime.getURL('icon/128.png');
const config = ref<ExtensionRecorderConfig | null>(null);
const state = ref<ExtensionRecorderState | null>(null);
const showTokenEditor = ref(false);
const tokenDraft = ref('');
const quickSearchUid = ref('');
const saving = ref(false);

const roomCapacityOptions = [1, 2, 3, 4, 5];

const hasToken = computed(() => Boolean(config.value?.accountToken?.trim()));

const updateConfig = async (patch: Partial<ExtensionRecorderConfig>) => {
  saving.value = true;
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'UPDATE_RECORDER_CONFIG',
      patch,
    } satisfies ExtensionMessage)) as {
      ok: boolean;
      config?: ExtensionRecorderConfig;
      state?: ExtensionRecorderState;
    };
    if (res?.config) config.value = res.config;
    if (res?.state) state.value = res.state;
  } finally {
    saving.value = false;
  }
};

const handleToggleEnabled = async () => {
  if (!config.value) return;
  if (!hasToken.value) {
    showTokenEditor.value = true;
    return;
  }
  await updateConfig({ enabled: !config.value.enabled });
};

const handleSelectMaxRooms = async (count: number) => {
  await updateConfig({ maxRooms: clampMaxRooms(count) });
};

const handleSaveManualToken = async () => {
  await updateConfig({ accountToken: tokenDraft.value.trim() });
  showTokenEditor.value = false;
};

const handleQuickJumpUser = () => {
  const uid = Number(quickSearchUid.value.trim().replace(/^UID[:：\s]*/i, ''));
  if (Number.isFinite(uid) && uid > 0) {
    window.open(getUserPageUrl(Math.floor(uid)), '_blank', 'noopener,noreferrer');
    quickSearchUid.value = '';
  }
};

const handleQuickJumpChannel = () => {
  const uid = Number(quickSearchUid.value.trim().replace(/^UID[:：\s]*/i, ''));
  if (Number.isFinite(uid) && uid > 0) {
    window.open(getChannelPageUrl(Math.floor(uid)), '_blank', 'noopener,noreferrer');
    quickSearchUid.value = '';
  }
};

let stopWatch: (() => void) | null = null;

onMounted(async () => {
  const res = (await chrome.runtime.sendMessage({
    type: 'GET_RECORDER_STATE',
  } satisfies ExtensionMessage)) as {
    ok: boolean;
    config?: ExtensionRecorderConfig;
    state?: ExtensionRecorderState;
  };
  if (res?.config) {
    config.value = res.config;
    tokenDraft.value = res.config.accountToken;
  }
  if (res?.state) {
    state.value = res.state;
  }

  stopWatch = onStorageStateChanged((nextState, nextConfig) => {
    state.value = nextState;
    config.value = nextConfig;
  });
});

onUnmounted(() => {
  stopWatch?.();
});
</script>

<template>
  <div class="w-[360px] bg-background text-foreground p-4 space-y-3.5 select-none">
    <!-- 顶栏品牌与主站入口 -->
    <header class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <img :src="logoUrl" alt="" class="h-7 w-7 rounded-lg" />
        <div>
          <h1 class="text-sm font-semibold leading-none">Danmakus</h1>
        </div>
      </div>

      <a
        :href="DANMAKUS_SITE_ORIGIN"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/60 px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary transition"
      >
        <span>主站</span>
        <ExternalLink class="h-3 w-3" />
      </a>
    </header>

    <!-- 快捷 UID 直达查询 -->
    <form
      class="flex items-center gap-1.5 rounded-lg border border-border bg-card p-1.5"
      @submit.prevent="handleQuickJumpUser"
    >
      <div class="relative flex-1">
        <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          v-model="quickSearchUid"
          type="text"
          placeholder="输入 B站 UID 查发言或主播..."
          class="h-7 w-full bg-transparent pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      <button
        type="submit"
        class="rounded-md bg-primary/15 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/25 transition"
      >
        查观众
      </button>
      <button
        type="button"
        class="rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-accent transition"
        @click="handleQuickJumpChannel"
      >
        看主播
      </button>
    </form>

    <!-- 账号与 B站 Cookie 自动状态卡 -->
    <section class="rounded-xl border border-border bg-card p-3 space-y-2.5">
      <div class="flex items-center justify-between text-xs">
        <div class="flex items-center gap-2 min-w-0">
          <User class="h-3.5 w-3.5 text-primary shrink-0" />
          <span class="text-muted-foreground shrink-0">本站账号：</span>
          <span v-if="hasToken" class="truncate font-medium text-foreground">
            {{ state?.accountName || '已自动同步 Token' }}
          </span>
          <a
            v-else
            :href="`${DANMAKUS_SITE_ORIGIN}/account`"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary hover:underline truncate"
          >
            打开 danmakus.com 自动同步
          </a>
        </div>

        <button
          type="button"
          class="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground shrink-0"
          @click="
            tokenDraft = config?.accountToken ?? '';
            showTokenEditor = !showTokenEditor;
          "
        >
          <KeyRound class="h-3 w-3" />
          <span>{{ showTokenEditor ? '收起' : 'Token' }}</span>
        </button>
      </div>

      <!-- 手动编辑 Token 折叠框 -->
      <div v-if="showTokenEditor" class="flex items-center gap-1.5 pt-1">
        <input
          v-model="tokenDraft"
          type="password"
          placeholder="访问 danmakus.com 自动同步，也可手动粘贴"
          class="h-7 flex-1 rounded-md border border-input bg-muted/40 px-2 text-xs focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          class="h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground"
          @click="handleSaveManualToken"
        >
          保存
        </button>
      </div>

      <div class="flex items-center justify-between border-t border-border/60 pt-2 text-xs">
        <div class="flex items-center gap-2">
          <ShieldCheck
            class="h-3.5 w-3.5 shrink-0"
            :class="state?.cookieValid ? 'text-emerald-500' : 'text-muted-foreground'"
          />
          <span class="text-muted-foreground">B站登录态：</span>
          <span v-if="state?.biliUname" class="font-medium">
            {{ state.biliUname }} (免密直读)
          </span>
          <span v-else class="text-muted-foreground">浏览器登录B站即自动生效</span>
        </div>
      </div>
    </section>

    <!-- 后台兼职录制总控卡片 -->
    <section class="rounded-xl border border-border bg-card p-3 space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <div class="flex items-center gap-1.5 text-xs font-semibold">
            <Radio
              class="h-3.5 w-3.5"
              :class="state?.isRunning ? 'text-emerald-500 animate-pulse' : 'text-muted-foreground'"
            />
            <span>浏览器后台兼职录制</span>
          </div>
          <p class="mt-0.5 text-[11px] text-muted-foreground">
            即使关闭 B 站标签页，仍可在后台协助录制
          </p>
        </div>

        <button
          type="button"
          :disabled="saving"
          class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition"
          :class="
            config?.enabled
              ? 'bg-emerald-500 text-white hover:bg-emerald-600'
              : 'bg-secondary text-secondary-foreground hover:bg-accent'
          "
          @click="handleToggleEnabled"
        >
          <Power class="h-3.5 w-3.5" />
          <span>{{ config?.enabled ? '运行中' : '开启' }}</span>
        </button>
      </div>

      <!-- 最大录制场次选择 (1 ~ 5) -->
      <div class="flex items-center justify-between border-t border-border/60 pt-2.5 text-xs">
        <span class="text-muted-foreground">最大同时录制场次</span>
        <div class="flex items-center gap-1">
          <button
            v-for="num in roomCapacityOptions"
            :key="num"
            type="button"
            class="h-6 w-7 rounded-md border text-xs font-mono font-medium transition"
            :class="
              config?.maxRooms === num
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'
            "
            @click="handleSelectMaxRooms(num)"
          >
            {{ num }}
          </button>
        </div>
      </div>

      <!-- 实时统计数字 -->
      <div class="grid grid-cols-3 gap-2 pt-0.5 text-center">
        <div class="rounded-lg bg-muted/40 px-2 py-1.5">
          <div class="text-[10px] text-muted-foreground">当前持有</div>
          <div class="mt-0.5 font-mono text-xs font-semibold">
            {{ state?.connectedRooms?.length ?? 0 }} / {{ config?.maxRooms ?? 3 }}
          </div>
        </div>
        <div class="rounded-lg bg-muted/40 px-2 py-1.5">
          <div class="text-[10px] text-muted-foreground">本次已传弹幕</div>
          <div class="mt-0.5 font-mono text-xs font-semibold text-primary">
            {{ formatCompactNumber(state?.messageCount ?? 0) }}
          </div>
        </div>
        <div class="rounded-lg bg-muted/40 px-2 py-1.5">
          <div class="text-[10px] text-muted-foreground">今日贡献</div>
          <div class="mt-0.5 font-mono text-xs font-semibold text-emerald-500">
            {{ formatCompactNumber(state?.todayProvidedCount ?? 0) }}
          </div>
        </div>
      </div>

      <!-- 正在录制的房间列表 -->
      <div v-if="config?.enabled" class="space-y-1.5 pt-1">
        <div
          v-if="!state?.rooms || state.rooms.length === 0"
          class="rounded-lg border border-dashed border-border py-4 text-center text-[11px] text-muted-foreground"
        >
          {{ state?.runtimeConnected ? '已连接调度中心，等待分配在播房间...' : '正在连接 Danmakus 调度中心...' }}
        </div>

        <div
          v-for="room in state?.rooms"
          :key="room.roomId"
          class="flex items-center justify-between rounded-lg border border-border/70 bg-background/60 px-2.5 py-1.5 text-xs"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              :class="room.connected ? 'bg-emerald-500' : 'bg-amber-500'"
            />
            <div class="min-w-0">
              <div class="truncate font-medium">{{ room.uname }}</div>
              <div class="truncate text-[10px] text-muted-foreground">
                #{{ room.roomId }} {{ room.title ? `· ${room.title}` : '' }}
              </div>
            </div>
          </div>
          <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
            {{ formatCompactNumber(room.messageCount) }} 条
          </span>
        </div>
      </div>

      <div
        v-if="state?.lastError"
        class="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive break-all"
      >
        {{ state.lastError }}
      </div>
    </section>

    <CardSettingsPanel />
  </div>
</template>
