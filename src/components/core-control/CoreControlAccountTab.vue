<script setup lang="ts">
import {
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NIcon,
  NPopconfirm,
  NSpace,
  NTag
} from 'naive-ui';
import { GithubSquare, SignOutAlt, UserCircle } from '@vicons/fa';
import type { UserInfo } from '../../types/api';

defineProps<{
  userInfo: UserInfo | null;
}>();

const emit = defineEmits<{
  (e: 'logout'): void;
}>();

const getOAuthIcon = (provider: string) => {
  switch (provider.toLowerCase()) {
    case 'github':
      return GithubSquare;
    default:
      return null;
  }
};
</script>

<template>
  <div class="account-tab">
    <n-card>
      <n-space align="center" style="margin-bottom: 20px">
        <n-icon size="48" color="#ccc"><UserCircle /></n-icon>
        <div>
          <div style="font-size: 18px; font-weight: bold">{{ userInfo?.name || 'Unknown' }}</div>
          <div style="color: #666; font-size: 12px">ID: {{ userInfo?.id }}</div>
        </div>
      </n-space>

      <n-descriptions bordered>
        <n-descriptions-item label="OAuth 绑定">
          <n-space>
            <n-tag v-for="provider in userInfo?.bindedOAuth" :key="provider" type="info" size="small">
              <template #icon>
                <n-icon v-if="getOAuthIcon(provider)" :component="getOAuthIcon(provider)!" />
              </template>
              {{ provider }}
            </n-tag>
            <span v-if="!userInfo?.bindedOAuth.length">无</span>
          </n-space>
        </n-descriptions-item>
        <n-descriptions-item label="收到弹幕">
          {{ userInfo?.recievedDanmakusCount }}
        </n-descriptions-item>
      </n-descriptions>

      <n-divider />

      <n-popconfirm @positive-click="emit('logout')">
        <template #trigger>
          <n-button type="error" block ghost>
            <template #icon><n-icon><SignOutAlt /></n-icon></template>
            退出登录
          </n-button>
        </template>
        确定要清除 Token 并退出吗？
      </n-popconfirm>
    </n-card>
  </div>
</template>

<style scoped>
.account-tab {
  padding-top: 12px;
}
</style>
