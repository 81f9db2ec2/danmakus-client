<script setup lang="ts">
import {
  Download,
  Loader2,
  RefreshCw,
} from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { LocalAppConfigDto } from '../../types/api';

const props = defineProps<{
  localConfig: LocalAppConfigDto;
  isDesktopRuntime: boolean;
  updaterSupported: boolean;
  appUpdateBusy: boolean;
  checkingAppUpdate: boolean;
  installingAppUpdate: boolean;
  availableUpdateVersion: string | null;
}>();

const emit = defineEmits<{
  (e: 'check-app-update'): void;
  (e: 'install-app-update'): void;
}>();
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
          :title="`安装已发现的新版本 ${availableUpdateVersion}`"
          @click="emit('install-app-update')"
        >
          <Loader2 v-if="installingAppUpdate" class="h-4 w-4 animate-spin" />
          <Download v-else class="h-4 w-4" />
          安装 {{ availableUpdateVersion }}
        </Button>
      </CardContent>
    </Card>

    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <CardTitle class="text-sm">启动与托盘</CardTitle>
        <CardDescription>这些选项会保存到本地，仅影响当前设备</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3 sm:grid-cols-2">
        <div
          class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5"
          title="开机时自动启动应用"
        >
          <div>
            <p class="text-xs font-medium">开机自动启动</p>
            <p class="text-[11px] text-muted-foreground">系统启动时自动运行</p>
          </div>
          <Switch
            v-model:model-value="props.localConfig.autoStart"
            :disabled="!isDesktopRuntime"
          />
        </div>

        <div
          class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5"
          title="应用启动后直接隐藏窗口到托盘"
        >
          <div>
            <p class="text-xs font-medium">启动时最小化到托盘</p>
            <p class="text-[11px] text-muted-foreground">启动后不显示主窗口</p>
          </div>
          <Switch
            v-model:model-value="props.localConfig.startMinimized"
            :disabled="!isDesktopRuntime"
          />
        </div>

        <div
          class="sm:col-span-2 flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5"
          title="关闭窗口时隐藏到托盘，不退出进程"
        >
          <div>
            <p class="text-xs font-medium">关闭窗口最小化到托盘</p>
            <p class="text-[11px] text-muted-foreground">开启后点关闭不会退出应用</p>
          </div>
          <Switch
            v-model:model-value="props.localConfig.minimizeToTray"
            :disabled="!isDesktopRuntime"
          />
        </div>

        <div
          class="sm:col-span-2 flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5"
          title="应用启动完成后自动启动核心录制"
        >
          <div>
            <p class="text-xs font-medium">启动后自动开始录制</p>
            <p class="text-[11px] text-muted-foreground">登录成功后自动启动核心</p>
          </div>
          <Switch
            v-model:model-value="props.localConfig.autoStartRecording"
            :disabled="!isDesktopRuntime"
          />
        </div>
      </CardContent>
    </Card>
  </div>
</template>
