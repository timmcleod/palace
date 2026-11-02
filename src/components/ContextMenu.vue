<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Check } from "lucide-vue-next";
import { closeMenu } from "../lib/overlays.js";

const props = defineProps({
  menu: { type: Object, required: true },
});

const el = ref(null);
const field = ref(null);
const position = ref({ left: `${props.menu.x}px`, top: `${props.menu.y}px` });

// What's typed in the menu's filter field, if it has one: it narrows the items
// marked `filterable` to those with every word of it in their label or detail.
const query = ref("");
const words = computed(() => query.value.toLowerCase().split(/\s+/).filter(Boolean));
const matches = (item) => {
  const text = `${item.label} ${item.detail ?? ""}`.toLowerCase();
  return words.value.every((word) => text.includes(word));
};
const shown = computed(() => props.menu.items.filter((item) => !item.filterable || matches(item)));
const noMatches = computed(() => words.value.length > 0 && !shown.value.some((item) => item.filterable));

// The filterable items in a row share a list of their own that shows the filter's
// `rows` of them at most, and scrolls to the rest. Other items stand alone.
const groups = computed(() => {
  const out = [];
  for (const item of shown.value) {
    const last = out.at(-1);
    if (item.filterable && last?.list) last.items.push(item);
    else out.push({ list: !!item.filterable, items: [item] });
  }
  return out;
});
const rows = props.menu.items.find((item) => item.filter)?.rows;
const listHeight = ref("none");

// The item the arrow keys and Enter act on: the first match while filtering.
const active = ref(-1);
const choosable = (item) => item && !item.separator && !item.filter && !item.disabled;
watch(words, () => {
  active.value = words.value.length ? shown.value.findIndex((item) => item.filterable) : -1;
});

function choose(item) {
  closeMenu();
  item.action();
}

function move(step) {
  const items = shown.value;
  let i = active.value;
  for (let n = 0; n < items.length; n++) {
    i = (i + step + items.length) % items.length;
    if (choosable(items[i])) break;
  }
  active.value = i;
  nextTick(() => el.value?.querySelector(".item.active")?.scrollIntoView({ block: "nearest" }));
}

function onKey(e) {
  if (e.key === "Escape") return closeMenu();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    move(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" && choosable(shown.value[active.value])) {
    e.preventDefault();
    choose(shown.value[active.value]);
  }
}

onMounted(() => {
  const row = el.value.querySelector(".list .item");
  if (rows && row) listHeight.value = `${rows * row.offsetHeight}px`;
  // Keep the menu inside the window. One taller than the window scrolls.
  const rect = el.value.getBoundingClientRect();
  position.value = {
    left: `${Math.min(props.menu.x, window.innerWidth - rect.width - 8)}px`,
    top: `${Math.max(8, Math.min(props.menu.y, window.innerHeight - rect.height - 8))}px`,
  };
  window.addEventListener("keydown", onKey);
  field.value?.[0]?.focus();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="menu-backdrop" @mousedown="closeMenu" @contextmenu.prevent="closeMenu" />
  <div ref="el" class="menu" :style="position" role="menu">
    <div
      v-for="group in groups"
      :key="menu.items.indexOf(group.items[0])"
      :class="group.list ? 'list' : 'single'"
      :style="group.list && { maxHeight: listHeight }"
    >
      <template v-for="item in group.items" :key="menu.items.indexOf(item)">
        <div v-if="item.separator" class="separator" />
        <template v-else-if="item.filter">
          <input
            ref="field"
            v-model="query"
            class="filter"
            type="text"
            spellcheck="false"
            autocomplete="off"
            :placeholder="item.filter"
          />
          <div v-if="noMatches" class="none">{{ item.empty }}</div>
        </template>
        <button
          v-else
          class="item"
          :disabled="item.disabled"
          :class="{
            danger: item.danger,
            detailed: item.detail,
            checkable: menu.items.some((i) => i.checked),
            active: shown.indexOf(item) === active,
          }"
          role="menuitem"
          @mousemove="active = shown.indexOf(item)"
          @click="choose(item)"
        >
          <Check v-if="item.checked" :size="14" class="check" />
          <span class="label">{{ item.label }}</span>
          <span v-if="item.detail" class="detail">{{ item.detail }}</span>
        </button>
      </template>
    </div>
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
  box-sizing: border-box;
  min-width: 200px;
  max-width: 440px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--content-bg);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
}

.single {
  display: contents;
}

.list {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow-y: auto;
}

.item {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
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

.item.checkable {
  padding-left: 28px;
}

.check {
  position: absolute;
  top: 7px;
  left: 8px;
}

.label,
.detail {
  overflow: hidden;
  text-overflow: ellipsis;
}

.item.detailed .label {
  font-weight: 500;
}

.detail {
  font-size: 12px;
  color: var(--text-tertiary);
}

.item.active:not(:disabled) .detail {
  color: inherit;
  opacity: 0.85;
}

.item.active:not(:disabled) {
  background: var(--accent);
  color: white;
}

.item.danger:not(.active) {
  color: var(--danger);
}

.item:disabled {
  color: var(--text-tertiary);
}

.separator {
  flex-shrink: 0;
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}

.filter {
  flex-shrink: 0;
  margin: 2px 2px 4px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  font-size: 13px;
  color: var(--text-primary);
}

.filter:focus {
  border-color: var(--accent);
}

.none {
  padding: 5px 10px;
  font-size: 13px;
  color: var(--text-tertiary);
}
</style>
