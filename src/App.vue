<script setup lang="ts">
import { NConfigProvider, NMessageProvider, darkTheme } from 'naive-ui';
import { onBeforeUnmount, ref, watchEffect } from 'vue';
import IndexPage from './pages/Index.vue';

const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const prefersDark = ref(colorSchemeQuery.matches);
const handleColorSchemeChange = (event: MediaQueryListEvent) => {
  prefersDark.value = event.matches;
};
colorSchemeQuery.addEventListener('change', handleColorSchemeChange);

onBeforeUnmount(() => {
  colorSchemeQuery.removeEventListener('change', handleColorSchemeChange);
});

watchEffect(() => {
  document.body.style.backgroundColor = prefersDark.value ? '#0f0f0f' : '#f6f6f6';
  document.body.style.color = prefersDark.value ? '#f6f6f6' : '#0f0f0f';
});
</script>

<template>
  <n-config-provider :theme="prefersDark ? darkTheme : null">
    <n-message-provider>
      <IndexPage />
    </n-message-provider>
  </n-config-provider>
</template>

<style>
:root,
body {
  background-color: var(--n-color);
  color: var(--n-text-color);
  transition: background-color 0.3s ease;
}

body {
  margin: 0;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
</style>
