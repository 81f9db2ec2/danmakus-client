<script setup lang="ts">
import { computed, ref, toRefs } from 'vue';
import { Info, Layers, Loader2, Network, Save, X } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import type { CoreControlConfigDto, LocalAppConfigDto } from '../../types/api';

const props = defineProps<{
  coreConfig: CoreControlConfigDto;
  localConfig: LocalAppConfigDto;
  availableAreas: Record<string, string[]>;
  savingConfig: boolean;
}>();

const { coreConfig, availableAreas, savingConfig } = toRefs(props);

const areaSearchQuery = ref('');

const parentAreaOptions = computed(() =>
  Object.keys(availableAreas.value ?? {}).sort((a, b) => a.localeCompare(b))
);

const areaOptions = computed(() => {
  const map = availableAreas.value ?? {};
  const allAreas = Array.from(new Set(Object.values(map).flat())).sort((a, b) => a.localeCompare(b));
  const query = areaSearchQuery.value.trim().toLowerCase();
  return query ? allAreas.filter((a) => a.toLowerCase().includes(query)) : allAreas;
});

const assignNumber = (
  field: keyof Pick<CoreControlConfigDto, 'maxConnections' | 'statusCheckInterval' | 'reconnectInterval'>,
  raw: string | number
) => {
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

const normalizeUidList = (value: string | number[] | null | undefined): number[] => {
  const source = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(/[\s,，]+/)
        .filter(Boolean);

  return Array.from(
    new Set(
      source
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0)
        .map((item) => Math.floor(item))
    )
  ).sort((left, right) => left - right);
};

const formatUidList = (value: number[] | null | undefined): string =>
  normalizeUidList(value).join('\n');

const assignExcludedServerRoomUserIds = (event: Event) => {
  const target = event.target as HTMLTextAreaElement | null;
  if (!target) return;

  const next = normalizeUidList(target.value);
  coreConfig.value.excludedServerRoomUserIds = next;
  target.value = formatUidList(next);
};

const assignCapacityOverride = (raw: string | number) => {
  const text = String(raw).trim();
  if (!text) {
    props.localConfig.capacityOverride = null;
    return;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return;
  }
  props.localConfig.capacityOverride = Math.min(100, Math.max(1, Math.floor(value)));
};

const emit = defineEmits<{
  (e: 'save-config'): void;
}>();
</script>

<template>
  <div class="space-y-5">
    <TooltipProvider>
      <!-- Page header with save -->
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-xl font-semibold tracking-tight">核心配置</h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            连接参数、分配策略与直播分区白名单过滤
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Button :disabled="savingConfig" @click="emit('save-config')">
            <Loader2 v-if="savingConfig" class="h-4 w-4 animate-spin" />
            <Save v-else class="h-4 w-4" />
            立即保存配置
          </Button>
        </div>
      </div>

      <!-- Connection settings -->
      <Card class="bg-card/60">
        <CardHeader class="pb-3">
          <div class="flex items-center gap-2">
            <Network class="h-4 w-4 text-primary" />
            <CardTitle class="text-sm">连接与分配策略</CardTitle>
          </div>
          <CardDescription>配置客户端与弹幕服务器连接参数、重连机制与容量策略</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <label class="text-xs font-medium text-muted-foreground">全局最大连接数</label>
                <span class="text-[11px] text-muted-foreground">推荐 5~30</span>
              </div>
              <Input
                :model-value="coreConfig.maxConnections"
                type="number"
                min="1"
                max="100"
                placeholder="15"
                title="同时连接的直播间数量上限（1-100）"
                @update:model-value="assignNumber('maxConnections', $event)"
              />
              <p class="text-[11px] text-muted-foreground">账号下所有客户端默认遵循此连接数上限</p>
            </div>

            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <label class="text-xs font-medium text-muted-foreground">本机容量覆盖 (可选)</label>
                <span class="text-[11px] text-muted-foreground">仅限当前设备</span>
              </div>
              <Input
                :model-value="props.localConfig.capacityOverride ?? ''"
                type="number"
                min="1"
                max="100"
                placeholder="留空则使用全局设置"
                @update:model-value="assignCapacityOverride"
              />
              <p class="text-[11px] text-muted-foreground">仅保存在本地设备，用于覆盖全局连接上限</p>
            </div>

            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">状态检查间隔 (秒)</label>
              <Input
                :model-value="coreConfig.statusCheckInterval"
                type="number"
                min="5"
                placeholder="30"
                title="定期检查主播开播与连接状态的时间间隔"
                @update:model-value="assignNumber('statusCheckInterval', $event)"
              />
              <p class="text-[11px] text-muted-foreground">轮询直播间开播态的周期</p>
            </div>

            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">重连重试间隔 (毫秒)</label>
              <Input
                :model-value="coreConfig.reconnectInterval"
                type="number"
                min="1000"
                step="1000"
                placeholder="5000"
                title="连接断开后尝试重连的等待时间"
                @update:model-value="assignNumber('reconnectInterval', $event)"
              />
              <p class="text-[11px] text-muted-foreground">WebSocket 异常断开后的退避重连周期</p>
            </div>
          </div>

          <Separator />

          <div class="grid gap-3 sm:grid-cols-2">
            <div
              class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3.5 py-3"
              title="启用后连接中断时会自动尝试恢复"
            >
              <div>
                <p class="text-xs font-medium">自动断线重连</p>
                <p class="text-[11px] text-muted-foreground">网络异常断开后自动尝试恢复</p>
              </div>
              <Switch v-model:model-value="coreConfig.autoReconnect" />
            </div>

            <div class="flex items-center justify-between gap-3 rounded-lg border bg-background/40 px-3.5 py-3">
              <div class="flex items-center gap-1.5">
                <div>
                  <div class="flex items-center gap-1">
                    <p class="text-xs font-medium">允许本站补充分配主播</p>
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <Info class="h-3 w-3 cursor-help text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent class="max-w-xs">
                        <p>启用后，当你的录制配额有空闲时，本站会自动分配热门直播间供你录制贡献数据。</p>
                        <br />
                        <p>这绝不会挤占你手动添加的主播，他们开播时会自动抢占并优先录制。</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <p class="text-[11px] text-muted-foreground">仅在空闲连接位时补充分配大家查询的主播</p>
                </div>
              </div>
              <Switch v-model:model-value="coreConfig.requestServerRooms" />
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Area filter with chips -->
      <Card class="bg-card/60">
        <CardHeader class="pb-3">
          <div class="flex items-center gap-2">
            <Layers class="h-4 w-4 text-primary" />
            <div class="flex items-center gap-1.5">
              <CardTitle class="text-sm">分区过滤白名单</CardTitle>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Info class="h-3.5 w-3.5 cursor-help text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent class="max-w-xs">
                  <p>设置后，本站只会分配你勾选的分区下的直播间，避免录制不感兴趣的内容。</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <CardDescription>
            限制本站自动补充分配的直播分区；不影响你手动在「录制管理」中添加的主播
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-5">
          <!-- Parent areas -->
          <div class="space-y-2.5">
            <div class="flex items-center justify-between">
              <label class="text-xs font-medium text-muted-foreground">允许的父分区</label>
              <Button
                v-if="coreConfig.allowedParentAreas.length > 0"
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-[11px]"
                @click="clearAreas('allowedParentAreas')"
              >
                清空已选
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
                v-for="area in parentAreaOptions.filter((a) => !coreConfig.allowedParentAreas.includes(a))"
                :key="area"
                variant="outline"
                class="cursor-pointer text-xs transition-colors hover:bg-accent"
                @click="toggleArea(area, 'allowedParentAreas')"
              >
                + {{ area }}
              </Badge>
              <p v-if="parentAreaOptions.length === 0" class="text-xs text-muted-foreground">无可用分区</p>
            </div>
          </div>

          <Separator />

          <!-- Sub areas -->
          <div class="space-y-2.5">
            <div class="flex items-center justify-between">
              <label class="text-xs font-medium text-muted-foreground">允许的子分区</label>
              <Button
                v-if="coreConfig.allowedAreas.length > 0"
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-[11px]"
                @click="clearAreas('allowedAreas')"
              >
                清空已选
              </Button>
            </div>
            <Input v-model="areaSearchQuery" placeholder="搜索子分区..." class="h-8 text-xs" />
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
                  v-for="area in areaOptions.filter((a) => !coreConfig.allowedAreas.includes(a))"
                  :key="area"
                  variant="outline"
                  class="cursor-pointer text-xs transition-colors hover:bg-accent"
                  @click="toggleArea(area, 'allowedAreas')"
                >
                  + {{ area }}
                </Badge>
                <p v-if="areaOptions.length === 0" class="px-1 py-2 text-xs text-muted-foreground">无可用子分区</p>
              </div>
            </div>
          </div>

          <Separator />

          <!-- Excluded UIDs -->
          <div class="space-y-2.5">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1.5">
                <label class="text-xs font-medium text-muted-foreground">不补充分配的主播 UID 黑名单</label>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Info class="h-3.5 w-3.5 cursor-help text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent class="max-w-xs">
                    <p>填写的 UID 只会阻止本站给你自动补充分配这些主播，不影响你在「录制管理」中手动添加的主播。</p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <span class="text-[11px] text-muted-foreground">
                已排除 {{ (coreConfig.excludedServerRoomUserIds || []).length }} 个 UID
              </span>
            </div>
            <textarea
              :value="formatUidList(coreConfig.excludedServerRoomUserIds)"
              rows="3"
              class="flex min-h-[80px] w-full rounded-md border border-input bg-background/30 px-3 py-2 text-xs font-mono shadow-xs outline-hidden placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="每行一个 UID，也支持逗号或空格分隔"
              @change="assignExcludedServerRoomUserIds"
            />
            <p class="text-[11px] text-muted-foreground">仅影响本站补充分配，不影响账号自身录制主播</p>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  </div>
</template>
