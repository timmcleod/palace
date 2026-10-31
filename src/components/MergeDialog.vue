<script setup>
import { computed, onMounted, ref } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { closeMergeDialog } from "../lib/overlays.js";
import { focusDialog, submitOnEnter } from "../lib/dialogKeys.js";

// The Merge dialog: which branch to merge into the current one, and how. With
// `rebase`, the Rebase dialog: which branch to rebase the current one onto.
const props = defineProps({
  // { head, branch, branches, remoteBranches, tags, rebase }
  dialog: { type: Object, required: true },
});

const branch = ref(props.dialog.branch);
const squash = ref(false);
const noFf = ref(false);
const commit = ref(true);
const autostash = ref(true);
const showOptions = ref(false);

const ready = computed(() => !!branch.value);

const form = ref(null);
onMounted(() => focusDialog(form.value));

function submit() {
  if (!ready.value) return;
  closeMergeDialog({
    branch: branch.value,
    options: props.dialog.rebase
      ? { autostash: autostash.value }
      : { squash: squash.value, no_ff: noFf.value, commit: commit.value, autostash: autostash.value },
  });
}

function onKeydown(event) {
  if (event.key === "Escape") closeMergeDialog(null);
}
</script>

<template>
  <div class="backdrop" @mousedown.self="closeMergeDialog(null)" @keydown="onKeydown">
    <form ref="form" class="dialog" @keydown="submitOnEnter" @submit.prevent="submit">
      <header>
        <img src="/palace.svg" alt="" class="app-icon" />
        <div>
          <template v-if="dialog.rebase">
            <h2>Rebase</h2>
            <p>
              Replays the commits of your current HEAD branch, <strong>{{ dialog.head }}</strong>, on top of the chosen
              branch. They get new hashes, so if they've already been pushed, you'll need to force push afterwards.
            </p>
          </template>
          <template v-else>
            <h2>Merge</h2>
            <p>
              Integrates the changes from the chosen branch into your current HEAD branch,
              <strong>{{ dialog.head }}</strong>.
            </p>
          </template>
        </div>
      </header>

      <div class="fields">
        <label for="merge-branch">{{ dialog.rebase ? "Onto:" : "Branch:" }}</label>
        <select id="merge-branch" v-model="branch">
          <optgroup v-if="dialog.branches.length" label="Branches">
            <option v-for="name in dialog.branches" :key="name" :value="name">{{ name }}</option>
          </optgroup>
          <optgroup v-if="dialog.remoteBranches.length" label="Remote Branches">
            <option v-for="name in dialog.remoteBranches" :key="name" :value="name">{{ name }}</option>
          </optgroup>
          <optgroup v-if="dialog.tags?.length" label="Tags">
            <option v-for="name in dialog.tags" :key="name" :value="name">{{ name }}</option>
          </optgroup>
        </select>

        <span v-if="!dialog.rebase" />
        <div v-if="!dialog.rebase" class="choices">
          <div>
            <label class="checkbox">
              <input v-model="squash" type="checkbox" />
              Squash Commits
            </label>
            <p class="hint">The changes are applied as a single commit.</p>
          </div>
          <div>
            <label class="checkbox" :class="{ disabled: squash }">
              <input v-model="noFf" type="checkbox" :disabled="squash" />
              Always Generate Merge Commit
            </label>
            <p class="hint">Generate a merge commit even if the merge resolved as a fast-forward.</p>
          </div>
          <div>
            <label class="checkbox" :class="{ disabled: !squash }">
              <input v-model="commit" type="checkbox" :disabled="!squash" />
              Directly Commit Merged Changes
            </label>
            <p class="hint">Without this option, changes are only applied to the working copy but not automatically committed.</p>
          </div>
        </div>
      </div>

      <div class="options">
        <button type="button" class="disclosure" @click="showOptions = !showOptions">
          <ChevronRight :size="15" class="chevron" :class="{ open: showOptions }" />
          Options
        </button>
        <div v-if="showOptions" class="option-list">
          <label class="checkbox">
            <input v-model="autostash" type="checkbox" />
            Set aside uncommitted changes while {{ dialog.rebase ? "rebasing" : "merging" }}
          </label>
          <p v-if="dialog.rebase" class="hint">They're put back afterwards. Without this, git won't rebase with uncommitted changes.</p>
          <p v-else class="hint">They're put back afterwards. Without this, git won't merge over changes to the same files.</p>
        </div>
      </div>

      <div class="buttons">
        <button type="button" class="secondary-button" @click="closeMergeDialog(null)">Cancel</button>
        <button type="submit" class="primary-button" :disabled="!ready">{{ dialog.rebase ? "Rebase" : "Merge" }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
  background: rgba(0, 0, 0, 0.25);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: min(540px, calc(100vw - 32px));
  padding: 26px 26px 20px;
  border-radius: 14px;
  background: var(--content-bg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
}

header {
  display: flex;
  gap: 18px;
}

.app-icon {
  width: 64px;
  height: 64px;
  flex-shrink: 0;
}

h2 {
  margin: 4px 0 6px;
  font-size: 16px;
  font-weight: 600;
}

header p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.45;
}

header strong {
  font-weight: 600;
  color: var(--text-primary);
}

.fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: 12px 12px;
}

.fields > label {
  text-align: right;
}

select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  color: var(--text-primary);
}

select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
}

.checkbox input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
}

.hint {
  margin: 4px 0 0 24px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.disclosure {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--text-primary);
}

.chevron {
  color: var(--text-tertiary);
  transition: transform 0.1s;
}

.chevron.open {
  transform: rotate(90deg);
}

.option-list {
  margin: 10px 0 0 19px;
}

.choices {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.checkbox.disabled {
  opacity: 0.5;
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.buttons button {
  min-width: 110px;
}
</style>
