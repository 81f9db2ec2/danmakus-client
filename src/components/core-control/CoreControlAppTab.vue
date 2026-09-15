<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  AppWindow,
  Database,
  Download,
  Laptop,
  Loader2,
  Moon,
  Palette,
  RefreshCw,
  RotateCcw,
  Sun
} from 'lucide-vue-next';
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
import { Switch } from '@/components/ui/switch';
import type { LiveSessionOutboxDatabaseInfo } from '../../services/liveSessionOutbox';
import { applyThemeMode } from '../../services/localApp';
import type { LocalAppConfigDto, ThemeMode } from '../../types/api';

const props = defineProps<{
  localConfig: LocalAppConfigDto;
  isDesktopRuntime: boolean;
  isMacosDesktopRuntime: boolean;
  updaterSupported: boolean;
  appUpdateBusy: boolean;
  checkingAppUpdate: boolean;
  installingAppUpdate: boolean;
  availableUpdateVersion: string | null;
  databaseInfo: LiveSessionOutboxDatabaseInfo | null;
  loadingDatabaseInfo: boolean;
  rebuildingDatabase: boolean;
}>();

const emit = defineEmits<{
  (e: 'check-app-update'): void;
  (e: 'install-app-update'): void;
  (e: 'refresh-database-info'): void;
  (e: 'rebuild-database'): void;
}>();

const showRebuildDialog = ref(false);
const databaseBusy = computed(() => props.loadingDatabaseInfo || props.rebuildingDatabase);

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatTime = (timestamp: number | null): string => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return '—';
  }
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
};

const fileDetails = computed(() => {
  const info = props.databaseInfo;
  if (!info) return null;
  return {
    total: formatBytes(info.totalSizeBytes),
    main: formatBytes(info.databaseSizeBytes),
    wal: formatBytes(info.walSizeBytes)
  };
});

const setThemeMode = (mode: ThemeMode) => {
  props.localConfig.themeMode = mode;
  applyThemeMode(mode);
};

const confirmRebuildDatabase = () => {
  showRebuildDialog.value = false;
  emit('rebuild-database');
};
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">应用设置</h2>
        <p class="mt-0.5 text-sm text-muted-foreground">主题外观、桌面端行为与本地缓存数据库管理</p>
      </div>
    </div>

    <!-- Appearance Theme -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex items-center gap-2">
          <Palette class="h-4 w-4 text-primary" />
          <CardTitle class="text-sm">外观主题</CardTitle>
        </div>
        <CardDescription>选择客户端界面的配色方案，设置将保存在当前设备</CardDescription>
      </CardHeader>
      <CardContent>
        <div class="grid grid-cols-3 gap-2.5 sm:max-w-md">
          <button
            type="button"
            :class="[
              'flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-all',
              props.localConfig.themeMode === 'system'
                ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary'
                : 'bg-background/40 text-muted-foreground hover:bg-background/80 hover:text-foreground'
            ]"
            @click="setThemeMode('system')"
          >
            <Laptop class="h-4 w-4" />
            <span class="text-xs font-medium">跟随系统</span>
          </button>

          <button
            type="button"
            :class="[
              'flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-all',
              props.localConfig.themeMode === 'light'
                ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary'
                : 'bg-background/40 text-muted-foreground hover:bg-background/80 hover:text-foreground'
            ]"
            @click="setThemeMode('light')"
          >
            <Sun class="h-4 w-4" />
            <span class="text-xs font-medium">浅色模式</span>
          </button>

          <button
            type="button"
            :class="[
              'flex flex-col items-center gap-2 rounded-lg border p-3 text-center transition-all',
              props.localConfig.themeMode === 'dark'
                ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary'
                : 'bg-background/40 text-muted-foreground hover:bg-background/80 hover:text-foreground'
            ]"
            @click="setThemeMode('dark')"
          >
            <Moon class="h-4 w-4" />
            <span class="text-xs font-medium">深色模式</span>
          </button>
        </div>
      </CardContent>
    </Card>

    <!-- App Update -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Download class="h-4 w-4 text-primary" />
            <CardTitle class="text-sm">应用更新</CardTitle>
          </div>
          <Badge v-if="availableUpdateVersion" class="bg-sky-500/10 text-sky-600 dark:text-sky-400">
            发现新版本 v{{ availableUpdateVersion }}
          </Badge>
        </div>
        <CardDescription>检查并在线安装 Danmakus Client 最新客户端版本</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          :disabled="!updaterSupported || appUpdateBusy"
          :title="updaterSupported ? '检查是否有可用新版本' : '仅 Tauri 桌面端可检查更新'"
          @click="emit('check-app-update')"
        >
          <Loader2 v-if="checkingAppUpdate" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
          检查更新
        </Button>
        <Button
          v-if="availableUpdateVersion"
          variant="secondary"
          :disabled="appUpdateBusy"
          :title="`开始更新到 ${availableUpdateVersion} 并自动重启应用`"
          @click="emit('install-app-update')"
        >
          <Loader2 v-if="installingAppUpdate" class="h-4 w-4 animate-spin" />
          <Download v-else class="h-4 w-4" />
          立即更新到 v{{ availableUpdateVersion }}
        </Button>
      </CardContent>
    </Card>

    <!-- Local Database SQLite -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="flex items-center gap-2">
            <Database class="h-4 w-4 text-primary" />
            <div>
              <CardTitle class="text-sm">本地断网缓存库 (SQLite)</CardTitle>
              <CardDescription>用于网络波动时暂存弹幕上传队列并自动续传</CardDescription>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              :disabled="!isDesktopRuntime || databaseBusy"
              title="刷新本地数据库状态"
              @click="emit('refresh-database-info')"
            >
              <Loader2 v-if="loadingDatabaseInfo" class="h-3.5 w-3.5 animate-spin" />
              <RefreshCw v-else class="h-3.5 w-3.5" />
              刷新
            </Button>
            <Button
              variant="destructive"
              size="sm"
              :disabled="!isDesktopRuntime || databaseBusy"
              title="删除并重新创建本地 SQLite 缓存"
              @click="showRebuildDialog = true"
            >
              <Loader2 v-if="rebuildingDatabase" class="h-3.5 w-3.5 animate-spin" />
              <RotateCcw v-else class="h-3.5 w-3.5" />
              重建数据库
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div v-if="databaseInfo" class="grid gap-2.5 sm:grid-cols-2">
          <div class="rounded-lg border bg-background/40 p-2.5">
            <p class="text-[11px] font-medium text-muted-foreground">状态</p>
            <p class="mt-0.5 text-xs font-semibold">{{ databaseInfo.databaseExists ? '正常运行' : '未创建' }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 p-2.5">
            <p class="text-[11px] font-medium text-muted-foreground">待上传积压</p>
            <p class="mt-0.5 text-xs font-semibold tabular-nums">{{ databaseInfo.pendingCount.toLocaleString() }} 条</p>
          </div>
          <div class="rounded-lg border bg-background/40 p-2.5">
            <p class="text-[11px] font-medium text-muted-foreground">架构版本 (Schema / Expected)</p>
            <p class="mt-0.5 text-xs font-semibold tabular-nums">{{ databaseInfo.schemaVersion }} / {{ databaseInfo.expectedSchemaVersion }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 p-2.5">
            <p class="text-[11px] font-medium text-muted-foreground">模式与超时</p>
            <p class="mt-0.5 text-xs font-semibold tabular-nums">{{ databaseInfo.journalMode }} · {{ databaseInfo.busyTimeoutMs }} ms</p>
          </div>
          <div v-if="fileDetails" class="rounded-lg border bg-background/40 p-2.5 sm:col-span-2">
            <p class="text-[11px] font-medium text-muted-foreground">文件占用</p>
            <p class="mt-0.5 text-xs font-medium">
              总计 <strong class="text-foreground">{{ fileDetails.total }}</strong>
              <span class="text-muted-foreground">（主库文件 {{ fileDetails.main }}，WAL 缓存 {{ fileDetails.wal }}）</span>
            </p>
          </div>
          <div class="rounded-lg border bg-background/40 p-2.5 sm:col-span-2">
            <p class="text-[11px] font-medium text-muted-foreground">文件路径</p>
            <p class="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{{ databaseInfo.databasePath }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 p-2.5 sm:col-span-2">
            <p class="text-[11px] font-medium text-muted-foreground">最近写入时间</p>
            <p class="mt-0.5 text-xs font-medium">{{ formatTime(databaseInfo.lastModifiedMs) }}</p>
          </div>
        </div>
        <div v-else class="flex items-center gap-3 rounded-lg border bg-background/40 p-3 text-xs text-muted-foreground">
          <Database class="h-4 w-4 shrink-0" />
          <span>{{ isDesktopRuntime ? '暂无数据库信息' : '仅桌面端支持读取本地 SQLite 缓存' }}</span>
        </div>
      </CardContent>
    </Card>

    <!-- Desktop Behavior & System Tray -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex items-center gap-2">
          <AppWindow class="h-4 w-4 text-primary" />
          <CardTitle class="text-sm">启动与系统托盘</CardTitle>
        </div>
        <CardDescription>配置桌面端运行模式、窗口最小化行为及自启动</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3 sm:grid-cols-2">
        <div
          class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3.5 py-3"
          title="开机时自动启动应用"
        >
          <div>
            <p class="text-xs font-medium">开机自动启动</p>
            <p class="text-[11px] text-muted-foreground">系统开机登录后自动在后台运行</p>
          </div>
          <Switch v-model:model-value="props.localConfig.autoStart" :disabled="!isDesktopRuntime" />
        </div>

        <div
          class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3.5 py-3"
          title="应用启动后直接隐藏窗口到托盘"
        >
          <div>
            <p class="text-xs font-medium">启动时最小化到托盘</p>
            <p class="text-[11px] text-muted-foreground">启动后不弹窗，静默驻留系统托盘</p>
          </div>
          <Switch v-model:model-value="props.localConfig.startMinimized" :disabled="!isDesktopRuntime" />
        </div>

        <div
          class="sm:col-span-2 flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3.5 py-3"
          title="关闭窗口时隐藏到托盘，不退出进程"
        >
          <div>
            <p class="text-xs font-medium">关闭窗口时最小化到托盘</p>
            <p class="text-[11px] text-muted-foreground">点击窗口右上角关闭按钮时不退出进程</p>
          </div>
          <Switch v-model:model-value="props.localConfig.minimizeToTray" :disabled="!isDesktopRuntime" />
        </div>

        <div
          v-if="isMacosDesktopRuntime"
          class="sm:col-span-2 flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3.5 py-3"
          title="主窗口隐藏后同时隐藏 Dock 图标"
        >
          <div>
            <p class="text-xs font-medium">关闭窗口后隐藏 Dock 图标</p>
            <p class="text-[11px] text-muted-foreground">从菜单栏恢复主窗口后会重新显示 Dock 图标</p>
          </div>
          <Switch
            v-model:model-value="props.localConfig.hideDockIconWhenWindowHidden"
            :disabled="!localConfig.minimizeToTray"
          />
        </div>

        <div
          class="sm:col-span-2 flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3.5 py-3"
          title="应用启动完成后自动启动核心录制"
        >
          <div>
            <p class="text-xs font-medium">启动后自动开始录制</p>
            <p class="text-[11px] text-muted-foreground">登录成功并拉取配置后自动启动弹幕收集核心</p>
          </div>
          <Switch v-model:model-value="props.localConfig.autoStartRecording" :disabled="!isDesktopRuntime" />
        </div>
      </CardContent>
    </Card>

    <!-- Rebuild DB confirmation dialog -->
    <Dialog v-model:open="showRebuildDialog">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重建本地数据库</DialogTitle>
          <DialogDescription>
            此操作将清理本地未完成上传的暂存队列，并重新创建 SQLite 数据库文件。
          </DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" @click="showRebuildDialog = false">取消</Button>
          <Button variant="destructive" size="sm" :disabled="rebuildingDatabase" @click="confirmRebuildDatabase">
            <Loader2 v-if="rebuildingDatabase" class="h-4 w-4 animate-spin" />
            确认重建
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
