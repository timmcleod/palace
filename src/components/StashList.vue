<script setup>
import { computed } from "vue";
import { Archive } from "lucide-vue-next";

// Every stash: the branch it was made on, when, and its message.
const props = defineProps({
  stashes: { type: Array, required: true },
  selectedIndex: { type: Number, default: null },
  // Only stashes whose message contains this.
  query: { type: String, default: "" },
});
const emit = defineEmits(["select", "menu"]);

const shown = computed(() => {
  const q = props.query.trim().toLowerCase();
  return q ? props.stashes.filter((s) => s.message.toLowerCase().includes(q)) : props.stashes;
});

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
const fullDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });

function onKeydown(event) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const list = shown.value;
  if (!list.length) return;
  const at = list.findIndex((s) => s.index === props.selectedIndex);
  const next = event.key === "ArrowDown" ? Math.min(at + 1, list.length - 1) : Math.max(at - 1, 0);
  emit("select", list[next].index);
}
</script>

<template>
  <div class="stash-list" tabindex="0" @keydown="onKeydown">
    <div
      v-for="stash in shown"
      :key="stash.id"
      class="stash"
      :class="{ selected: stash.index === selectedIndex }"
      :title="`stash@{${stash.index}}: ${stash.message}`"
      @click="emit('select', stash.index)"
      @contextmenu.prevent="
        emit('select', stash.index);
        emit('menu', stash.index, $event);
      "
    >
      <div class="line">
        <span class="based-on">
          <template v-if="stash.branch">Based on <span class="ref">{{ stash.branch }}</span></template>
          <template v-else>Detached HEAD</template>
        </span>
        <span class="date" :title="fullDateFormat.format(stash.time * 1000)">
          {{ dateFormat.format(stash.time * 1000) }}
        </span>
      </div>
      <div class="summary">{{ stash.summary }}</div>
    </div>

    <div v-if="!shown.length" class="empty">
      <Archive :size="28" :stroke-width="1.25" />
      <p v-if="stashes.length">No stashes match “{{ query.trim() }}”.</p>
      <p v-else>No stashes. Stash your uncommitted changes with the toolbar's stash button to set them aside.</p>
    </div>
  </div>
</template>

<style scoped>
.stash-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  outline: none;
}

.stash {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 12px 10px;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
}

.stash.selected {
  border-bottom-color: transparent;
  border-radius: 7px;
  background: var(--row-selected);
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.based-on {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text-tertiary);
}

.ref {
  margin-left: 2px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--ref-remote);
  font-size: 12px;
  line-height: 17px;
  color: white;
}

.date {
  flex-shrink: 0;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 300px;
  margin: 60px auto 0;
  text-align: center;
  color: var(--text-tertiary);
}
</style>
