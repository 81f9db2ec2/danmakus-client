<script setup lang="ts">
import { computed } from 'vue';
import { NCard, NForm, NFormItem, NInput, NButton, NIcon } from 'naive-ui';
import { Plug, Server } from '@vicons/fa';

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
  <div class="login-container">
    <n-card title="登录核心服务" size="large" class="login-card">
      <template #header-extra>
        <n-icon size="24" color="#18a058">
          <Server />
        </n-icon>
      </template>
      <n-form label-width="0">
        <n-form-item>
          <n-input
            v-model:value="tokenValue"
            placeholder="请输入账号 Token"
            type="password"
            show-password-on="click"
            size="large"
            @keyup.enter="emit('apply-token')"
          >
            <template #prefix>
              <n-icon><Plug /></n-icon>
            </template>
          </n-input>
        </n-form-item>
        <n-button
          type="primary"
          block
          size="large"
          :loading="loadingProfile"
          @click="emit('apply-token')"
        >
          登录 / 连接
        </n-button>
      </n-form>
    </n-card>
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 400px;
}

.login-card {
  width: 100%;
  max-width: 400px;
}
</style>
