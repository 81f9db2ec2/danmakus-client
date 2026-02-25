<script setup lang="ts">
import {
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NEmpty,
  NForm,
  NFormItem,
  NGi,
  NGrid,
  NIcon,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
  NSwitch
} from 'naive-ui';
import { Save, Stop } from '@vicons/fa';
import type { CoreControlConfigDto } from '../../types/api';

defineProps<{
  coreConfig: CoreControlConfigDto;
  savingConfig: boolean;
}>();

const emit = defineEmits<{
  (e: 'save-config'): void;
  (e: 'add-streamer'): void;
  (e: 'remove-streamer', index: number): void;
}>();
</script>

<template>
  <div class="settings-tab">
    <n-form label-placement="top" show-feedback>
      <n-card title="基础设置" size="small">
        <template #header-extra>
          <n-button type="primary" size="small" :loading="savingConfig" @click="emit('save-config')">
            <template #icon><n-icon><Save /></n-icon></template>
            保存所有配置
          </n-button>
        </template>
        <n-grid :cols="2" :x-gap="24">
          <n-gi>
            <n-form-item label="最大连接数" feedback="同时连接的房间数量限制">
              <n-input-number v-model:value="coreConfig.maxConnections" :min="1" :max="50" style="width: 100%" />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="状态检查间隔 (s)" feedback="直播状态轮询间隔">
              <n-input-number v-model:value="coreConfig.statusCheckInterval" :min="5" style="width: 100%" />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="重连间隔 (ms)">
              <n-input-number v-model:value="coreConfig.reconnectInterval" :step="1000" :min="1000" style="width: 100%" />
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item label="功能开关">
              <n-space vertical>
                <n-switch v-model:value="coreConfig.autoReconnect">
                  <template #checked>自动重连: 开</template>
                  <template #unchecked>自动重连: 关</template>
                </n-switch>
                <n-switch v-model:value="coreConfig.requestServerRooms">
                  <template #checked>请求服务器分配: 开</template>
                  <template #unchecked>请求服务器分配: 关</template>
                </n-switch>
              </n-space>
            </n-form-item>
          </n-gi>
        </n-grid>
      </n-card>

      <n-card size="small" style="margin-top: 16px">
        <n-collapse>
          <n-collapse-item title="CookieCloud 设置 (选填)" name="cookiecloud">
            <n-grid :cols="1" :x-gap="24">
              <n-gi>
                <n-form-item label="Host">
                  <n-input v-model:value="coreConfig.cookieCloudHost" placeholder="例如 http://localhost:8088" />
                </n-form-item>
              </n-gi>
              <n-gi>
                <n-grid :cols="2" :x-gap="12">
                  <n-gi>
                    <n-form-item label="Key">
                      <n-input v-model:value="coreConfig.cookieCloudKey" />
                    </n-form-item>
                  </n-gi>
                  <n-gi>
                    <n-form-item label="Password">
                      <n-input
                        v-model:value="coreConfig.cookieCloudPassword"
                        type="password"
                        show-password-on="click"
                      />
                    </n-form-item>
                  </n-gi>
                </n-grid>
              </n-gi>
              <n-gi>
                <n-form-item label="刷新间隔 (s)">
                  <n-input-number v-model:value="coreConfig.cookieRefreshInterval" :min="60" style="width: 100%" />
                </n-form-item>
              </n-gi>
            </n-grid>
          </n-collapse-item>
        </n-collapse>
      </n-card>

      <n-card title="本地主播列表" size="small" style="margin-top: 16px">
        <template #header-extra>
          <n-button size="small" dashed type="primary" @click="emit('add-streamer')">
            + 添加主播
          </n-button>
        </template>
        <div class="streamer-list">
          <div v-for="(streamer, index) in coreConfig.streamers" :key="index" class="streamer-item">
            <n-grid :cols="12" :x-gap="8" align="center">
              <n-gi span="4">
                <n-input-number
                  v-model:value="streamer.roomId"
                  placeholder="房间号"
                  :show-button="false"
                />
              </n-gi>
              <n-gi span="3">
                <n-select
                  v-model:value="streamer.priority"
                  size="small"
                  :options="[
                    { label: '高优', value: 'high' },
                    { label: '普通', value: 'normal' },
                    { label: '低优', value: 'low' }
                  ]"
                />
              </n-gi>
              <n-gi span="4">
                <n-input v-model:value="streamer.name" placeholder="备注" />
              </n-gi>
              <n-gi span="1">
                <n-button text type="error" @click="emit('remove-streamer', index)">
                  <template #icon><n-icon><Stop /></n-icon></template>
                </n-button>
              </n-gi>
            </n-grid>
          </div>
          <n-empty v-if="coreConfig.streamers.length === 0" description="暂未配置本地主播" class="py-4" />
        </div>
      </n-card>
    </n-form>
  </div>
</template>

<style scoped>
.settings-tab {
  padding-top: 12px;
}

.streamer-item {
  margin-bottom: 8px;
  padding: 8px;
  background: var(--n-color-embedded);
  border-radius: 4px;
}

.py-4 {
  padding-top: 16px;
  padding-bottom: 16px;
}
</style>
