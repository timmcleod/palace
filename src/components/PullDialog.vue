<script setup>
import { computed, onMounted, ref } from "vue";
import { ChevronRight } from "lucide-vue-next";
import { closePullDialog } from "../lib/overlays.js";
import { focusDialog, submitOnEnter } from "../lib/dialogKeys.js";

// The Pull dialog: which remote branch to pull into the current branch, and whether
// to rebase onto it or merge it.
const props = defineProps({
  // { branch, from, remotes: [{ name, branches }], rebase, autostash }
  dialog: { type: Object, required: true },
});

const from = ref(props.dialog.from);
const rebase = ref(props.dialog.rebase);
const autostash = ref(props.dialog.autostash);
const showOptions = ref(!props.dialog.autostash);

const ready = computed(() => !!from.value);

const form = ref(null);
onMounted(() => focusDialog(form.value));

function submit() {
  if (!ready.value) return;
  closePullDialog({ from: from.value, rebase: rebase.value, autostash: autostash.value });
}

function onKeydown(event) {
  if (event.key === "Escape") closePullDialog(null);
}
</script>

<template>
  <div class="backdrop" @mousedown.self="closePullDialog(null)" @keydown="onKeydown">
    <form ref="form" class="dialog" @keydown="submitOnEnter" @submit.prevent="submit">
      <header>
        <img src="/palace.svg" alt="" class="app-icon" />
        <div>
          <h2>Pull</h2>
          <p>
            Fetches changes from the chosen remote branch and integrates them into your local
            <strong>{{ dialog.branch }}</strong> branch.
          </p>
        </div>
      </header>

      <div class="fields">
        <label for="pull-from">Remote Branch:</label>
        <select id="pull-from" v-model="from">
          <optgroup v-for="remote in dialog.remotes" :key="remote.name" :label="remote.name">
            <option v-for="branch in remote.branches" :key="branch" :value="`${remote.name}/${branch}`">
              {{ remote.name }}/{{ branch }}
            </option>
          </optgroup>
        </select>

        <span />
        <div>
          <label class="checkbox">
            <input v-model="rebase" type="checkbox" />
            Use Rebase Instead of Merge
          </label>
          <p class="hint">
            {{
              rebase
                ? `Rebases ${dialog.branch} onto the fetched commits, keeping history in a straight line.`
                : `Merges the fetched commits into ${dialog.branch}, with a merge commit if both sides have changed.`
            }}
          </p>
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
            Set aside uncommitted changes while pulling
          </label>
          <p class="hint">They're put back afterwards. Without this, a rebase won't start while you have changes.</p>
        </div>
      </div>

      <div class="buttons">
        <button type="button" class="secondary-button" @click="closePullDialog(null)">Cancel</button>
        <button type="submit" class="primary-button" :disabled="!ready">Pull</button>
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
  border-radius: var(--radius-2xl);
  background: var(--content-bg);
  box-shadow: var(--shadow-dialog);
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
  font-size: var(--font-2xl);
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
  border-radius: var(--radius-md);
  outline: none;
  background: var(--input-bg);
  font: inherit;
  color: var(--text-primary);
}

select:focus {
  border-color: var(--accent);
  box-shadow: var(--shadow-focus);
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
  accent-color: var(--accent-fill);
}

.hint {
  margin: 4px 0 0 24px;
  font-size: var(--font-ui);
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

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.buttons button {
  min-width: 110px;
}
</style>
