<script setup lang="ts">
import { computed, ref } from 'vue';
import { Database, Download, Loader2, RefreshCw, RotateCcw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import type { LiveSessionOutboxDatabaseInfo } from '../../services/liveSessionOutbox';
import type { LocalAppConfigDto } from '../../types/api';

const props = defineProps<{
  localConfig: LocalAppConfigDto;
  isDesktopRuntime: boolean;
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
    return '无';
  }
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
};

const schemaText = computed(() => {
  const info = props.databaseInfo;
  return info ? `${info.schemaVersion} / ${info.expectedSchemaVersion}` : '无';
});

const fileText = computed(() => {
  const info = props.databaseInfo;
  if (!info) {
    return '无';
  }
  return `${formatBytes(info.totalSizeBytes)}  主库 ${formatBytes(info.databaseSizeBytes)}, WAL ${formatBytes(info.walSizeBytes)}`;
});

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
        <p class="mt-0.5 text-sm text-muted-foreground">桌面端行为、托盘选项与更新管理</p>
      </div>
    </div>

    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <CardTitle class="text-sm">应用更新</CardTitle>
        <CardDescription>仅桌面端支持在线检查与安装更新</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap items-center gap-2">
        <Button variant="outline" :disabled="!updaterSupported || appUpdateBusy" :title="updaterSupported ? '检查是否有可用新版本' : '仅 Tauri 桌面端可检查更新'" @click="emit('check-app-update')">
          <Loader2 v-if="checkingAppUpdate" class="h-4 w-4 animate-spin" />
          <RefreshCw v-else class="h-4 w-4" />
          检查更新
        </Button>
        <Button v-if="availableUpdateVersion" variant="secondary" :disabled="appUpdateBusy" :title="`开始更新到 ${availableUpdateVersion} 并自动重启应用`" @click="emit('install-app-update')">
          <Loader2 v-if="installingAppUpdate" class="h-4 w-4 animate-spin" />
          <Download v-else class="h-4 w-4" />
          开始更新 {{ availableUpdateVersion }}
        </Button>
      </CardContent>
    </Card>

    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="text-sm">本地数据库</CardTitle>
            <CardDescription>弹幕上传队列的 SQLite 文件状态</CardDescription>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" :disabled="!isDesktopRuntime || databaseBusy" title="刷新本地数据库信息" @click="emit('refresh-database-info')">
              <Loader2 v-if="loadingDatabaseInfo" class="h-4 w-4 animate-spin" />
              <RefreshCw v-else class="h-4 w-4" />
              刷新
            </Button>
            <Button variant="destructive" size="sm" :disabled="!isDesktopRuntime || databaseBusy" title="删除并重新创建本地数据库" @click="showRebuildDialog = true">
              <Loader2 v-if="rebuildingDatabase" class="h-4 w-4 animate-spin" />
              <RotateCcw v-else class="h-4 w-4" />
              重建
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div v-if="databaseInfo" class="grid gap-3 sm:grid-cols-2">
          <div class="rounded-lg border bg-background/40 px-3 py-2.5">
            <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">状态</p>
            <p class="mt-1 text-sm font-medium">{{ databaseInfo.databaseExists ? '已初始化' : '未创建' }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 px-3 py-2.5">
            <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">待上传</p>
            <p class="mt-1 text-sm font-medium tabular-nums">{{ databaseInfo.pendingCount.toLocaleString() }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 px-3 py-2.5">
            <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Schema</p>
            <p class="mt-1 text-sm font-medium tabular-nums">{{ schemaText }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 px-3 py-2.5">
            <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Journal</p>
            <p class="mt-1 text-sm font-medium tabular-nums">{{ databaseInfo.journalMode }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 px-3 py-2.5">
            <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Busy Timeout</p>
            <p class="mt-1 text-sm font-medium tabular-nums">{{ databaseInfo.busyTimeoutMs.toLocaleString() }} ms</p>
          </div>
          <div class="rounded-lg border bg-background/40 px-3 py-2.5 sm:col-span-2">
            <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">文件大小</p>
            <p class="mt-1 text-sm font-medium">{{ fileText }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 px-3 py-2.5 sm:col-span-2">
            <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">路径</p>
            <p class="mt-1 break-all text-xs text-muted-foreground">{{ databaseInfo.databasePath }}</p>
          </div>
          <div class="rounded-lg border bg-background/40 px-3 py-2.5 sm:col-span-2">
            <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">更新时间</p>
            <p class="mt-1 text-sm font-medium">{{ formatTime(databaseInfo.lastModifiedMs) }}</p>
          </div>
        </div>
        <div v-else class="flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-3 text-sm text-muted-foreground">
          <Database class="h-4 w-4 shrink-0" />
          <span>{{ isDesktopRuntime ? '暂无数据库信息' : '仅桌面端可读取本地数据库' }}</span>
        </div>
      </CardContent>
    </Card>

    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <CardTitle class="text-sm">启动与托盘</CardTitle>
        <CardDescription>这些选项会保存到本地，仅影响当前设备</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3 sm:grid-cols-2">
        <div class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5" title="开机时自动启动应用">
          <div>
            <p class="text-xs font-medium">开机自动启动</p>
            <p class="text-[11px] text-muted-foreground">系统启动时自动运行</p>
          </div>
          <Switch v-model:model-value="props.localConfig.autoStart" :disabled="!isDesktopRuntime" />
        </div>

        <div class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5" title="应用启动后直接隐藏窗口到托盘">
          <div>
            <p class="text-xs font-medium">启动时最小化到托盘</p>
            <p class="text-[11px] text-muted-foreground">启动后不显示主窗口</p>
          </div>
          <Switch v-model:model-value="props.localConfig.startMinimized" :disabled="!isDesktopRuntime" />
        </div>

        <div class="sm:col-span-2 flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5" title="关闭窗口时隐藏到托盘，不退出进程">
          <div>
            <p class="text-xs font-medium">关闭窗口最小化到托盘</p>
            <p class="text-[11px] text-muted-foreground">开启后点关闭不会退出应用</p>
          </div>
          <Switch v-model:model-value="props.localConfig.minimizeToTray" :disabled="!isDesktopRuntime" />
        </div>

        <div class="sm:col-span-2 flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5" title="应用启动完成后自动启动核心录制">
          <div>
            <p class="text-xs font-medium">启动后自动开始录制</p>
            <p class="text-[11px] text-muted-foreground">登录成功后自动启动核心</p>
          </div>
          <Switch v-model:model-value="props.localConfig.autoStartRecording" :disabled="!isDesktopRuntime" />
        </div>
      </CardContent>
    </Card>

    <Dialog v-model:open="showRebuildDialog">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重建本地数据库</DialogTitle>
          <DialogDescription>会删除本地待上传弹幕记录并重新创建 SQLite 数据库。</DialogDescription>
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
