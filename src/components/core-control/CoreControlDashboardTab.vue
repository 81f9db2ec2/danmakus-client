<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NGi,
  NGrid,
  NIcon,
  NPopover,
  NSpace,
  NStatistic,
  NTable,
  NTag
} from 'naive-ui';
import { CommentDots, Play, Plug, Server, Stop, Stream } from '@vicons/fa';

type ConnectionInfo = {
  roomId: number;
  priority: string;
  connectedAt: number;
};

type RemoteClientSnapshot = {
  clientId: string;
  ip: string | null;
  isRunning: boolean;
  signalrConnected: boolean;
  connectedRooms: number[];
  messageCount: number;
  lastHeartbeat: number | null;
};

type RuntimeStateSnapshot = {
  isRunning: boolean;
  signalrConnected: boolean;
  connectedRooms: number[];
  connectionInfo: ConnectionInfo[];
  messageCount: number;
  serverAssignedRooms: number[];
  lastError: string | null;
  lastRoomAssigned: number | null;
};

defineProps<{
  runtimeState: RuntimeStateSnapshot;
  remoteClients: RemoteClientSnapshot[];
  localClientId: string;
  lastHeartbeatText: string;
  cookieStatusText: string;
  cookieStatusType: 'success' | 'warning';
  refreshingState: boolean;
  forcingLock: boolean;
  startingCore: boolean;
  stoppingCore: boolean;
}>();

const emit = defineEmits<{
  (e: 'refresh-runtime-state'): void;
  (e: 'force-takeover'): void;
  (e: 'start-core'): void;
  (e: 'stop-core'): void;
}>();
</script>

<template>
  <div class="dashboard-tab">
    <n-grid :cols="4" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
      <n-gi span="2 s:2 m:1">
        <n-card size="small" embedded>
          <n-statistic label="运行状态">
            <template #prefix>
              <n-icon :color="runtimeState.isRunning ? '#18a058' : '#d03050'">
                <Server />
              </n-icon>
            </template>
            <n-tag :type="runtimeState.isRunning ? 'success' : 'error'" round>
              {{ runtimeState.isRunning ? '运行中' : '已停止' }}
            </n-tag>
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi span="2 s:2 m:1">
        <n-card size="small" embedded>
          <n-statistic label="SignalR">
            <template #prefix>
              <n-icon :color="runtimeState.signalrConnected ? '#2080f0' : '#999'">
                <Plug />
              </n-icon>
            </template>
            {{ runtimeState.signalrConnected ? '已连接' : '断开' }}
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi span="2 s:2 m:1">
        <n-card size="small" embedded>
          <n-statistic label="连接房间" :value="runtimeState.connectedRooms.length">
            <template #prefix>
              <n-icon color="#f0a020"><Stream /></n-icon>
            </template>
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi span="2 s:2 m:1">
        <n-card size="small" embedded>
          <n-statistic label="累计消息" :value="runtimeState.messageCount">
            <template #prefix>
              <n-icon color="#2080f0"><CommentDots /></n-icon>
            </template>
          </n-statistic>
        </n-card>
      </n-gi>
      <n-gi span="2 s:2 m:1">
        <n-card size="small" embedded>
          <n-statistic label="Cookie 状态">
            <template #prefix>
              <n-tag size="small" :type="cookieStatusType">{{ cookieStatusText }}</n-tag>
            </template>
            <div class="stat-extra">最近心跳：{{ lastHeartbeatText }}</div>
          </n-statistic>
        </n-card>
      </n-gi>
    </n-grid>

    <n-card size="small" style="margin-top: 16px" title="快捷操作">
      <template #header-extra>
        <n-space size="small">
          <n-button size="small" secondary :loading="refreshingState" @click="emit('refresh-runtime-state')">
            刷新状态
          </n-button>
          <n-button size="small" tertiary type="warning" :loading="forcingLock" @click="emit('force-takeover')">
            强制接管(本IP)
          </n-button>
          <n-tag type="info" size="small" round>
            在线客户端: {{ remoteClients.length }}
          </n-tag>
          <n-tag size="small" round>
            本机ID: {{ localClientId }}
          </n-tag>
          <n-tag v-if="runtimeState.lastRoomAssigned" type="info" size="small">
            最近分配: {{ runtimeState.lastRoomAssigned }}
          </n-tag>
        </n-space>
      </template>
      <n-space justify="space-between" align="center">
        <n-space>
          <n-button
            v-if="!runtimeState.isRunning"
            type="primary"
            size="large"
            :loading="startingCore"
            @click="emit('start-core')"
          >
            <template #icon><n-icon><Play /></n-icon></template>
            启动核心
          </n-button>
          <n-button
            v-else
            type="error"
            size="large"
            secondary
            :loading="stoppingCore"
            @click="emit('stop-core')"
          >
            <template #icon><n-icon><Stop /></n-icon></template>
            停止核心
          </n-button>
        </n-space>

        <n-space vertical size="small" style="flex: 1">
          <n-alert v-if="runtimeState.lastError" type="error" show-icon closable>
            {{ runtimeState.lastError }}
          </n-alert>
        </n-space>
      </n-space>
    </n-card>

    <n-card size="small" title="在线客户端" style="margin-top: 16px">
      <n-table size="small" :bordered="false" :single-line="false">
        <thead>
          <tr>
            <th>ClientId</th>
            <th>IP</th>
            <th>运行</th>
            <th>SignalR</th>
            <th>连接房间</th>
            <th>消息</th>
            <th>最近心跳</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="client in remoteClients" :key="client.clientId">
            <td>
              <n-tag
                size="small"
                :type="client.clientId === localClientId ? 'success' : 'default'"
                :bordered="false"
              >
                {{ client.clientId }}
              </n-tag>
            </td>
            <td>{{ client.ip || '—' }}</td>
            <td>
              <n-tag size="small" :type="client.isRunning ? 'success' : 'default'">
                {{ client.isRunning ? '运行中' : '已停止' }}
              </n-tag>
            </td>
            <td>{{ client.signalrConnected ? '已连接' : '断开' }}</td>
            <td>{{ client.connectedRooms.length }}</td>
            <td>{{ client.messageCount }}</td>
            <td>{{ client.lastHeartbeat ? new Date(client.lastHeartbeat).toLocaleString() : '—' }}</td>
          </tr>
          <tr v-if="remoteClients.length === 0">
            <td colspan="7" class="empty-cell">
              <n-empty description="暂无在线客户端" size="small" />
            </td>
          </tr>
        </tbody>
      </n-table>
    </n-card>

    <n-card size="small" title="连接详情" style="margin-top: 16px">
      <template #header-extra>
        <n-popover trigger="hover" placement="bottom-end">
          <template #trigger>
            <n-tag type="info" size="small" round style="cursor: pointer">
              服务器分配: {{ runtimeState.serverAssignedRooms.length }}
            </n-tag>
          </template>
          <div style="max-width: 300px">
            <div v-if="runtimeState.serverAssignedRooms.length > 0">
              <n-space size="small">
                <n-tag v-for="room in runtimeState.serverAssignedRooms" :key="room" size="small">
                  {{ room }}
                </n-tag>
              </n-space>
            </div>
            <div v-else>暂无服务器分配的房间</div>
          </div>
        </n-popover>
      </template>
      <n-table size="small" :bordered="false" :single-line="false">
        <thead>
          <tr>
            <th>房间 ID</th>
            <th>优先级</th>
            <th>连接时长</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="conn in runtimeState.connectionInfo" :key="conn.roomId">
            <td><n-tag size="small" :bordered="false">{{ conn.roomId }}</n-tag></td>
            <td>
              <n-tag size="small" :type="conn.priority === 'high' ? 'error' : conn.priority === 'low' ? 'default' : 'info'">
                {{ conn.priority }}
              </n-tag>
            </td>
            <td>{{ new Date(conn.connectedAt).toLocaleTimeString() }}</td>
          </tr>
          <tr v-if="runtimeState.connectionInfo.length === 0">
            <td colspan="3" class="empty-cell">
              <n-empty description="暂无活动连接" size="small" />
            </td>
          </tr>
        </tbody>
      </n-table>
    </n-card>
  </div>
</template>

<style scoped>
.dashboard-tab {
  padding-top: 12px;
}

.stat-extra {
  font-size: 12px;
  color: var(--n-text-color-3);
}

.empty-cell {
  text-align: center;
  padding: 24px;
}
</style>
