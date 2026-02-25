<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { 
  NCard, NButton, NQrCode, NSpace, NSpin, NResult, NModal, 
  NText, NIcon, NAvatar, useMessage 
} from 'naive-ui'
import { 
  checkLoginStatusAsync, getLoginUrlDataAsync, getLoginInfoAsync, 
  biliCookie, getUidAsync 
} from '../services/bilibili'
import { UserCircle, Qrcode, CheckCircle } from '@vicons/fa'

const message = useMessage()

const isLoggedIn = ref(false)
const uid = ref<number>(0)
const showLoginModal = ref(false)

// Login State
const isQRCodeLogining = ref(false)
const loginUrl = ref('')
const loginKey = ref('')
const loginStatus = ref<'expired' | 'unknown' | 'scanned' | 'waiting' | 'confirmed' | undefined>(undefined)
const expiredTimer = ref<number>()
const timer = ref<number>()

async function checkStatus() {
  const valid = await checkLoginStatusAsync()
  isLoggedIn.value = valid
  if (valid) {
    uid.value = await getUidAsync()
  } else {
      uid.value = 0
  }
}

async function startLogin() {
  if (isQRCodeLogining.value) return
  
  try {
    isQRCodeLogining.value = true
    loginStatus.value = 'waiting'
    showLoginModal.value = true
    
    const data = await getLoginUrlDataAsync()
    loginUrl.value = data.url
    loginKey.value = data.qrcode_key
    
    // Expire after 3 minutes
    expiredTimer.value = window.setTimeout(() => {
      loginStatus.value = 'expired'
      if (timer.value) clearInterval(timer.value)
      isQRCodeLogining.value = false
    }, 3 * 60 * 1000)

    // Poll every 2 seconds
    timer.value = window.setInterval(async () => {
      try {
        const login = await getLoginInfoAsync(loginKey.value)
        loginStatus.value = login.status
        
        if (login.status === 'confirmed') {
          biliCookie.setBiliCookie(login.cookie, login.refresh_token)
          message.success('登录成功')
          finishLogin()
          await checkStatus()
          showLoginModal.value = false
        } else if (login.status === 'expired') {
          loginStatus.value = 'expired'
          clearInterval(timer.value)
          isQRCodeLogining.value = false
        }
      } catch (e) {
          console.error(e)
      }
    }, 2000)
    
  } catch (err: any) {
    console.error(err)
    message.error(err instanceof Error ? err.message : '获取登录二维码失败')
    isQRCodeLogining.value = false
    showLoginModal.value = false
  }
}

function finishLogin() {
  if (timer.value) clearInterval(timer.value)
  if (expiredTimer.value) clearTimeout(expiredTimer.value)
  isQRCodeLogining.value = false
  loginStatus.value = undefined
  loginUrl.value = ''
  loginKey.value = ''
}

function handleLogout() {
  biliCookie.clear()
  isLoggedIn.value = false
  uid.value = 0
  message.success('已登出 Bilibili')
}

function handleModalClose() {
    showLoginModal.value = false
    finishLogin()
}

onMounted(() => {
  checkStatus()
})

onBeforeUnmount(() => {
  finishLogin()
})
</script>

<template>
  <div class="bilibili-login-card">
      <n-card size="small" title="Bilibili 账号状态">
        <template #header-extra>
           <n-icon size="20" color="#fb7299"><UserCircle /></n-icon>
        </template>
        
        <div v-if="isLoggedIn" class="logged-in-state">
            <n-space align="center" justify="space-between">
                <n-space align="center">
                    <n-avatar round size="medium" src="https://static.hdslb.com/images/member/noface.gif" />
                    <div>
                        <div class="uid-text">UID: {{ uid }}</div>
                        <n-text type="success" depth="3" style="font-size: 12px">Cookie 有效</n-text>
                    </div>
                </n-space>
                <n-button size="small" type="error" ghost @click="handleLogout">
                    登出
                </n-button>
            </n-space>
        </div>

        <div v-else class="logged-out-state">
             <n-result status="info" title="未登录" description="需要登录 Bilibili 账号以连接弹幕" size="small" style="margin-top: 0; margin-bottom: 12px; padding: 0">
             </n-result>
             <n-button type="primary" block color="#fb7299" @click="startLogin">
                 <template #icon><n-icon><Qrcode /></n-icon></template>
                 扫码登录
             </n-button>
        </div>
      </n-card>

      <n-modal
        v-model:show="showLoginModal"
        preset="card"
        title="Bilibili 扫码登录"
        style="width: 400px"
        :on-close="handleModalClose"
        :mask-closable="false"
      >
        <div class="qr-container">
             <template v-if="loginStatus === 'expired'">
                 <n-result status="error" title="二维码已过期" description="请重新获取">
                     <template #footer>
                         <n-button @click="startLogin">刷新二维码</n-button>
                     </template>
                 </n-result>
             </template>
             
             <template v-else-if="loginUrl">
                 <n-space vertical align="center">
                     <n-qr-code :value="loginUrl" :size="200" error-correction-level="L" />
                     
                     <div class="status-text">
                         <n-text v-if="loginStatus === 'scanned'" type="success" strong>
                             <n-icon><CheckCircle /></n-icon> 扫码成功，请在手机上确认
                         </n-text>
                         <n-text v-else-if="loginStatus === 'waiting'" depth="3">
                             请使用 哔哩哔哩客户端 扫码
                         </n-text>
                         <n-spin v-else size="small" />
                     </div>
                 </n-space>
             </template>
             
             <template v-else>
                 <n-space justify="center" style="padding: 40px">
                     <n-spin size="large" />
                 </n-space>
             </template>
        </div>
      </n-modal>
  </div>
</template>

<style scoped>
.logged-in-state {
    padding: 4px 0;
}
.uid-text {
    font-weight: bold;
    font-size: 14px;
}
.qr-container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 250px;
    flex-direction: column;
}
.status-text {
    margin-top: 16px;
    text-align: center;
}
</style>
