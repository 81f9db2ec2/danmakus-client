<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import IndexPage from './pages/Index.vue';
import 'vue-sonner/style.css';
import { Toaster } from '@/components/ui/sonner';

const colorSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const prefersDark = ref(colorSchemeQuery.matches);

const applyTheme = (isDark: boolean) => {
  document.documentElement.classList.toggle('dark', isDark);
};

const handleColorSchemeChange = (event: MediaQueryListEvent) => {
  prefersDark.value = event.matches;
  applyTheme(event.matches);
};

onMounted(() => {
  applyTheme(prefersDark.value);
  colorSchemeQuery.addEventListener('change', handleColorSchemeChange);
});

onBeforeUnmount(() => {
  colorSchemeQuery.removeEventListener('change', handleColorSchemeChange);
});
</script>

<template>
  <div class="h-screen bg-background text-foreground">
    <div
      aria-hidden="true"
      class="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_15%_10%,rgba(59,130,246,0.08),transparent_40%),radial-gradient(circle_at_85%_0%,rgba(16,185,129,0.06),transparent_36%)]"
    />
    <IndexPage />
    <Toaster rich-colors position="top-right" />
  </div>
</template>
