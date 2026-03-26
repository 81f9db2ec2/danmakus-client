<script setup lang="ts">
import { computed, ref } from 'vue';
import { Github, LogOut, MessageSquare, Shield, ExternalLink } from 'lucide-vue-next';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
import type { RecordingInfoDto, UserInfo } from '../../types/api';

const props = defineProps<{
  userInfo: UserInfo | null;
  recordings: RecordingInfoDto[];
}>();

const emit = defineEmits<{
  (e: 'logout'): void;
}>();

const showLogoutDialog = ref(false);

const isGithubOAuth = (provider: string) => provider.toLowerCase() === 'github';

const totalProvidedDataCount = computed(() =>
  props.recordings.reduce((sum, item) => sum + Number(item.providedDanmakuDataCount ?? 0), 0)
);

const totalProvidedMessageCount = computed(() =>
  props.recordings.reduce((sum, item) => sum + Number(item.providedMessageCount ?? 0), 0)
);

const confirmLogout = () => {
  showLogoutDialog.value = false;
  emit('logout');
};
</script>

<template>
  <div class="space-y-5">
    <div>
      <h2 class="text-xl font-semibold tracking-tight">账户信息</h2>
      <p class="mt-0.5 text-sm text-muted-foreground">用户档案与登录管理</p>
    </div>

    <!-- Profile card -->
    <Card class="bg-card/60">
      <CardHeader>
        <div class="flex items-center gap-4">
            <Avatar class="h-14 w-14 border-2 border-border">
            <AvatarFallback class="bg-gradient-to-br from-primary/20 to-primary/5 text-lg">
              {{ (userInfo?.name || `用户${userInfo?.id ?? ''}`).charAt(0) || '?' }}
            </AvatarFallback>
          </Avatar>
          <div class="min-w-0 flex-1">
            <CardTitle class="truncate text-xl">{{ userInfo?.name || `用户${userInfo?.id ?? ''}` }}</CardTitle>
            <CardDescription>ID: {{ userInfo?.id }}</CardDescription>
          </div>
          <Button variant="outline" size="sm" as-child>
            <a href="https://danmakus.com/account" target="_blank" rel="noopener noreferrer" class="gap-1.5">
              <ExternalLink class="h-3.5 w-3.5" />
              网站账户
            </a>
          </Button>
        </div>
      </CardHeader>
    </Card>

    <!-- Stats grid -->
    <div class="grid gap-3 sm:grid-cols-2">
      <Card class="bg-card/60" title="已绑定的第三方登录方式">
        <CardContent class="p-4">
          <div class="flex items-center gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Shield class="h-5 w-5 text-primary" />
            </div>
            <div>
              <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">OAuth 绑定</p>
              <div class="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge v-for="provider in userInfo?.bindedOAuth" :key="provider" variant="secondary" class="gap-1 text-xs">
                  <Github v-if="isGithubOAuth(provider)" class="h-3 w-3" />
                  {{ provider }}
                </Badge>
                <span v-if="!userInfo?.bindedOAuth.length" class="text-sm text-muted-foreground">无</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card class="bg-card/60" title="您为直播间提供的弹幕数据统计">
        <CardContent class="p-4">
          <div class="flex items-center gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-chart-2/10">
              <MessageSquare class="h-5 w-5 text-chart-2" />
            </div>
            <div>
              <p class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">房间贡献</p>
              <p class="mt-0.5 text-xl font-bold tabular-nums">{{ totalProvidedDataCount.toLocaleString() }}</p>
              <p class="text-[11px] text-muted-foreground">消息: {{ totalProvidedMessageCount.toLocaleString() }}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <Separator />

    <!-- Logout -->
    <Button variant="destructive" class="w-full" @click="showLogoutDialog = true">
      <LogOut class="h-4 w-4" />
      退出登录
    </Button>

    <!-- Logout confirmation dialog -->
    <Dialog v-model:open="showLogoutDialog">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>确认退出</DialogTitle>
          <DialogDescription>退出将清除 Token 并停止正在运行的核心服务。</DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" @click="showLogoutDialog = false">取消</Button>
          <Button variant="destructive" size="sm" @click="confirmLogout">确认退出</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
