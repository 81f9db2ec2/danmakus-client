<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { BilibiliAuthApi, type AuthStateSnapshot, type BilibiliQrLoginSession } from 'danmakus-core';
import QRCode from 'qrcode';
import { toast } from 'vue-sonner';
import { CheckCircle2, Cloud, Loader2, QrCode, RefreshCw, UserRound, ExternalLink } from 'lucide-vue-next';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import type { LocalAppConfigDto } from '../types/api';
import { biliCookie } from '../services/bilibili';
import { danmakuService } from '../services/DanmakuService';
import { fetchImpl } from '../services/fetchImpl';

const props = defineProps<{
  localConfig: LocalAppConfigDto;
  authState: AuthStateSnapshot;
  coreRunning: boolean;
}>();

const emit = defineEmits<{
  (e: 'sync-cookie-cloud'): void;
}>();

const authState = computed(() => props.authState);
const localState = computed(() => authState.value.local);
const cloudState = computed(() => authState.value.cookieCloud);
const isCoreRunning = computed(() => props.coreRunning);

// 当前生效账号（CookieCloud 优先，与核心连接逻辑一致）
const activeProfile = computed(() => cloudState.value.profile ?? localState.value.profile ?? null);
const localProfile = computed(() => localState.value.profile);
const isLocalLoggedIn = computed(() => localState.value.valid && localProfile.value !== null);

const activeSourceLabel = computed(() => {
  if (authState.value.activeSource === 'cookieCloud') return 'CookieCloud';
  if (authState.value.activeSource === 'local') return '本地扫码登录';
  return '无可用来源';
});

const activeSourceBadgeClass = computed(() => {
  if (authState.value.activeSource === 'cookieCloud') return 'border-sky-300 bg-sky-500/10 text-sky-700 dark:text-sky-300';
  if (authState.value.activeSource === 'local') return 'border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return 'border-amber-300 bg-amber-500/10 text-amber-700 dark:text-amber-300';
});

const overallStatusText = computed(() => {
  if (authState.value.phase === 'syncing') return '正在同步 / 校验 Cookie…';
  if (authState.value.hasUsableCookie) {
    return `${activeSourceLabel.value} 提供的 Cookie 当前有效，可用于连接弹幕服务`;
  }
  if (cloudState.value.configured && cloudState.value.lastError) {
    return `CookieCloud 同步失败：${cloudState.value.lastError}`;
  }
  if (cloudState.value.configured) return '已配置 CookieCloud，等待同步出可用 Cookie；也可扫码登录作为备用来源';
  return '当前没有可用 Cookie，请扫码登录或配置 CookieCloud';
});

// Cookie 状态由客户端在后台持续评估，无需启动核心
const lifecycleHint = computed(() =>
  isCoreRunning.value
    ? '核心运行中，连接弹幕服务时会实时使用下述生效来源的 Cookie。'
    : '提示：Cookie 状态由客户端在后台持续校验，无需启动核心即可查看；核心启动后会直接复用当前生效的来源。'
);

const cloudStatus = computed<{ text: string; class: string }>(() => {
  const state = cloudState.value;
  if (!state.configured) return { text: '未配置', class: 'border-muted-foreground/20 bg-muted/40 text-muted-foreground' };
  if (state.phase === 'syncing') return { text: '同步中', class: 'border-sky-300 bg-sky-500/10 text-sky-700 dark:text-sky-300' };
  if (state.valid) return { text: '有效', class: 'border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
  if (state.lastError) return { text: '失败', class: 'border-destructive/40 bg-destructive/10 text-destructive' };
  if (state.hasCookie) return { text: '待校验', class: 'border-amber-300 bg-amber-500/10 text-amber-700 dark:text-amber-300' };
  return { text: '等待同步', class: 'border-amber-300 bg-amber-500/10 text-amber-700 dark:text-amber-300' };
});

const localStatus = computed<{ text: string; class: string }>(() => {
  const state = localState.value;
  if (state.valid) return { text: '有效', class: 'border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
  if (state.lastError && state.hasCookie) return { text: '已失效', class: 'border-destructive/40 bg-destructive/10 text-destructive' };
  if (state.hasCookie) return { text: '待校验', class: 'border-amber-300 bg-amber-500/10 text-amber-700 dark:text-amber-300' };
  return { text: '未登录', class: 'border-muted-foreground/20 bg-muted/40 text-muted-foreground' };
});

const formatSyncTime = (value: number | null) => (value ? new Date(value).toLocaleString() : '—');

const assignCookieCloudText = (field: 'cookieCloudKey' | 'cookieCloudPassword', raw: string | number) => {
  props.localConfig[field] = String(raw).trim();
};

const assignCookieCloudHost = (raw: string | number) => {
  props.localConfig.cookieCloudHost = String(raw).trim().replace(/\/+$/, '');
};

const assignCookieRefreshInterval = (raw: string | number) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  props.localConfig.cookieRefreshInterval = Math.max(60, Math.floor(value));
};

const showLoginModal = ref(false);
const isQRCodeLogining = ref(false);
const loginUrl = ref('');
const loginKey = ref('');
const loginStatus = ref<'expired' | 'unknown' | 'scanned' | 'waiting' | 'confirmed' | undefined>(undefined);
const loginQrDataUrl = ref('');
const expiredTimer = ref<number>();
const timer = ref<number>();
const qrLoginApi = new BilibiliAuthApi(fetchImpl);
let qrLoginSession: BilibiliQrLoginSession | null = null;

const refreshAuth = (force = true) =>
  danmakuService.refreshAuthState({ force }).catch((error) => {
    console.error(error);
  });

const buildQrCodeDataUrl = async (url: string) => {
  loginQrDataUrl.value = await QRCode.toDataURL(url, { width: 220, margin: 1 });
};

const finishLogin = () => {
  if (timer.value) clearInterval(timer.value);
  if (expiredTimer.value) clearTimeout(expiredTimer.value);
  qrLoginSession = null;
  isQRCodeLogining.value = false;
  loginStatus.value = undefined;
  loginUrl.value = '';
  loginKey.value = '';
  loginQrDataUrl.value = '';
};

const startLogin = async () => {
  if (isQRCodeLogining.value) return;

  try {
    isQRCodeLogining.value = true;
    loginStatus.value = 'waiting';
    showLoginModal.value = true;

    qrLoginSession = await qrLoginApi.createQrLoginSession();
    const data = qrLoginSession.getInfo();
    loginUrl.value = data.url;
    loginKey.value = data.qrcodeKey;
    await buildQrCodeDataUrl(data.url);

    expiredTimer.value = window.setTimeout(() => {
      loginStatus.value = 'expired';
      if (timer.value) clearInterval(timer.value);
      isQRCodeLogining.value = false;
    }, 3 * 60 * 1000);

    timer.value = window.setInterval(async () => {
      try {
        if (!qrLoginSession) return;
        const login = await qrLoginSession.poll();
        loginStatus.value = login.status;

        if (login.status === 'confirmed') {
          biliCookie.setBiliCookie(login.cookie, login.refreshToken);
          toast.success('登录成功');
          finishLogin();
          await refreshAuth();
          showLoginModal.value = false;
        } else if (login.status === 'expired') {
          loginStatus.value = 'expired';
          if (timer.value) clearInterval(timer.value);
          isQRCodeLogining.value = false;
        }
      } catch (error) {
        console.error(error);
      }
    }, 2000);
  } catch (error) {
    console.error(error);
    toast.error(error instanceof Error ? error.message : '获取登录二维码失败');
    isQRCodeLogining.value = false;
    showLoginModal.value = false;
  }
};

const handleLocalLogout = () => {
  biliCookie.clear();
  void refreshAuth();
  toast.success('已登出本地 Bilibili 账号');
};

const handleDialogOpenChange = (open: boolean) => {
  showLoginModal.value = open;
  if (!open) finishLogin();
};

onBeforeUnmount(() => {
  finishLogin();
});
</script>

<template>
  <div class="w-full space-y-4">
    <!-- 统一鉴权状态 -->
    <Card class="bg-background/60">
      <CardHeader class="pb-3">
        <CardTitle class="text-base">账号与 Cookie 状态</CardTitle>
        <CardDescription>核心连接弹幕服务所使用的鉴权来源，CookieCloud 与本地扫码登录共用同一套状态</CardDescription>
      </CardHeader>

      <CardContent class="space-y-4">
        <div class="rounded-lg border bg-background/50 px-3 py-3 shadow-sm">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" :class="activeSourceBadgeClass">
              生效来源：{{ activeSourceLabel }}
            </Badge>
            <Badge v-if="authState.phase === 'syncing'" variant="outline" class="border-sky-300 bg-sky-500/10 text-sky-700 dark:text-sky-300">
              <Loader2 class="mr-1 h-3 w-3 animate-spin" />同步中
            </Badge>
          </div>
          <p class="mt-2 text-xs leading-5 text-muted-foreground">{{ overallStatusText }}</p>
          <p class="mt-1 text-[11px] leading-5 text-muted-foreground/80">{{ lifecycleHint }}</p>
        </div>

        <!-- 当前生效账号资料 -->
        <div v-if="activeProfile" class="flex items-center justify-between gap-3">
          <a
            :href="`https://space.bilibili.com/${activeProfile.uid}`"
            target="_blank"
            rel="noopener noreferrer"
            class="flex min-w-0 items-center gap-3 transition-opacity hover:opacity-80"
          >
            <Avatar class="h-10 w-10 border border-border">
              <AvatarImage :src="activeProfile.face || 'https://static.hdslb.com/images/member/noface.gif'" referrerpolicy="no-referrer" />
              <AvatarFallback><UserRound class="h-4 w-4 text-muted-foreground" /></AvatarFallback>
            </Avatar>
            <div class="min-w-0">
              <p class="flex items-center gap-1 truncate text-sm font-semibold">
                {{ activeProfile.uname || '已登录用户' }}
                <ExternalLink class="h-3 w-3 shrink-0" />
              </p>
              <p class="text-xs text-muted-foreground">UID: {{ activeProfile.uid }}</p>
            </div>
          </a>
          <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-xs">
            <Badge variant="outline">Lv.{{ activeProfile.level ?? 0 }}</Badge>
            <Badge v-if="(activeProfile.vipStatus ?? 0) > 0" variant="secondary">{{ activeProfile.vipLabel || '大会员' }}</Badge>
          </div>
        </div>

        <Separator v-if="activeProfile" />

        <!-- 两个来源的子状态 -->
        <div class="grid gap-2 sm:grid-cols-2">
          <div class="rounded-lg border bg-background/40 px-3 py-2.5">
            <div class="flex items-center justify-between gap-2">
              <span class="flex items-center gap-1.5 text-xs font-medium">
                <Cloud class="h-3.5 w-3.5 text-muted-foreground" />CookieCloud
              </span>
              <Badge variant="outline" :class="cloudStatus.class" class="text-[10px]">{{ cloudStatus.text }}</Badge>
            </div>
            <p class="mt-1.5 truncate text-[11px] text-muted-foreground">
              <template v-if="cloudState.profile">{{ cloudState.profile.uname }} · UID {{ cloudState.profile.uid }}</template>
              <template v-else-if="cloudState.lastError">{{ cloudState.lastError }}</template>
              <template v-else-if="!cloudState.configured">在下方填写 Key / 密码后启用</template>
              <template v-else>最近成功：{{ formatSyncTime(cloudState.lastSuccessAt) }}</template>
            </p>
          </div>

          <div class="rounded-lg border bg-background/40 px-3 py-2.5">
            <div class="flex items-center justify-between gap-2">
              <span class="flex items-center gap-1.5 text-xs font-medium">
                <QrCode class="h-3.5 w-3.5 text-muted-foreground" />本地扫码
              </span>
              <Badge variant="outline" :class="localStatus.class" class="text-[10px]">{{ localStatus.text }}</Badge>
            </div>
            <div class="mt-1.5 flex items-center justify-between gap-2">
              <p class="min-w-0 truncate text-[11px] text-muted-foreground">
                <template v-if="localProfile">{{ localProfile.uname }} · UID {{ localProfile.uid }}</template>
                <template v-else>为当前客户端补充一份本地 Cookie</template>
              </p>
              <Button v-if="isLocalLoggedIn" variant="ghost" size="sm" class="h-6 shrink-0 px-2 text-[11px]" @click="handleLocalLogout">登出</Button>
              <Button v-else variant="outline" size="sm" class="h-6 shrink-0 px-2 text-[11px]" @click="startLogin">扫码登录</Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- CookieCloud 配置 -->
    <Card class="bg-background/60">
      <CardHeader class="pb-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <CardTitle class="text-base">CookieCloud 配置</CardTitle>
            <CardDescription>仅保存在当前客户端本地，不会上传服务器；保存后客户端会自动同步并校验</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            :disabled="!cloudState.configured || cloudState.phase === 'syncing'"
            @click="emit('sync-cookie-cloud')"
          >
            <Loader2 v-if="cloudState.phase === 'syncing'" class="h-4 w-4 animate-spin" />
            <RefreshCw v-else class="h-4 w-4" />
            立即同步
          </Button>
        </div>
      </CardHeader>
      <CardContent class="space-y-3">
        <p v-if="cloudState.lastError" class="text-xs text-destructive">最近错误：{{ cloudState.lastError }}</p>
        <div class="space-y-1">
          <label class="text-xs font-medium text-muted-foreground">Host（可选，默认 cookie.danmakus.com）</label>
          <Input :model-value="props.localConfig.cookieCloudHost" placeholder="https://cookie.danmakus.com" @update:model-value="assignCookieCloudHost" />
        </div>
        <div class="grid gap-3 sm:grid-cols-3">
          <div class="space-y-1">
            <label class="text-xs font-medium text-muted-foreground">Key</label>
            <Input :model-value="props.localConfig.cookieCloudKey" placeholder="Key" @update:model-value="assignCookieCloudText('cookieCloudKey', $event)" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-medium text-muted-foreground">密码</label>
            <Input :model-value="props.localConfig.cookieCloudPassword" type="password" placeholder="密码" @update:model-value="assignCookieCloudText('cookieCloudPassword', $event)" />
          </div>
          <div class="space-y-1">
            <label class="text-xs font-medium text-muted-foreground">刷新间隔 (秒)</label>
            <Input :model-value="props.localConfig.cookieRefreshInterval" type="number" min="60" placeholder="3600" @update:model-value="assignCookieRefreshInterval" />
          </div>
        </div>
      </CardContent>
    </Card>

    <Dialog :open="showLoginModal" @update:open="handleDialogOpenChange">
      <DialogContent :show-close-button="false" class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bilibili 扫码登录</DialogTitle>
          <DialogDescription>请使用哔哩哔哩手机客户端扫码完成授权。</DialogDescription>
        </DialogHeader>

        <div class="flex min-h-[280px] flex-col items-center justify-center gap-4 py-2">
          <template v-if="loginStatus === 'expired'">
            <p class="text-sm text-destructive">二维码已过期，请重新获取。</p>
            <Button variant="outline" @click="startLogin">刷新二维码</Button>
          </template>

          <template v-else-if="loginQrDataUrl">
            <img :src="loginQrDataUrl" alt="Bilibili Login QRCode" class="h-[220px] w-[220px] rounded-md border bg-white p-2" />
            <p v-if="loginStatus === 'scanned'" class="flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 class="h-4 w-4" />
              扫码成功，请在手机上确认
            </p>
            <p v-else-if="loginStatus === 'waiting'" class="text-sm text-muted-foreground">
              请使用哔哩哔哩客户端扫码
            </p>
            <Loader2 v-else class="h-4 w-4 animate-spin text-muted-foreground" />
          </template>

          <Loader2 v-else class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>


