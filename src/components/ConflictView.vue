<script setup>
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { askConfirm } from "../lib/overlays.js";
import { CANCELED } from "../lib/errors.js";
import { deletion, namedSides } from "../lib/conflictSides.js";
import { conflictCount as countConflicts, conflictLines } from "../lib/conflictText.js";
import { isUnsaved } from "../lib/editing.js";

// A conflicted file with each side of every conflict highlighted, and the ways to
// resolve it.
const props = defineProps({
  path: { type: String, required: true },
  file: { type: Object, required: true },
  // undoable(step, work): runs `work`, remembering how to undo it.
  undoable: { type: Function, default: (step, work) => work() },
});
// "changed" after anything's done to the file, and "resolved" too, with its path, when
// that resolved it, for the next conflicted file to show; "open-file" to edit it in the
// Files view.
const emit = defineEmits(["changed", "resolved", "open-file"]);

const text = ref(null);
const error = ref("");
const busy = ref(false);
// What each side is, and whether one deleted the file (see conflict.rs).
const sides = ref(null);
const named = computed(() => namedSides(sides.value));
const deleted = computed(() => deletion(sides.value));
const fileName = computed(() => props.file.path.split("/").at(-1));

let loadSeq = 0;
watch(
  () => props.file,
  async () => {
    const seq = ++loadSeq;
    const args = { path: props.path, file: props.file.path };
    const [read, sided] = await Promise.allSettled([invoke("conflict_file", args), invoke("conflict_sides", args)]);
    if (seq !== loadSeq) return;
    sides.value = sided.status === "fulfilled" ? sided.value : null;
    text.value = read.status === "fulfilled" ? read.value : null;
    // A side's deleting the file may have left nothing on disk to read: that's said
    // in its place.
    error.value = read.status === "rejected" && !deleted.value ? String(read.reason) : "";
  },
  { immediate: true },
);

// Who's who, on hover: a side's name, and what it is.
const describe = (side) => `${side.label}, ${side.says}`;

const lines = computed(() => conflictLines(text.value));
const conflictCount = computed(() => countConflicts(text.value));

// Settles one conflict, leaving the rest of the file to resolve.
async function resolveBlock(block, side) {
  const resolved = await run("resolve_conflict_block", { block, side }, "Resolve Conflict");
  if (resolved != null) text.value = resolved;
}

// What's undone is the file, in the index and on disk: with a conflict's sides there,
// undoing brings it back (see undo.rs). Continuing still finishes the operation as one
// step (see useUndo).
const step = (label) => ({ label, mode: "keep", cover: { files: [props.file.path] }, resolving: true });

// Taking one side replaces the whole file.
async function useSide(side) {
  const ok = await askConfirm({
    title: `Use ${named.value[side].label}`,
    message: `Replace all of “${fileName.value}” with its side from ${describe(named.value[side])}, and mark it as resolved?\n\nThe file as it is now, including any conflicts you've resolved in it, goes to the Trash.`,
    confirmLabel: "Replace",
    danger: true,
  });
  if (ok) await resolve(side);
}

// A side doesn't have the file: keeping it takes the side that does, and deleting it
// deletes it, whichever side it was.
async function deleteFile() {
  const ok = await askConfirm({
    title: "Delete File",
    message: `Delete “${fileName.value}”, and mark it as resolved?\n\nThe file as it is now goes to the Trash.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (ok) await resolve("deleted");
}

// Staged as it is, which may not be what was meant: with conflicts still in it, as
// when one was missed, or with edits in Palace's editor not saved yet. It's read again
// first, as it may have been edited elsewhere since it was shown.
async function markResolved() {
  // Busy while it's read and asked about, so a second click doesn't resolve it twice.
  busy.value = true;
  const now = await invoke("conflict_file", { path: props.path, file: props.file.path }).catch(() => null);
  const left = countConflicts(now);
  const unsaved = isUnsaved(props.path, props.file.path);
  if (left || unsaved) {
    const why = [
      left && `It still has ${left === 1 ? "a conflict" : `${left} conflicts`} in it, which would be committed as ${left === 1 ? "it is" : "they are"}, markers and all.`,
      unsaved && "It has edits in Palace's editor that aren't saved, which would be left out.",
    ];
    const ok = await askConfirm({
      title: "Mark as Resolved",
      message: `Mark “${fileName.value}” as resolved anyway?\n\n${why.filter(Boolean).join("\n\n")}`,
      confirmLabel: "Mark as Resolved",
    }).finally(() => (busy.value = false));
    if (!ok) return;
  }
  busy.value = false;
  await resolve("resolved");
}

// What resolving it each way is called, for undoing it.
const RESOLVING = { current: "Use Side", incoming: "Use Side", deleted: "Delete File", resolved: "Mark as Resolved" };

// Resolves the file: by taking a side, deleting it, or as it is. Keeping a file one
// side deleted takes the other side.
async function resolve(side) {
  const label = deleted.value?.keep === side ? "Keep File" : RESOLVING[side];
  if ((await run("resolve_conflict", { side }, label)) !== undefined) emit("resolved", props.file.path);
}

// Runs `command` on the file, as a step to undo called `label`, or with none, as
// opening it elsewhere, not. Resolves to what it returns (null for nothing), or
// undefined if it failed or was canceled.
async function run(command, args, label = null) {
  busy.value = true;
  error.value = "";
  try {
    const work = () => invoke(command, { path: props.path, file: props.file.path, ...args });
    const result = await (label ? props.undoable(step(label), work) : work());
    if (label) emit("changed");
    return result ?? null;
  } catch (e) {
    if (String(e) !== CANCELED) error.value = String(e);
    return undefined;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="conflict-view selectable">
    <!-- A side deleted the file, and the other changed it: there are no conflicts in it
         to choose between, only whether to keep it. -->
    <template v-if="deleted">
      <p class="intro">{{ deleted.message }}</p>
      <div class="actions">
        <button v-if="deleted.keep" class="secondary-button" :disabled="busy" :title="`Keep the file from ${describe(named[deleted.keep])}`" @click="resolve(deleted.keep)">
          Keep File
        </button>
        <button class="secondary-button" :disabled="busy" @click="deleteFile">Delete File</button>
        <!-- What's on disk can be edited too, as to say why the other side deleted it,
             and kept as it is then. -->
        <template v-if="text != null">
          <button class="secondary-button" :disabled="busy" title="Edit it in the Files view" @click="emit('open-file', file.path)">Edit</button>
          <button class="secondary-button" :disabled="busy" title="Open it in your editor" @click="run('open_in_editor')">Open in Editor</button>
          <button class="primary-button" :disabled="busy" title="Stage the file as it is now" @click="markResolved">
            Mark as Resolved
          </button>
        </template>
      </div>
    </template>
    <template v-else>
      <p class="intro">
        This file has conflicting changes. Choose a side for each conflict below, keep one side for the whole file, or
        edit the file to combine them, then mark it as resolved.
      </p>

      <div class="actions">
        <button class="secondary-button" :disabled="busy" :title="`Keep the whole file from ${describe(named.current)}`" @click="useSide('current')">
          Use <span class="side-name">{{ named.current.label }}</span>
        </button>
        <button class="secondary-button" :disabled="busy" :title="`Keep the whole file from ${describe(named.incoming)}`" @click="useSide('incoming')">
          Use <span class="side-name">{{ named.incoming.label }}</span>
        </button>
        <button class="secondary-button" :disabled="busy" title="Edit it in the Files view" @click="emit('open-file', file.path)">Edit</button>
        <button class="secondary-button" :disabled="busy" title="Open it in your editor" @click="run('open_in_editor')">Open in Editor</button>
        <button class="primary-button" :disabled="busy" title="Stage the file as it is now" @click="markResolved">
          Mark as Resolved
        </button>
      </div>
    </template>

    <p v-if="error" class="error">{{ error }}</p>

    <template v-if="text != null">
      <p v-if="deleted" class="count">The file as it is now:</p>
      <p v-else-if="conflictCount" class="count">
        {{ conflictCount }} conflict{{ conflictCount === 1 ? "" : "s" }} ·
        <span class="swatch current" /><span class="side-name">{{ named.current.name }}</span>
        <span class="says">{{ named.current.says }}</span>
        <span class="swatch incoming" /><span class="side-name">{{ named.incoming.name }}</span>
        <span class="says">{{ named.incoming.says }}</span>
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
                  <button class="secondary-button" :disabled="busy" :title="`Keep the side from ${describe(named.current)}`" @click="resolveBlock(line.block, 'current')">
                    <span class="side-name">{{ named.current.name }}</span>
                  </button>
                  <button class="secondary-button" :disabled="busy" :title="`Keep the side from ${describe(named.incoming)}`" @click="resolveBlock(line.block, 'incoming')">
                    <span class="side-name">{{ named.incoming.name }}</span>
                  </button>
                  <button
                    class="secondary-button"
                    :disabled="busy"
                    :title="`Keep both, “${named.current.name}” first`"
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
  font-size: var(--font-md);
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
  font-size: var(--font-md);
}

.error {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--error-bg);
  color: var(--danger);
  font-size: var(--font-ui);
  white-space: pre-wrap;
}

.count {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 14px 0 6px;
  color: var(--text-tertiary);
  font-size: var(--font-sm);
}

.swatch {
  width: 10px;
  height: 10px;
  margin-left: 6px;
  border-radius: var(--radius-xs);
}

/* A branch's name can be long: it's cut short, and in full on hover. */
.side-name {
  display: inline-block;
  max-width: 16em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.count .side-name {
  color: var(--text-secondary);
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
  border-radius: var(--radius-md);
}

table {
  min-width: 100%;
  border-collapse: collapse;
  font-size: var(--font-sm);
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
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.block-label {
  margin-right: 6px;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

.block-bar button {
  padding: 2px 10px;
  font-size: var(--font-sm);
}

.marker .text {
  font-weight: 700;
  color: var(--text-secondary);
  background: var(--diff-hunk-bg);
}
</style>
