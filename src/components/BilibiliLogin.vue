<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { toast } from 'vue-sonner';
import { CheckCircle2, Loader2, QrCode, UserRound, ExternalLink } from 'lucide-vue-next';
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
import { Separator } from '@/components/ui/separator';
import {
  biliNavProfileState,
  biliCookie,
  getLoginInfoAsync,
  getLoginUrlDataAsync,
  getNavProfileAsync,
  startNavProfileAutoRefresh,
  stopNavProfileAutoRefresh
} from '../services/bilibili';

const navProfile = computed(() => biliNavProfileState.profile);
const isLoggedIn = computed(() => navProfile.value !== null);
const showLoginModal = ref(false);

const isQRCodeLogining = ref(false);
const loginUrl = ref('');
const loginKey = ref('');
const loginStatus = ref<'expired' | 'unknown' | 'scanned' | 'waiting' | 'confirmed' | undefined>(undefined);
const loginQrDataUrl = ref('');
const expiredTimer = ref<number>();
const timer = ref<number>();

const checkStatus = async (force = false) => {
  try {
    await getNavProfileAsync({ force });
  } catch (error) {
    console.error(error);
  }
};

const buildQrCodeDataUrl = async (url: string) => {
  loginQrDataUrl.value = await QRCode.toDataURL(url, {
    width: 220,
    margin: 1
  });
};

const finishLogin = () => {
  if (timer.value) clearInterval(timer.value);
  if (expiredTimer.value) clearTimeout(expiredTimer.value);
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

    const data = await getLoginUrlDataAsync();
    loginUrl.value = data.url;
    loginKey.value = data.qrcode_key;
    await buildQrCodeDataUrl(data.url);

    expiredTimer.value = window.setTimeout(() => {
      loginStatus.value = 'expired';
      if (timer.value) clearInterval(timer.value);
      isQRCodeLogining.value = false;
    }, 3 * 60 * 1000);

    timer.value = window.setInterval(async () => {
      try {
        const login = await getLoginInfoAsync(loginKey.value);
        loginStatus.value = login.status;

        if (login.status === 'confirmed') {
          biliCookie.setBiliCookie(login.cookie, login.refresh_token);
          toast.success('登录成功');
          finishLogin();
          await checkStatus(true);
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

const handleLogout = () => {
  biliCookie.clear();
  toast.success('已登出 Bilibili');
};

const handleDialogOpenChange = (open: boolean) => {
  showLoginModal.value = open;
  if (!open) finishLogin();
};

onMounted(() => {
  startNavProfileAutoRefresh();
  void checkStatus();
});

onBeforeUnmount(() => {
  finishLogin();
  stopNavProfileAutoRefresh();
});
</script>

<template>
  <div class="w-full">
    <Card class="bg-background/60">
      <CardHeader class="pb-3">
        <CardTitle class="text-base">Bilibili 账号状态</CardTitle>
        <CardDescription>用于连接弹幕服务的 Cookie 凭据</CardDescription>
      </CardHeader>

      <CardContent class="space-y-4">
        <div v-if="isLoggedIn" class="space-y-4">
          <div class="flex items-center justify-between gap-3">
            <a
              :href="`https://space.bilibili.com/${navProfile?.uid}`"
              target="_blank"
              rel="noopener noreferrer"
              class="flex min-w-0 items-center gap-3 transition-opacity hover:opacity-80"
            >
              <Avatar class="h-10 w-10 border border-border">
                <AvatarImage
                  :src="navProfile?.face || 'https://static.hdslb.com/images/member/noface.gif'"
                  referrerpolicy="no-referrer"
                />
                <AvatarFallback>
                  <UserRound class="h-4 w-4 text-muted-foreground" />
                </AvatarFallback>
              </Avatar>

              <div class="min-w-0">
                <p class="flex items-center gap-1 truncate text-sm font-semibold">
                  {{ navProfile?.uname || '已登录用户' }}
                  <ExternalLink class="h-3 w-3 shrink-0" />
                </p>
                <p class="text-xs text-muted-foreground">UID: {{ navProfile?.uid }}</p>
              </div>
            </a>

            <Button variant="outline" size="sm" @click="handleLogout">登出</Button>
          </div>

          <Separator />

          <div class="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Lv.{{ navProfile?.level ?? 0 }}</Badge>
            <Badge variant="outline">硬币: {{ navProfile?.money ?? 0 }}</Badge>
            <Badge v-if="(navProfile?.vipStatus ?? 0) > 0" variant="secondary">{{ navProfile?.vipLabel || '大会员' }}</Badge>
            <Badge class="border-emerald-300 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" variant="outline">
              Cookie 有效
            </Badge>
          </div>
        </div>

        <div v-else class="space-y-3">
          <p class="text-sm text-muted-foreground">未登录，需要登录 Bilibili 账号以连接弹幕。</p>
          <Button class="w-full" @click="startLogin">
            <QrCode class="h-4 w-4" />
            扫码登录
          </Button>
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
