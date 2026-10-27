<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { closeMenu } from "../lib/overlays.js";

const props = defineProps({
  menu: { type: Object, required: true },
});

const el = ref(null);
const position = ref({ left: `${props.menu.x}px`, top: `${props.menu.y}px` });

function choose(item) {
  closeMenu();
  item.action();
}

const onKey = (e) => e.key === "Escape" && closeMenu();

onMounted(() => {
  // Keep the menu inside the window.
  const rect = el.value.getBoundingClientRect();
  position.value = {
    left: `${Math.min(props.menu.x, window.innerWidth - rect.width - 8)}px`,
    top: `${Math.min(props.menu.y, window.innerHeight - rect.height - 8)}px`,
  };
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="menu-backdrop" @mousedown="closeMenu" @contextmenu.prevent="closeMenu" />
  <div ref="el" class="menu" :style="position" role="menu">
    <template v-for="(item, i) in menu.items" :key="i">
      <div v-if="item.separator" class="separator" />
      <button
        v-else
        class="item"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        role="menuitem"
        @click="choose(item)"
      >
        {{ item.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}

.menu {
  position: fixed;
  z-index: 31;
  display: flex;
  flex-direction: column;
  min-width: 200px;
  max-width: 360px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--content-bg);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
}

.item {
  padding: 5px 10px;
  border: 0;
  border-radius: 5px;
  background: none;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item:hover:not(:disabled) {
  background: var(--accent);
  color: white;
}

.item.danger:not(:hover) {
  color: var(--danger);
}

.item:disabled {
  color: var(--text-tertiary);
}

.separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
</style>
