<script setup lang="ts">
import {
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NSpace,
  NCard
} from 'naive-ui'
import CoreControlPanel from '../components/CoreControlPanel.vue'
import BilibiliLogin from '../components/BilibiliLogin.vue'
import { serverLoggedInRef } from '../services/http'
</script>

<template>
  <n-layout position="absolute" class="main-layout">
    <n-layout-header bordered class="app-header">
      <div class="header-content">
        <h2 class="app-title">Danmakus Client</h2>
        <div class="header-actions">
          <!-- Header Actions -->
        </div>
      </div>
    </n-layout-header>

    <n-layout-content class="app-content" :native-scrollbar="false">
      <div class="content-wrapper">
        <n-space vertical size="large">
          <n-card v-if="serverLoggedInRef" size="small" title="Bilibili 连接管理" class="bili-card">
            <div class="bili-section">
              <div class="bili-desc">
                <p>在此处登录 Bilibili 账号以获取访问凭证 (Cookie)。</p>
                <p class="text-gray">凭证将用于连接直播间弹幕服务。</p>
              </div>
              <div class="bili-action">
                <BilibiliLogin />
              </div>
            </div>
          </n-card>

          <CoreControlPanel />
        </n-space>
      </div>
    </n-layout-content>
  </n-layout>
</template>

<style scoped>
.main-layout {
  background-color: var(--n-color);
}

.app-header {
  height: 64px;
  padding: 0 24px;
}

.header-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  max-width: 1200px;
  margin: 0 auto;
}

.app-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.app-content {
  top: 64px;
  bottom: 0;
  left: 0;
  right: 0;
  position: absolute;
}

.content-wrapper {
  max-width: 1000px;
  margin: 0 auto;
  padding: 24px;
}

.bili-section {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
}

.bili-desc {
  flex: 1;
}

.bili-action {
  flex-shrink: 0;
}

.text-gray {
  color: var(--n-text-color-3);
  font-size: 12px;
  margin-top: 4px;
}

@media (max-width: 600px) {
  .bili-section {
    flex-direction: column;
    align-items: flex-start;
  }

  .bili-action {
    width: 100%;
    display: flex;
    justify-content: flex-end;
  }
}
</style>
