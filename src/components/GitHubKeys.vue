<script setup>
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleAlert, KeyRound, Laptop } from "lucide-vue-next";
import { NEW_TOKEN_URL } from "../lib/github.js";
import { askConfirm, openForm } from "../lib/overlays.js";
import Spinner from "./Spinner.vue";

// The SSH keys on the signed-in GitHub account, and the ones on this computer that
// could be added.
const props = defineProps({
  // The token's scopes, or null for a fine-grained token (which doesn't list them).
  scopes: { type: Array, default: null },
});

const keys = ref(null);
const local = ref([]);
const error = ref("");
const busy = ref(false);

const KEY_SCOPES = ["admin:public_key", "write:public_key", "read:public_key"];
const canRead = computed(() => !props.scopes || props.scopes.some((s) => KEY_SCOPES.includes(s)));
const canWrite = computed(() => !props.scopes || props.scopes.some((s) => s === "admin:public_key" || s === "write:public_key"));
const canDelete = computed(() => !props.scopes || props.scopes.includes("admin:public_key"));

async function load() {
  error.value = "";
  local.value = await invoke("local_ssh_keys").catch(() => []);
  if (!canRead.value) return;
  try {
    keys.value = await invoke("github_keys");
  } catch (e) {
    // GitHub answers "Not Found" when the token isn't allowed to see keys.
    error.value = String(e).includes("Not Found") ? "Your token isn't allowed to see your SSH keys." : String(e);
  }
}

onMounted(load);

// Keys on this computer that aren't on GitHub yet.
const notAdded = computed(() => local.value.filter((l) => !keys.value?.some((k) => k.key === l.key)));
const onThisComputer = (key) => local.value.some((l) => l.key === key.key);

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
// Enough of the key to tell keys apart: its type and the end of its data.
const shortKey = (key) => {
  const [kind, data = ""] = key.split(" ");
  return `${kind} …${data.slice(-16)}`;
};

async function run(work) {
  busy.value = true;
  error.value = "";
  try {
    await work();
    keys.value = await invoke("github_keys");
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

function addLocal(key) {
  const title = key.comment || key.path.split("/").pop();
  run(() => invoke("github_add_key", { title, key: key.key }));
}

async function addPasted() {
  const values = await openForm({
    title: "Add SSH Key",
    message: "Paste a public key, the contents of a .pub file. Never paste a private key.",
    fields: [
      { key: "title", label: "Title", type: "text", placeholder: "Work laptop" },
      { key: "key", label: "Key", type: "text", placeholder: "ssh-ed25519 AAAA…" },
    ],
    confirmLabel: "Add Key",
  });
  if (values) run(() => invoke("github_add_key", { title: values.title, key: values.key }));
}

async function remove(key) {
  const ok = await askConfirm({
    title: "Remove SSH Key",
    message: `Remove “${key.title}” from your GitHub account?\n\nAnything using this key won't be able to reach GitHub any more. The key itself stays on whichever computer has it.`,
    confirmLabel: "Remove",
    danger: true,
  });
  if (ok) run(() => invoke("github_delete_key", { id: key.id }));
}
</script>

<template>
  <div class="keys">
    <div v-if="!canRead || (scopes && !canWrite)" class="notice">
      <CircleAlert :size="16" />
      <div>
        <p>
          Your token {{ canRead ? "can see your SSH keys but not add them" : "isn't allowed to manage SSH keys" }}. To
          do that here, create a new token with the <strong>admin:public_key</strong> scope and sign in with it.
        </p>
        <button class="link-button" @click="openUrl(NEW_TOKEN_URL)">Create a token on GitHub</button>
      </div>
    </div>

    <p v-if="error" class="message error"><CircleAlert :size="15" /> {{ error }}</p>

    <template v-if="canRead">
      <div class="list-bar">
        <span>SSH KEYS</span>
        <button class="secondary-button" :disabled="busy || !canWrite" @click="addPasted">Add Key…</button>
      </div>
      <p v-if="!keys && !error" class="message dim"><Spinner /> Loading…</p>
      <p v-else-if="keys && !keys.length" class="message dim">There are no SSH keys on your GitHub account.</p>
      <div v-for="key in keys ?? []" :key="key.id" class="key">
        <KeyRound :size="22" :stroke-width="1.5" class="key-icon" />
        <div class="key-text">
          <div class="key-line">
            <strong>{{ key.title }}</strong>
            <span v-if="onThisComputer(key)" class="badge"><Laptop :size="12" /> this computer</span>
          </div>
          <div class="dim mono small">{{ shortKey(key.key) }}</div>
          <div v-if="key.created_at" class="dim small">Added {{ dateFormat.format(new Date(key.created_at)) }}</div>
        </div>
        <button class="secondary-button" :disabled="busy || !canDelete" @click="remove(key)">Remove</button>
      </div>
    </template>

    <template v-if="local.length && canRead && keys">
      <div class="list-bar">
        <span>ON THIS COMPUTER</span>
      </div>
      <p v-if="!notAdded.length" class="message dim">Every SSH key on this computer is on your GitHub account.</p>
      <div v-for="key in notAdded" :key="key.path" class="key">
        <Laptop :size="22" :stroke-width="1.5" class="key-icon" />
        <div class="key-text">
          <strong>{{ key.path.replace(/^.*\/\.ssh\//, "~/.ssh/") }}</strong>
          <div class="dim mono small">{{ shortKey(key.key) }}{{ key.comment ? ` · ${key.comment}` : "" }}</div>
        </div>
        <button class="secondary-button" :disabled="busy || !canWrite" @click="addLocal(key)">Add to GitHub</button>
      </div>
    </template>
    <p v-else-if="!local.length" class="message dim">
      There are no SSH keys in ~/.ssh on this computer. Create one in a terminal with
      <code class="mono">ssh-keygen -t ed25519</code>.
    </p>
  </div>
</template>

<style scoped>
.keys {
  flex: 1;
  overflow-y: auto;
}

.notice {
  display: flex;
  gap: 10px;
  margin: 16px 18px 4px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--banner-warning-bg);
  color: var(--text-primary);
}

.notice svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.notice p {
  margin: 0 0 6px;
  line-height: 1.45;
}

.list-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 18px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.list-bar .secondary-button {
  padding: 3px 12px;
  letter-spacing: normal;
}

.key {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
}

.key-icon {
  flex-shrink: 0;
  color: var(--icon);
}

.key-text {
  flex: 1;
  min-width: 0;
}

.key-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--pill-bg);
  font-size: 11.5px;
  color: var(--text-secondary);
}

.small {
  font-size: 12px;
}

.key .secondary-button {
  flex-shrink: 0;
  padding: 4px 14px;
}

.message {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 18px;
}

.message.error {
  color: var(--danger);
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}
</style>
