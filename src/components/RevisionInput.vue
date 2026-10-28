<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import { ChevronDown } from "lucide-vue-next";

// A revision field: type a branch, tag or commit, or pick one from a grouped list.
const model = defineModel({ type: String, required: true });
const props = defineProps({
  id: { type: String, default: null },
  branches: { type: Array, default: () => [] },
  tags: { type: Array, default: () => [] },
  remoteBranches: { type: Array, default: () => [] },
});

const listOpen = ref(false);
// While typing, the list narrows to matches; opened from the button, it shows everything.
const filtering = ref(false);

const groups = computed(() => {
  const query = filtering.value ? model.value.trim().toLowerCase() : "";
  const match = (item) => !query || item.toLowerCase().includes(query);
  return [
    { label: "Branches", items: props.branches.filter(match) },
    { label: "Tags", items: props.tags.filter(match) },
    { label: "Remote Branches", items: props.remoteBranches.filter(match) },
  ].filter((g) => g.items.length);
});

// After typing, the button shows the whole list rather than closing the narrowed one.
function toggleList() {
  listOpen.value = filtering.value || !listOpen.value;
  filtering.value = false;
}

function onInput() {
  filtering.value = true;
  listOpen.value = true;
}

function choose(item) {
  model.value = item;
  listOpen.value = false;
}

// Escape closes the list before it closes the dialog.
function onKeydown(event) {
  if (event.key === "Escape" && listOpen.value) {
    event.stopPropagation();
    listOpen.value = false;
  }
}

// Clicking anywhere else closes the list. (Not on focus loss: WebKit doesn't focus
// buttons when they're clicked, so the list would close before a pick registered.)
const root = ref(null);
function onPointerDown(event) {
  if (listOpen.value && !root.value?.contains(event.target)) listOpen.value = false;
}
document.addEventListener("mousedown", onPointerDown, true);
onBeforeUnmount(() => document.removeEventListener("mousedown", onPointerDown, true));
</script>

<template>
  <div ref="root" class="combo" @keydown="onKeydown">
    <div class="combo-field">
      <input
        :id="id"
        v-model="model"
        type="text"
        spellcheck="false"
        autocomplete="off"
        @input="onInput"
        @keydown.down.prevent="listOpen = true"
      />
      <button type="button" class="combo-button" title="Choose a branch or tag" @click="toggleList">
        <ChevronDown :size="16" />
      </button>
    </div>
    <div v-if="listOpen && groups.length" class="combo-list">
      <template v-for="group in groups" :key="group.label">
        <div class="group-label">{{ group.label }}</div>
        <button v-for="item in group.items" :key="item" type="button" class="option" @click="choose(item)">
          {{ item }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.combo {
  position: relative;
}

.combo-field {
  position: relative;
}

input {
  width: 100%;
  padding: 7px 40px 7px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  color: var(--text-primary);
}

input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}

.combo-button {
  position: absolute;
  top: 50%;
  right: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  transform: translateY(-50%);
  border: 0;
  border-radius: 5px;
  background: var(--toolbar-group-bg);
  color: var(--text-secondary);
}

.combo-button:hover {
  background: var(--button-hover);
}

.combo-list {
  position: absolute;
  top: 38px;
  right: 0;
  left: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  max-height: 240px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--content-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
}

.group-label {
  padding: 6px 8px 2px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-tertiary);
}

.option {
  padding: 4px 8px;
  border: 0;
  border-radius: 5px;
  background: none;
  font: inherit;
  text-align: left;
  color: var(--text-primary);
}

.option:hover {
  background: var(--accent);
  color: white;
}
</style>
