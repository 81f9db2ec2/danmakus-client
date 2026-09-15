<script setup lang="ts">
import { ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import {
  Copy,
  Globe,
  HelpCircle,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2
} from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  addCustomApiNode,
  allApiNodes,
  currentActiveOrigin,
  isAutoNodeMode,
  isTestingAll,
  pingAllApiNodes,
  pingApiNode,
  preferredOriginRef,
  removeCustomApiNode,
  setPreferredApiOrigin,
  type ApiNodeInfo
} from '../services/apiNodes';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const customInputUrl = ref('');
const isAddingCustom = ref(false);
const showProxyGuide = ref(false);
const activeGuideType = ref<'nginx' | 'caddy' | 'worker'>('nginx');

const proxyGuides = {
  nginx: `# Nginx 反向代理配置
server {
    listen 443 ssl http2;
    server_name proxy.example.com;

    # SSL 证书配置省略...

    location / {
        proxy_pass https://ukamnads.icu;
        proxy_set_header Host ukamnads.icu;
        proxy_ssl_server_name on;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}`,
  caddy: `# Caddy 反向代理配置
proxy.example.com {
    reverse_proxy https://ukamnads.icu {
        header_up Host ukamnads.icu
    }
}`,
  worker: `// Cloudflare Worker 反向代理配置
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = 'ukamnads.icu';
    return fetch(new Request(url, request));
  }
};`
};

const copyGuideCode = async (type: 'nginx' | 'caddy' | 'worker') => {
  try {
    await navigator.clipboard.writeText(proxyGuides[type]);
    toast.success('配置已复制到剪贴板');
  } catch {
    toast.error('复制失败，请手动选择复制');
  }
};

const handleOpenChange = (value: boolean) => {
  emit('update:open', value);
};

// 打开时若未测速，自动并发测一次
watch(
  () => props.open,
  (opened) => {
    if (opened) {
      const hasUntested = allApiNodes.value.some((n) => n.status === 'idle');
      if (hasUntested) {
        void pingAllApiNodes();
      }
    }
  }
);

const selectModeAuto = () => {
  setPreferredApiOrigin(null);
  toast.success('已切换为自动优选模式（将自动优先使用延迟最低的可用节点）');
};

const selectNodeManual = (origin: string) => {
  setPreferredApiOrigin(origin);
  toast.success(`已锁定首选节点：${origin}`);
};

const handleTestSingle = async (origin: string) => {
  await pingApiNode(origin);
};

const handleAddCustomNode = async () => {
  const url = customInputUrl.value.trim();
  if (!url) return;

  isAddingCustom.value = true;
  try {
    const success = await addCustomApiNode(url);
    if (success) {
      toast.success('已成功添加自定义节点并完成测速');
      customInputUrl.value = '';
    } else {
      toast.error('添加失败：地址无效或该节点已存在');
    }
  } catch (error) {
    toast.error('添加自定义节点出错');
  } finally {
    isAddingCustom.value = false;
  }
};

const handleRemoveCustom = (origin: string) => {
  removeCustomApiNode(origin);
  toast.success('已移除自定义节点');
};

const getLatencyBadgeClass = (node: ApiNodeInfo): string => {
  switch (node.status) {
    case 'testing':
      return 'border-sky-300 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    case 'ok':
      return 'border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 font-mono font-medium';
    case 'slow':
      return 'border-amber-300 bg-amber-500/10 text-amber-700 dark:text-amber-300 font-mono font-medium';
    case 'error':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    default:
      return 'border-muted-foreground/30 bg-muted/40 text-muted-foreground';
  }
};
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="sm:max-w-lg max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
      <!-- Fixed Header -->
      <DialogHeader class="p-5 pb-3.5 border-b border-border/40 shrink-0">
        <div class="flex items-center justify-between gap-3 pr-6">
          <div class="flex items-center gap-2">
            <Globe class="h-5 w-5 text-primary" />
            <DialogTitle>后端 API 节点与测速</DialogTitle>
          </div>
          <Button
            size="sm"
            variant="outline"
            class="h-7 px-2 text-xs"
            :disabled="isTestingAll"
            @click="pingAllApiNodes"
          >
            <Loader2 v-if="isTestingAll" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            全部测速
          </Button>
        </div>
        <DialogDescription>
          解决国内网络阻断或高延迟问题，自动选择或手动指定最稳定的 API 线路
        </DialogDescription>
      </DialogHeader>

      <!-- Scrollable Body Content -->
      <div class="flex-1 overflow-y-auto p-5 space-y-4 min-h-0">
        <!-- 模式切换选择 -->
        <div class="flex items-center justify-between rounded-lg border bg-background/50 p-2.5 text-xs">
          <div class="flex items-center gap-2">
            <Sparkles class="h-4 w-4 text-primary" />
            <div>
              <p class="font-semibold">选择模式</p>
              <p class="text-[11px] text-muted-foreground">
                {{ isAutoNodeMode ? '当前：自动优选（自动优先走测速最快节点）' : '当前：手动锁定固定节点' }}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-1">
            <Button
              size="sm"
              :variant="isAutoNodeMode ? 'default' : 'outline'"
              class="h-7 px-2.5 text-xs"
              @click="selectModeAuto"
            >
              自动优选
            </Button>
          </div>
        </div>

        <!-- 节点列表 -->
        <div class="space-y-2 max-h-52 overflow-y-auto pr-1">
          <div
            v-for="node in allApiNodes"
            :key="node.origin"
            :class="[
              'flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors',
              currentActiveOrigin === node.origin
                ? 'border-primary/50 bg-primary/5'
                : 'bg-card/60 hover:bg-card/90'
            ]"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-xs font-semibold">{{ node.label }}</span>
                <Badge v-if="currentActiveOrigin === node.origin" class="h-4 px-1 text-[9px]">生效中</Badge>
                <Badge v-if="preferredOriginRef === node.origin" variant="outline" class="h-4 px-1 text-[9px] border-primary text-primary">锁定首选</Badge>
              </div>
              <p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{{ node.origin }}</p>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <!-- 延迟徽章 -->
              <Badge
                variant="outline"
                :class="getLatencyBadgeClass(node)"
                class="h-6 cursor-pointer px-2 text-xs"
                :title="node.errorMessage || '点击重新测速此节点'"
                @click="handleTestSingle(node.origin)"
              >
                <Loader2 v-if="node.status === 'testing'" class="mr-1 h-3 w-3 animate-spin" />
                <span v-if="node.status === 'testing'">测速中</span>
                <span v-else-if="node.status === 'ok'">{{ node.latencyMs }} ms</span>
                <span v-else-if="node.status === 'slow'">{{ node.latencyMs }} ms</span>
                <span v-else-if="node.status === 'error'">不可达</span>
                <span v-else>未测速</span>
              </Badge>

              <!-- 操作按钮 -->
              <Button
                v-if="preferredOriginRef !== node.origin"
                size="sm"
                variant="outline"
                class="h-6 px-2 text-[11px]"
                title="将此节点设为首选（即使自动模式也将优先锁定此节点）"
                @click="selectNodeManual(node.origin)"
              >
                设为首选
              </Button>

              <!-- 删除自定义节点按钮 -->
              <Button
                v-if="!node.isBuiltin"
                size="icon"
                variant="ghost"
                class="h-6 w-6 text-muted-foreground hover:text-destructive"
                title="删除自定义节点"
                @click="handleRemoveCustom(node.origin)"
              >
                <Trash2 class="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>

        <Separator />

        <!-- 添加自定义节点 -->
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <label class="text-xs font-medium text-muted-foreground">添加自定义反代 / 镜像节点</label>
            <button
              type="button"
              class="flex items-center gap-1 text-[11px] text-primary hover:underline"
              @click="showProxyGuide = !showProxyGuide"
            >
              <HelpCircle class="h-3.5 w-3.5" />
              <span>{{ showProxyGuide ? '收起配置说明' : '反代配置说明' }}</span>
            </button>
          </div>

          <!-- 反代配置说明面板 -->
          <div
            v-if="showProxyGuide"
            class="rounded-lg border border-primary/20 bg-muted/40 p-3 space-y-2 text-xs"
          >
            <div class="flex items-center justify-between border-b pb-2">
              <div class="flex items-center gap-1.5 font-medium text-foreground">
                <span>反代指南</span>
                <span class="text-[10px] text-muted-foreground font-normal">（上游: https://ukamnads.icu）</span>
              </div>
              <!-- Tab 切换 -->
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  :class="[
                    'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                    activeGuideType === 'nginx' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  ]"
                  @click="activeGuideType = 'nginx'"
                >
                  Nginx
                </button>
                <button
                  type="button"
                  :class="[
                    'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                    activeGuideType === 'caddy' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  ]"
                  @click="activeGuideType = 'caddy'"
                >
                  Caddy
                </button>
                <button
                  type="button"
                  :class="[
                    'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                    activeGuideType === 'worker' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                  ]"
                  @click="activeGuideType = 'worker'"
                >
                  CF Worker
                </button>
              </div>
            </div>

            <div class="relative">
              <pre class="max-h-32 overflow-x-auto rounded bg-zinc-950 p-2 text-[10px] font-mono leading-relaxed text-zinc-100 dark:bg-black selection:bg-primary selection:text-primary-foreground">{{ proxyGuides[activeGuideType] }}</pre>
              <Button
                size="sm"
                variant="ghost"
                class="absolute right-1.5 top-1.5 h-6 px-1.5 text-[10px] text-zinc-400 hover:text-white hover:bg-zinc-800"
                title="复制配置"
                @click="copyGuideCode(activeGuideType)"
              >
                <Copy class="mr-1 h-3 w-3" />
                复制
              </Button>
            </div>

            <ul class="list-disc pl-4 space-y-0.5 text-[10px] text-muted-foreground">
              <li>反代目标上游必须为 <code class="font-mono text-foreground">https://ukamnads.icu</code> 或 <code class="font-mono text-foreground">https://api.ukamnads.icu</code>。</li>
              <li>必须开启 SNI 并设置 <code class="font-mono text-foreground">Host: ukamnads.icu</code>（Nginx 中为 <code class="font-mono text-foreground">proxy_ssl_server_name on;</code>）。</li>
              <li>必须配置 HTTPS，客户端录入时请输入包含 <code class="font-mono text-foreground">https://</code> 的完整协议域名。</li>
            </ul>
          </div>

          <div class="flex items-center gap-2">
            <Input
              v-model="customInputUrl"
              placeholder="https://my-proxy.example.com"
              class="h-8 text-xs font-mono"
              @keydown.enter="handleAddCustomNode"
            />
            <Button
              size="sm"
              class="h-8 shrink-0 text-xs"
              :disabled="isAddingCustom || !customInputUrl.trim()"
              @click="handleAddCustomNode"
            >
              <Loader2 v-if="isAddingCustom" class="h-3.5 w-3.5 animate-spin" />
              <Plus v-else class="h-3.5 w-3.5" />
              添加
            </Button>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
