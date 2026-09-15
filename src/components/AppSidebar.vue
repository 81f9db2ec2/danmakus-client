<script setup lang="ts">
import {
  Activity,
  AppWindow,
  CircleUserRound,
  Globe,
  LayoutDashboard,
  LogOut,
  MonitorSmartphone,
  Radio,
  Settings,
  Tv2,
} from 'lucide-vue-next';
import { computed } from 'vue';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { allApiNodes, currentActiveOrigin } from '../services/apiNodes';
import type { UserInfo } from '../types/api';

defineProps<{
  currentPage: string;
  userInfo: UserInfo | null;
  isRunning: boolean;
  runtimeConnected: boolean;
  messageCount: number;
  connectedRoomsCount: number;
}>();

const emit = defineEmits<{
  (e: 'navigate', page: string): void;
  (e: 'logout'): void;
  (e: 'open-api-selector'): void;
}>();

const currentNodeInfo = computed(() =>
  allApiNodes.value.find((n) => n.origin === currentActiveOrigin.value)
);

const activeNodeHost = computed(() => {
  try {
    return new URL(currentActiveOrigin.value).host;
  } catch {
    return 'ukamnads.icu';
  }
});

const activeNodeDotClass = computed(() => {
  const status = currentNodeInfo.value?.status;
  if (status === 'ok') return 'bg-emerald-500';
  if (status === 'slow') return 'bg-amber-500';
  if (status === 'error') return 'bg-destructive';
  if (status === 'testing') return 'bg-sky-500 animate-ping';
  return 'bg-emerald-500';
});

const activeNodeLatencyText = computed(() => {
  const node = currentNodeInfo.value;
  if (!node) return '';
  if (node.status === 'testing') return '测速中';
  if (typeof node.latencyMs === 'number') return `${node.latencyMs}ms`;
  if (node.status === 'error') return '异常';
  return '';
});

const navItems = [
  { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard, tooltip: '查看核心运行状态和数据统计' },
  { key: 'recordings', label: '录制管理', icon: Radio, tooltip: '管理关注与录制的主播列表' },
  { key: 'settings', label: '核心配置', icon: Settings, tooltip: '配置连接参数、运行策略与分区过滤' },
  { key: 'app', label: '应用设置', icon: AppWindow, tooltip: '管理主题外观、托盘和启动项' },
  { key: 'bilibili', label: 'Bilibili', icon: Tv2, tooltip: '登录 Bilibili 账号同步 Cookie' },
  { key: 'account', label: '账户', icon: CircleUserRound, tooltip: '查看账户信息和贡献统计' },
];
</script>

<template>
  <aside class="flex h-screen w-56 flex-col border-r bg-sidebar text-sidebar-foreground">
    <!-- Logo -->
    <div class="px-4 py-5">
      <h1 class="text-base font-bold tracking-tight">Danmakus</h1>
      <p class="mt-0.5 text-xs text-muted-foreground">弹幕核心控制台</p>
    </div>

    <Separator />

    <!-- Navigation -->
    <nav class="flex-1 space-y-0.5 px-2 py-3">
      <button
        v-for="item in navItems"
        :key="item.key"
        :class="[
          'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          currentPage === item.key
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
        ]"
        :title="item.tooltip"
        @click="emit('navigate', item.key)"
      >
        <component :is="item.icon" class="h-4 w-4 shrink-0" />
        {{ item.label }}
      </button>
    </nav>

    <Separator />

    <!-- API Node Selector Widget -->
    <div class="px-2.5 py-2">
      <button
        type="button"
        class="flex w-full items-center justify-between gap-1.5 rounded-lg border border-border/60 bg-sidebar-accent/30 px-2.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        title="点击测速并切换后端 API 节点线路"
        @click="emit('open-api-selector')"
      >
        <div class="flex min-w-0 items-center gap-2">
          <Globe class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span :class="['h-1.5 w-1.5 shrink-0 rounded-full', activeNodeDotClass]" />
              <span class="truncate font-mono text-[11px] font-medium leading-none">{{ activeNodeHost }}</span>
            </div>
          </div>
        </div>
        <span v-if="activeNodeLatencyText" class="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {{ activeNodeLatencyText }}
        </span>
      </button>
    </div>

    <Separator />

    <!-- Core status -->
    <div class="space-y-2 px-4 py-3">
      <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">核心状态</p>
      <div class="space-y-1.5">
        <div class="flex items-center gap-2">
          <div :class="[
            'h-2 w-2 rounded-full',
            isRunning ? 'bg-emerald-500 animate-pulse-dot' : 'bg-muted-foreground/50'
          ]" />
          <span class="text-xs">{{ isRunning ? '运行中' : '已停止' }}</span>
        </div>
        <div class="flex items-center gap-2">
          <Activity class="h-3 w-3 text-muted-foreground" />
          <span class="text-xs text-muted-foreground">{{ messageCount.toLocaleString() }} 消息</span>
        </div>
        <div class="flex items-center gap-2">
          <MonitorSmartphone class="h-3 w-3 text-muted-foreground" />
          <span class="text-xs text-muted-foreground">{{ connectedRoomsCount }} 房间</span>
        </div>
        <Badge
          v-if="runtimeConnected"
          variant="outline"
          class="mt-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
        >
          服务已连接
        </Badge>
      </div>
    </div>

    <Separator />

    <!-- User -->
    <div class="px-3 py-3">
      <div v-if="userInfo" class="flex items-center gap-2.5">
        <Avatar class="h-8 w-8 border border-border">
          <AvatarFallback class="bg-primary/10 text-xs">
            {{ (userInfo.name || `用户${userInfo.id}`).charAt(0) || '?' }}
          </AvatarFallback>
        </Avatar>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">{{ userInfo.name || `用户${userInfo.id}` }}</p>
          <p class="text-[11px] text-muted-foreground">ID: {{ userInfo.id }}</p>
        </div>
        <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" title="退出登录" @click="emit('logout')">
          <LogOut class="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    </div>
  </aside>
</template>
