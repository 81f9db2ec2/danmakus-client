<script setup lang="ts">
import { computed, ref, toRefs } from 'vue';
import { Download, Loader2, RefreshCw, Save, Plus, Trash2, X } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import type { CoreControlConfigDto, RecordingInfoDto } from '../../types/api';

const props = defineProps<{
  coreConfig: CoreControlConfigDto;
  availableAreas: Record<string, string[]>;
  recordings: RecordingInfoDto[];
  refreshingRecordings: boolean;
  addingRecording: boolean;
  removingRecordingUid: number | null;
  savingConfig: boolean;
  updaterSupported: boolean;
  checkingAppUpdate: boolean;
  installingAppUpdate: boolean;
  availableUpdateVersion: string | null;
}>();
const { coreConfig, availableAreas, recordings, refreshingRecordings, addingRecording, removingRecordingUid, savingConfig, updaterSupported, checkingAppUpdate, installingAppUpdate, availableUpdateVersion } = toRefs(props);

const newRecordingUid = ref('');
const areaSearchQuery = ref('');

const parentAreaOptions = computed(() =>
  Object.keys(availableAreas.value ?? {}).sort((a, b) => a.localeCompare(b))
);

const areaOptions = computed(() => {
  const map = availableAreas.value ?? {};
  const allAreas = Array.from(new Set(Object.values(map).flat())).sort((a, b) => a.localeCompare(b));
  const query = areaSearchQuery.value.trim().toLowerCase();
  return query ? allAreas.filter(a => a.toLowerCase().includes(query)) : allAreas;
});

const assignNumber = (field: keyof Pick<CoreControlConfigDto, 'maxConnections' | 'statusCheckInterval' | 'reconnectInterval' | 'cookieRefreshInterval'>, raw: string | number) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  coreConfig.value[field] = value as never;
};

const toggleArea = (area: string, field: 'allowedAreas' | 'allowedParentAreas') => {
  const list = coreConfig.value[field];
  const index = list.indexOf(area);
  if (index >= 0) {
    list.splice(index, 1);
  } else {
    list.push(area);
  }
};

const clearAreas = (field: 'allowedAreas' | 'allowedParentAreas') => {
  coreConfig.value[field].splice(0);
};

const recordingItems = computed(() =>
  [...recordings.value].sort((a, b) => {
    const liveA = a.channel?.isLiving ? 1 : 0;
    const liveB = b.channel?.isLiving ? 1 : 0;
    if (liveA !== liveB) {
      return liveB - liveA;
    }
    return Number(a.channel?.uId ?? 0) - Number(b.channel?.uId ?? 0);
  })
);

const submitAddRecording = () => {
  const uid = Number(newRecordingUid.value.trim());
  if (!Number.isFinite(uid) || uid <= 0) {
    return;
  }
  emit('add-recording', Math.floor(uid));
  newRecordingUid.value = '';
};

const emit = defineEmits<{
  (e: 'save-config'): void;
  (e: 'check-app-update'): void;
  (e: 'install-app-update'): void;
  (e: 'refresh-recordings'): void;
  (e: 'add-recording', uid: number): void;
  (e: 'remove-recording', uid: number): void;
}>();
</script>

<template>
  <div class="space-y-5">
    <!-- Page header with save -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-semibold tracking-tight">核心配置</h2>
        <p class="mt-0.5 text-sm text-muted-foreground">连接参数、分区过滤与录制管理</p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          :disabled="!updaterSupported || checkingAppUpdate || installingAppUpdate"
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
          :disabled="installingAppUpdate || checkingAppUpdate"
          :title="`安装已发现的新版本 ${availableUpdateVersion}`"
          @click="emit('install-app-update')"
        >
          <Loader2 v-if="installingAppUpdate" class="h-4 w-4 animate-spin" />
          <Download v-else class="h-4 w-4" />
          安装 {{ availableUpdateVersion }}
        </Button>
        <Button :disabled="savingConfig" @click="emit('save-config')">
          <Loader2 v-if="savingConfig" class="h-4 w-4 animate-spin" />
          <Save v-else class="h-4 w-4" />
          立即保存
        </Button>
      </div>
    </div>

    <!-- Connection settings -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <CardTitle class="text-sm">连接设置</CardTitle>
        <CardDescription>核心连接参数和运行策略</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">最大连接数</label>
          <Input
            :model-value="coreConfig.maxConnections"
            type="number"
            min="1"
            max="50"
            placeholder="5"
            title="同时连接的直播间数量，建议不超过 20 个"
            @update:model-value="assignNumber('maxConnections', $event)"
          />
          <p class="text-[11px] text-muted-foreground">同时连接的房间数量</p>
        </div>

        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">状态检查间隔 (秒)</label>
          <Input
            :model-value="coreConfig.statusCheckInterval"
            type="number"
            min="5"
            placeholder="30"
            title="定期检查连接状态的时间间隔"
            @update:model-value="assignNumber('statusCheckInterval', $event)"
          />
        </div>

        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">重连间隔 (毫秒)</label>
          <Input
            :model-value="coreConfig.reconnectInterval"
            type="number"
            min="1000"
            step="1000"
            placeholder="5000"
            title="连接断开后尝试重连的等待时间"
            @update:model-value="assignNumber('reconnectInterval', $event)"
          />
        </div>

        <div class="space-y-2.5">
          <div class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5" title="启用后连接断开时会自动尝试重连">
            <div>
              <p class="text-xs font-medium">自动重连</p>
              <p class="text-[11px] text-muted-foreground">连接中断后自动恢复</p>
            </div>
            <Switch v-model:model-value="coreConfig.autoReconnect" />
          </div>

          <div class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3 py-2.5" title="启用后服务器会根据分区过滤规则自动分配直播间">
            <div>
              <p class="text-xs font-medium">请求服务器分配</p>
              <p class="text-[11px] text-muted-foreground">由服务端协同房间分配</p>
            </div>
            <Switch v-model:model-value="coreConfig.requestServerRooms" />
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- Area filter with chips -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <CardTitle class="text-sm">分区过滤</CardTitle>
        <CardDescription>限制服务器分配的直播分区，不选则不限制</CardDescription>
      </CardHeader>
      <CardContent class="space-y-5">
        <!-- Parent areas -->
        <div class="space-y-2.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-medium text-muted-foreground">允许父分区</label>
            <Button
              v-if="coreConfig.allowedParentAreas.length > 0"
              variant="ghost"
              size="sm"
              class="h-6 px-2 text-[11px]"
              @click="clearAreas('allowedParentAreas')"
            >
              清空
            </Button>
          </div>
          <div v-if="coreConfig.allowedParentAreas.length > 0" class="flex flex-wrap gap-1.5">
            <Badge
              v-for="area in coreConfig.allowedParentAreas"
              :key="area"
              variant="default"
              class="cursor-pointer gap-1 pr-1 text-xs transition-colors"
              @click="toggleArea(area, 'allowedParentAreas')"
            >
              {{ area }}
              <X class="h-3 w-3" />
            </Badge>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <Badge
              v-for="area in parentAreaOptions.filter(a => !coreConfig.allowedParentAreas.includes(a))"
              :key="area"
              variant="outline"
              class="cursor-pointer text-xs transition-colors hover:bg-accent"
              @click="toggleArea(area, 'allowedParentAreas')"
            >
              {{ area }}
            </Badge>
            <p v-if="parentAreaOptions.length === 0" class="text-xs text-muted-foreground">无可用分区</p>
          </div>
        </div>

        <Separator />

        <!-- Sub areas -->
        <div class="space-y-2.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-medium text-muted-foreground">允许子分区</label>
            <Button
              v-if="coreConfig.allowedAreas.length > 0"
              variant="ghost"
              size="sm"
              class="h-6 px-2 text-[11px]"
              @click="clearAreas('allowedAreas')"
            >
              清空
            </Button>
          </div>
          <Input
            v-model="areaSearchQuery"
            placeholder="搜索子分区..."
            class="h-8 text-xs"
          />
          <div v-if="coreConfig.allowedAreas.length > 0" class="flex flex-wrap gap-1.5">
            <Badge
              v-for="area in coreConfig.allowedAreas"
              :key="area"
              variant="default"
              class="cursor-pointer gap-1 pr-1 text-xs transition-colors"
              @click="toggleArea(area, 'allowedAreas')"
            >
              {{ area }}
              <X class="h-3 w-3" />
            </Badge>
          </div>
          <div class="max-h-48 overflow-y-auto rounded-lg border bg-background/30 p-2">
            <div class="flex flex-wrap gap-1.5">
              <Badge
                v-for="area in areaOptions.filter(a => !coreConfig.allowedAreas.includes(a))"
                :key="area"
                variant="outline"
                class="cursor-pointer text-xs transition-colors hover:bg-accent"
                @click="toggleArea(area, 'allowedAreas')"
              >
                {{ area }}
              </Badge>
              <p v-if="areaOptions.length === 0" class="px-1 py-2 text-xs text-muted-foreground">无可用分区</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- CookieCloud settings -->
    <Collapsible>
      <Card class="bg-card/60">
        <CardHeader class="pb-3">
          <div class="flex items-center justify-between">
            <div>
              <CardTitle class="text-sm">CookieCloud 设置</CardTitle>
              <CardDescription>自动同步 Cookie（选填）</CardDescription>
            </div>
            <CollapsibleTrigger as-child>
              <Button variant="ghost" size="sm" class="text-xs">展开 / 收起</Button>
            </CollapsibleTrigger>
          </div>
        </CardHeader>
        <CollapsibleContent>
          <CardContent class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1.5 sm:col-span-2">
              <label class="text-xs font-medium text-muted-foreground">Host</label>
              <Input
                :model-value="coreConfig.cookieCloudHost ?? ''"
                placeholder="例如 http://localhost:8088"
                title="CookieCloud 服务器地址"
                @update:model-value="coreConfig.cookieCloudHost = String($event)"
              />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">Key</label>
              <Input
                :model-value="coreConfig.cookieCloudKey ?? ''"
                placeholder="输入 CookieCloud Key"
                title="CookieCloud 密钥"
                @update:model-value="coreConfig.cookieCloudKey = String($event)"
              />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">Password</label>
              <Input
                :model-value="coreConfig.cookieCloudPassword ?? ''"
                type="password"
                placeholder="输入 CookieCloud 密码"
                title="CookieCloud 加密密码"
                @update:model-value="coreConfig.cookieCloudPassword = String($event)"
              />
            </div>
            <div class="space-y-1.5 sm:col-span-2">
              <label class="text-xs font-medium text-muted-foreground">刷新间隔 (秒)</label>
              <Input
                :model-value="coreConfig.cookieRefreshInterval"
                type="number"
                min="60"
                placeholder="3600"
                title="自动同步 Cookie 的时间间隔"
                @update:model-value="assignNumber('cookieRefreshInterval', $event)"
              />
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>

    <!-- Recording manager -->
    <Card class="bg-card/60">
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <CardTitle class="text-sm">账号录制主播</CardTitle>
            <CardDescription>需要进行弹幕录制的主播列表</CardDescription>
          </div>
          <Button variant="outline" size="sm" :disabled="refreshingRecordings" @click="emit('refresh-recordings')">
            <RefreshCw :class="['h-3.5 w-3.5', refreshingRecordings && 'animate-spin']" />
            刷新
          </Button>
        </div>
      </CardHeader>

      <CardContent class="space-y-3">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div class="flex-1 space-y-1">
            <label class="text-[11px] text-muted-foreground">添加主播 UID</label>
            <Input
              v-model="newRecordingUid"
              type="number"
              min="1"
              placeholder="例如 1234567"
              title="输入 Bilibili 主播的 UID 进行录制"
              @keydown.enter.prevent="submitAddRecording"
            />
          </div>
          <Button :disabled="addingRecording" @click="submitAddRecording">
            <Loader2 v-if="addingRecording" class="h-3.5 w-3.5 animate-spin" />
            <Plus v-else class="h-3.5 w-3.5" />
            添加录制
          </Button>
        </div>

        <div
          v-for="item in recordingItems"
          :key="item.channel.uId"
          class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 p-3"
        >
          <a
            :href="`https://space.bilibili.com/${item.channel.uId}`"
            target="_blank"
            rel="noopener noreferrer"
            class="flex min-w-0 flex-1 items-center gap-2.5 transition-opacity hover:opacity-80"
          >
            <img
              v-if="item.channel.faceUrl"
              :src="item.channel.faceUrl"
              :alt="item.channel.uName"
              referrerpolicy="no-referrer"
              class="h-8 w-8 rounded-full object-cover"
            />
            <div
              v-else
              class="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground"
            >?</div>
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{{ item.channel.uName || item.channel.uId }}</p>
              <p class="text-[11px] text-muted-foreground">
                UID: {{ item.channel.uId }} · 房间: {{ item.channel.roomId }}
              </p>
              <p class="text-[11px] text-muted-foreground">
                贡献数据: {{ (item.providedDanmakuDataCount ?? 0).toLocaleString() }} · 其中消息: {{ (item.providedMessageCount ?? 0).toLocaleString() }}
              </p>
            </div>
          </a>
          <div class="flex items-center gap-2">
            <Badge
              variant="outline"
              :class="item.channel.isLiving ? 'border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : ''"
              class="text-[10px]"
            >
              {{ item.channel.isLiving ? '直播中' : '未开播' }}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8"
              :disabled="removingRecordingUid === item.channel.uId"
              @click="emit('remove-recording', item.channel.uId)"
            >
              <Loader2 v-if="removingRecordingUid === item.channel.uId" class="h-3.5 w-3.5 animate-spin" />
              <Trash2 v-else class="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        </div>

        <div v-if="recordingItems.length === 0" class="rounded-lg border border-dashed p-6 text-center">
          <p class="text-sm text-muted-foreground">当前账号还没有录制主播</p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
