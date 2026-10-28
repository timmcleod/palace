<script setup>
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";

// A conflicted file with each side of every conflict highlighted, and the ways to
// resolve it.
const props = defineProps({
  path: { type: String, required: true },
  file: { type: Object, required: true },
});
const emit = defineEmits(["changed"]);

const text = ref(null);
const error = ref("");
const busy = ref(false);

watch(
  () => props.file,
  async () => {
    error.value = "";
    try {
      text.value = await invoke("conflict_file", { path: props.path, file: props.file.path });
    } catch (e) {
      text.value = null;
      error.value = String(e);
    }
  },
  { immediate: true },
);

// Tags each line with the part of a conflict it's in, and numbers each conflict where
// it starts. Git writes:
//   <<<<<<< current … ||||||| base (diff3 style only) … ======= … >>>>>>> incoming
const lines = computed(() => {
  if (text.value == null) return [];
  let region = null;
  let blocks = 0;
  return text.value.split("\n").map((line, i) => {
    let kind = region;
    let block = null;
    if (line.startsWith("<<<<<<<") && !region) {
      kind = "marker";
      region = "current";
      block = blocks++;
    } else if (line.startsWith("|||||||") && region) {
      kind = "marker";
      region = "base";
    } else if (line.startsWith("=======") && region) {
      kind = "marker";
      region = "incoming";
    } else if (line.startsWith(">>>>>>>") && region) {
      kind = "marker";
      region = null;
    }
    return { number: i + 1, text: line, kind, block };
  });
});

const conflictCount = computed(() => lines.value.filter((l) => l.block != null).length);

// Settles one conflict, leaving the rest of the file to resolve.
async function resolveBlock(block, side) {
  busy.value = true;
  error.value = "";
  try {
    text.value = await invoke("resolve_conflict_block", { path: props.path, file: props.file.path, block, side });
    emit("changed");
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function run(command, args) {
  busy.value = true;
  error.value = "";
  try {
    await invoke(command, { path: props.path, file: props.file.path, ...args });
    if (command !== "open_in_editor") emit("changed");
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="conflict-view selectable">
    <p class="intro">
      This file has conflicting changes. Choose a side for each conflict below, keep one side for the whole file, or
      edit the file to combine them, then mark it as resolved.
    </p>

    <div class="actions">
      <button class="secondary-button" :disabled="busy" title="Keep HEAD's version of the whole file" @click="run('resolve_conflict', { side: 'current' })">
        Use Current
      </button>
      <button class="secondary-button" :disabled="busy" title="Keep the whole file as it is in the change being merged, rebased or applied" @click="run('resolve_conflict', { side: 'incoming' })">
        Use Incoming
      </button>
      <button class="secondary-button" :disabled="busy" @click="run('open_in_editor')">Open in Editor</button>
      <button class="primary-button" :disabled="busy" title="Stage the file as it is now" @click="run('resolve_conflict', { side: 'resolved' })">
        Mark as Resolved
      </button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="text != null">
      <p v-if="conflictCount" class="count">
        {{ conflictCount }} conflict{{ conflictCount === 1 ? "" : "s" }} ·
        <span class="swatch current" /> current <span class="swatch incoming" /> incoming
      </p>
      <p v-else class="count">No conflict markers left. If the file looks right, mark it as resolved.</p>

      <div class="scroller">
        <table class="mono">
          <template v-for="line in lines" :key="line.number">
            <tr v-if="line.block != null" class="block-row">
              <td class="gutter" />
              <td>
                <div class="block-bar">
                  <span class="block-label">Conflict {{ line.block + 1 }}</span>
                  <span class="use">Use:</span>
                  <button class="secondary-button" :disabled="busy" title="Keep the current side" @click="resolveBlock(line.block, 'current')">
                    Current
                  </button>
                  <button class="secondary-button" :disabled="busy" title="Keep the incoming side" @click="resolveBlock(line.block, 'incoming')">
                    Incoming
                  </button>
                  <button
                    class="secondary-button"
                    :disabled="busy"
                    title="Keep both, the current side first"
                    @click="resolveBlock(line.block, 'both')"
                  >
                    Both
                  </button>
                </div>
              </td>
            </tr>
            <tr :class="line.kind">
              <td class="gutter">{{ line.number }}</td>
              <td class="text">{{ line.text }}</td>
            </tr>
          </template>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.conflict-view {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px 16px;
}

.intro {
  margin: 0 0 10px;
  color: var(--text-secondary);
  font-size: 13px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.actions .primary-button {
  margin-left: auto;
}

.actions button {
  padding: 5px 12px;
  font-size: 13px;
}

.error {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--error-bg);
  color: var(--danger);
  font-size: 12.5px;
  white-space: pre-wrap;
}

.count {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 0 6px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.swatch {
  width: 10px;
  height: 10px;
  margin-left: 6px;
  border-radius: 2px;
}

.swatch.current {
  background: var(--conflict-current);
}

.swatch.incoming {
  background: var(--conflict-incoming);
}

.scroller {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}

table {
  min-width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  line-height: 18px;
}

td {
  padding: 0;
  vertical-align: top;
}

.gutter {
  min-width: 44px;
  padding: 0 8px;
  text-align: right;
  color: var(--text-tertiary);
  background: var(--diff-gutter-bg);
  -webkit-user-select: none;
  user-select: none;
}

.text {
  width: 100%;
  padding: 0 10px;
  white-space: pre;
  tab-size: var(--tab-size);
}

.current .text {
  background: var(--conflict-current);
}

.incoming .text {
  background: var(--conflict-incoming);
}

.base .text {
  background: var(--toolbar-group-bg);
}

.block-row td {
  padding-top: 10px;
  background: var(--diff-gutter-bg);
}

tr.block-row:first-child td {
  padding-top: 4px;
}

/* Stays in view when the file is scrolled sideways. */
.block-bar {
  position: sticky;
  left: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 10px 4px;
  white-space: nowrap;
  font-family: system-ui, "Ubuntu", "Cantarell", sans-serif;
}

.use {
  font-size: 12px;
  color: var(--text-tertiary);
}

.block-label {
  margin-right: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.block-bar button {
  padding: 2px 10px;
  font-size: 12px;
}

.marker .text {
  font-weight: 700;
  color: var(--text-secondary);
  background: var(--diff-hunk-bg);
}
</style>
