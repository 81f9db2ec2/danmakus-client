<script setup lang="ts">
import { CARD_PAGE_SIZE_OPTIONS, cardSettings, useCardSettings, type CardSettings } from '../../utils/card-settings';

const settings = useCardSettings();

type ToggleKey = { [K in keyof CardSettings]: CardSettings[K] extends boolean ? K : never }[keyof CardSettings];

const toggles: Array<{ key: ToggleKey; label: string }> = [
  { key: 'enabled', label: '在用户卡片中显示弹幕记录' },
  { key: 'autoLoad', label: '打开卡片自动查询' },
  { key: 'showCover', label: '显示直播封面' },
  { key: 'hideOnlyEnter', label: '隐藏仅进场的场次' },
];

const update = (patch: Partial<CardSettings>) => cardSettings.setValue({ ...settings.value!, ...patch });
</script>

<template>
  <section v-if="settings" class="rounded-xl border border-border bg-card p-3 space-y-2 text-xs">
    <label
      v-for="item in toggles"
      :key="item.key"
      class="flex cursor-pointer items-center justify-between gap-2"
      :class="item.key !== 'enabled' && !settings.enabled ? 'opacity-50' : ''"
    >
      <span :class="item.key === 'enabled' ? 'font-semibold' : 'text-muted-foreground'">{{ item.label }}</span>
      <input
        type="checkbox"
        class="h-3.5 w-3.5 accent-[var(--primary)]"
        :checked="settings[item.key]"
        :disabled="item.key !== 'enabled' && !settings.enabled"
        @change="update({ [item.key]: ($event.target as HTMLInputElement).checked })"
      />
    </label>
    <div
      class="flex items-center justify-between border-t border-border/60 pt-2"
      :class="settings.enabled ? '' : 'opacity-50'"
    >
      <span class="text-muted-foreground">每页场次</span>
      <div class="flex items-center gap-1">
        <button
          v-for="num in CARD_PAGE_SIZE_OPTIONS"
          :key="num"
          type="button"
          :disabled="!settings.enabled"
          class="h-6 w-7 rounded-md border font-mono font-medium transition"
          :class="
            settings.pageSize === num
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background text-muted-foreground hover:text-foreground'
          "
          @click="update({ pageSize: num })"
        >
          {{ num }}
        </button>
      </div>
    </div>
  </section>
</template>
