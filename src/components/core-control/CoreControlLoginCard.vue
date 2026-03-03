<script setup lang="ts">
import { computed } from 'vue';
import { Loader2, ShieldCheck } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const props = defineProps<{
  token: string;
  loadingProfile: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:token', value: string): void;
  (e: 'apply-token'): void;
}>();

const tokenValue = computed({
  get: () => props.token,
  set: (value: string) => emit('update:token', value)
});
</script>

<template>
  <div class="grid min-h-[480px] place-items-center">
    <Card class="w-full max-w-md border-2 bg-gradient-to-br from-card/90 to-card/70 shadow-lg backdrop-blur">
      <CardHeader class="text-center">
        <div class="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <ShieldCheck class="h-7 w-7 text-primary" />
        </div>
        <CardTitle class="text-2xl">登录核心服务</CardTitle>
        <CardDescription>输入账号 Token 后加载核心状态与配置</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <div class="space-y-2">
          <label class="text-sm font-medium" for="core-token-input">账号 Token</label>
          <Input
            id="core-token-input"
            v-model="tokenValue"
            type="password"
            placeholder="请输入账号 Token"
            class="h-11"
            @keyup.enter="emit('apply-token')"
          />
        </div>

        <Button class="h-11 w-full" :disabled="loadingProfile" @click="emit('apply-token')">
          <Loader2 v-if="loadingProfile" class="h-4 w-4 animate-spin" />
          <span>{{ loadingProfile ? '连接中...' : '登录 / 连接' }}</span>
        </Button>
      </CardContent>
    </Card>
  </div>
</template>
