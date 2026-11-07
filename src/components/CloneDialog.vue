<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { repoFromUrl, suggestedLocation } from "../lib/clone.js";
import { closeCloneDialog } from "../lib/overlays.js";
import { submitOnEnter } from "../lib/dialogKeys.js";

// The Clone dialog: a repository's URL, and the folder to clone it into.
const props = defineProps({
  // { url, folder }
  dialog: { type: Object, required: true },
});

const url = ref(props.dialog.url ?? "");
const location = ref(suggestedLocation(props.dialog.folder, url.value));
// Once the location is edited by hand, changing the URL leaves it alone.
let locationEdited = false;

watch(url, (value) => {
  if (!locationEdited) location.value = suggestedLocation(props.dialog.folder, value);
});

const urlInput = ref(null);
const cloneButton = ref(null);
// With the URL already given, Enter clones straight away.
onMounted(async () => {
  await nextTick();
  (url.value ? cloneButton : urlInput).value?.focus();
});

// Picking a folder clones into a new folder inside it, named after the repository.
async function choose() {
  const folder = await open({ directory: true, multiple: false, title: "Clone Into" });
  if (!folder) return;
  const name = repoFromUrl(url.value)?.name;
  location.value = name ? `${folder}/${name}` : folder;
  locationEdited = true;
}

const ready = computed(() => url.value.trim() && location.value.trim().startsWith("/"));

function submit() {
  if (!ready.value) return;
  closeCloneDialog({ url: url.value.trim(), location: location.value.trim().replace(/\/+$/, "") });
}

function onKeydown(event) {
  if (event.key === "Escape") closeCloneDialog(null);
}
</script>

<template>
  <div class="backdrop" @mousedown.self="closeCloneDialog(null)" @keydown="onKeydown">
    <form class="dialog" @keydown="submitOnEnter" @submit.prevent="submit">
      <header>
        <img src="/palace.svg" alt="" class="app-icon" />
        <div>
          <h2>Clone Repository</h2>
          <p>Copies a repository to your computer and opens it.</p>
        </div>
      </header>

      <div class="fields">
        <label for="clone-url">URL:</label>
        <input
          id="clone-url"
          ref="urlInput"
          v-model="url"
          type="text"
          spellcheck="false"
          placeholder="https://github.com/owner/repository.git"
        />

        <label for="clone-location">Location:</label>
        <div>
          <div class="location">
            <input
              id="clone-location"
              v-model="location"
              type="text"
              spellcheck="false"
              @input="locationEdited = true"
            />
            <button type="button" class="secondary-button" @click="choose">Choose…</button>
          </div>
          <p class="hint">The folder is created if it doesn't exist. It must be empty if it does.</p>
        </div>
      </div>

      <div class="buttons">
        <button type="button" class="secondary-button" @click="closeCloneDialog(null)">Cancel</button>
        <button ref="cloneButton" type="submit" class="primary-button" :disabled="!ready">Clone</button>
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
  gap: 22px;
  width: min(580px, calc(100vw - 32px));
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

.fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}

.fields > label {
  padding-top: 7px;
  text-align: right;
}

.location {
  display: flex;
  gap: 8px;
}

input {
  flex: 1;
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--input-bg);
  font: inherit;
  color: var(--text-primary);
}

input:focus {
  border-color: var(--accent);
  box-shadow: var(--shadow-focus);
}

.location .secondary-button {
  flex-shrink: 0;
  padding: 6px 12px;
}

.hint {
  margin: 5px 2px 0;
  font-size: var(--font-ui);
  color: var(--text-tertiary);
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
