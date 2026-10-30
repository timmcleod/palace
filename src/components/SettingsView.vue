<script setup>
import { computed, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadAvatars } from "../lib/avatars.js";
import { githubAccount as account, NEW_TOKEN_URL, signInWithToken, signOut as githubSignOut } from "../lib/github.js";
import { settings } from "../lib/settings.js";
import { cloneFolder } from "../lib/clone.js";
import { checkForUpdates, updates } from "../lib/updates.js";
import { PALACE_URL } from "../lib/star.js";
import { open } from "@tauri-apps/plugin-dialog";

const props = defineProps({
  path: { type: String, required: true },
  name: { type: String, required: true },
});

// --- Commit identity -------------------------------------------------------------

const identity = reactive({ global_name: "", global_email: "", local_name: "", local_email: "" });
// What's saved, to tell whether there's anything to save.
const saved = ref({ ...identity });
const identityError = ref("");
const savedNote = ref("");

async function loadIdentity() {
  identityError.value = "";
  try {
    Object.assign(identity, await invoke("git_identity", { path: props.path }));
    saved.value = { ...identity };
  } catch (e) {
    identityError.value = String(e);
  }
}

watch(() => props.path, loadIdentity, { immediate: true });

// --- GitHub ----------------------------------------------------------------------

const githubError = ref("");
const signingIn = ref(false);

async function signIn() {
  githubError.value = "";
  signingIn.value = true;
  githubError.value = (await signInWithToken()) ?? "";
  signingIn.value = false;
  // Private repositories' authors can now be looked up too.
  if (account.value) loadAvatars(props.path);
}

async function signOut() {
  githubError.value = "";
  try {
    await githubSignOut();
  } catch (e) {
    githubError.value = String(e);
  }
}

// --- Cloning ---------------------------------------------------------------------

const cloneInto = ref("");
watch(() => settings.cloneFolder, async () => (cloneInto.value = await cloneFolder()), { immediate: true });

async function chooseCloneFolder() {
  const folder = await open({ directory: true, multiple: false, title: "Clone Into", defaultPath: cloneInto.value });
  if (folder) settings.cloneFolder = folder;
}

// --- Updates ---------------------------------------------------------------------

const updateStatus = computed(() => {
  switch (updates.state) {
    case "checking":
      return "Checking…";
    case "none":
      return "Palace is up to date.";
    case "available":
      return `Palace ${updates.version} is available.`;
    case "installing":
      return `Installing Palace ${updates.version}…`;
    case "error":
      return `Couldn't check for updates: ${updates.error}`;
    default:
      return "";
  }
});

function checkNow() {
  updates.dismissed = false;
  checkForUpdates();
}

const THEMES = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const TAB_SIZES = [2, 4, 8];
const LAYOUTS = [
  ["unified", "Unified"],
  ["split", "Side by Side"],
];
const FETCH_MINUTES = [5, 15, 30];
</script>

<template>
  <div class="settings">
    <div class="page">
      <h1>Settings</h1>

      <section>
        <h2>Commit Identity</h2>
        <p class="note">The name and email recorded on your commits.</p>

        <div class="fields">
          <span class="label">All repositories:</span>
          <div class="stack">
            <input v-model="identity.global_name" type="text" placeholder="Your Name" spellcheck="false" />
            <input v-model="identity.global_email" type="text" placeholder="you@example.com" spellcheck="false" />
            <div class="row">
              <button class="secondary-button" :disabled="!globalChanged" @click="saveIdentity(true)">Save</button>
              <span v-if="savedNote === 'global' && !globalChanged" class="dim">Saved</span>
            </div>
          </div>

          <span class="label">{{ name }} only:</span>
          <div class="stack">
            <input
              v-model="identity.local_name"
              type="text"
              :placeholder="identity.global_name ? `Uses ${identity.global_name}` : 'Your Name'"
              spellcheck="false"
            />
            <input
              v-model="identity.local_email"
              type="text"
              :placeholder="identity.global_email ? `Uses ${identity.global_email}` : 'you@example.com'"
              spellcheck="false"
            />
            <div class="row">
              <button class="secondary-button" :disabled="!localChanged" @click="saveIdentity(false)">Save</button>
              <span v-if="savedNote === 'local' && !localChanged" class="dim">Saved</span>
              <span v-else class="dim">Leave empty to use the one above, e.g. a work email for work projects.</span>
            </div>
          </div>
        </div>
        <p v-if="identityError" class="error">{{ identityError }}</p>
      </section>

      <section>
        <h2>Cloning</h2>
        <div class="fields">
          <span class="label">Clone into:</span>
          <div class="stack">
            <div class="row folder-row">
              <code class="mono folder">{{ cloneInto }}</code>
              <button class="secondary-button" @click="chooseCloneFolder">Choose…</button>
            </div>
            <span class="dim small-note">
              Repositories go in a folder for their owner, e.g. {{ cloneInto }}/acme/website. You can change it for
              each clone.
            </span>
          </div>
        </div>
      </section>

      <section>
        <h2>Fetching</h2>
        <label class="choice">
          <input v-model="settings.fetchInBackground" type="checkbox" />
          Fetch in the background
        </label>
        <p class="note indent">
          Keeps the counts of commits to pull and push up to date. Fetching never changes your branches or files.
        </p>
        <div class="fields indent">
          <span class="label">Every:</span>
          <div class="segmented">
            <button
              v-for="minutes in FETCH_MINUTES"
              :key="minutes"
              :class="{ active: settings.fetchMinutes === minutes }"
              :disabled="!settings.fetchInBackground"
              @click="settings.fetchMinutes = minutes"
            >
              {{ minutes }} minutes
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2>Updates</h2>
        <p class="note">
          You have Palace {{ updates.current || "…" }}. Like it?
          <button class="link-button" @click="openUrl(PALACE_URL)">Star it on GitHub</button>
        </p>
        <label class="choice">
          <input v-model="settings.checkForUpdates" type="checkbox" />
          Check for updates automatically
        </label>
        <p class="note indent">When Palace starts, then once a day. Updates are installed only when you say so.</p>
        <div class="row update-row">
          <button class="secondary-button" :disabled="updates.state === 'checking' || updates.state === 'installing'" @click="checkNow">
            Check Now
          </button>
          <span :class="updates.state === 'error' ? 'update-error' : 'dim'">{{ updateStatus }}</span>
        </div>
      </section>

      <section>
        <h2>Appearance</h2>
        <div class="fields">
          <span class="label">Theme:</span>
          <div class="segmented">
            <button
              v-for="[value, label] in THEMES"
              :key="value"
              :class="{ active: settings.theme === value }"
              @click="settings.theme = value"
            >
              {{ label }}
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2>Diffs</h2>
        <div class="fields">
          <span class="label top">Colors:</span>
          <div class="stack">
            <label class="choice">
              <input v-model="settings.diffColors" type="radio" value="accessible" />
              <span class="swatches accessible"><i class="added" /><i class="removed" /></span>
              <span>Blue and orange <span class="dim">— easy to tell apart with red-green color blindness</span></span>
            </label>
            <label class="choice">
              <input v-model="settings.diffColors" type="radio" value="classic" />
              <span class="swatches classic"><i class="added" /><i class="removed" /></span>
              Green and red
            </label>
          </div>

          <span class="label">Layout:</span>
          <div class="segmented">
            <button
              v-for="[value, label] in LAYOUTS"
              :key="value"
              :class="{ active: settings.diffLayout === value }"
              @click="settings.diffLayout = value"
            >
              {{ label }}
            </button>
          </div>

          <span class="label">Tab width:</span>
          <div class="segmented">
            <button
              v-for="size in TAB_SIZES"
              :key="size"
              :class="{ active: settings.tabSize === size }"
              @click="settings.tabSize = size"
            >
              {{ size }}
            </button>
          </div>
        </div>
      </section>

      <section>
        <h2>GitHub</h2>
        <div v-if="account" class="account">
          <img :src="account.avatar_url" alt="" class="account-avatar" />
          <div class="account-names">
            <strong>{{ account.name || account.login }}</strong>
            <span class="dim">{{ account.login }}</span>
          </div>
          <button class="secondary-button" @click="signOut">Sign Out</button>
        </div>
        <p v-if="account" class="note">
          Palace signs in to GitHub with your token to fetch, pull and push, including private repositories. Git in
          the terminal isn't affected.
        </p>
        <template v-else>
          <p class="note">
            Sign in so Palace can fetch, pull and push your GitHub repositories, including private ones, without setting
            up a login for git yourself.
          </p>
          <ol class="steps">
            <li>
              <button class="link-button" @click="openUrl(NEW_TOKEN_URL)">Create a token on GitHub</button>
              with the scopes Palace needs (they're ticked for you), and copy it.
            </li>
            <li>
              <button class="secondary-button" :disabled="signingIn" @click="signIn">
                {{ signingIn ? "Checking…" : "Sign In with Token…" }}
              </button>
            </li>
          </ol>
        </template>
        <p v-if="githubError" class="error">{{ githubError }}</p>

        <label class="choice avatars-choice">
          <input v-model="settings.githubAvatars" type="checkbox" />
          Show authors' GitHub profile pictures
        </label>
        <p class="note indent">
          Looks up commit authors on GitHub for repositories hosted there. Turn this off to keep everything local;
          authors then show their initials.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  flex: 1;
  overflow-y: auto;
  background: var(--content-bg);
}

.page {
  max-width: 640px;
  margin: 0 auto;
  padding: 28px 28px 40px;
}

h1 {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
}

section {
  padding: 20px 0;
  border-bottom: 1px solid var(--border);
}

section:last-child {
  border-bottom: 0;
}

h2 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.note {
  margin: 0 0 14px;
  color: var(--text-secondary);
}

.note.indent {
  margin: 6px 0 0 26px;
}

.fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  gap: 14px 12px;
  margin-top: 12px;
}

.label {
  align-self: start;
  padding-top: 7px;
  text-align: right;
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}

.row .secondary-button {
  padding: 4px 14px;
}

input[type="text"] {
  width: 100%;
  max-width: 360px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  color: var(--text-primary);
}

input[type="text"]:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}

.segmented {
  display: inline-flex;
  justify-self: start;
  padding: 2px;
  border-radius: 7px;
  background: var(--toolbar-group-bg);
}

.segmented button {
  min-width: 64px;
  padding: 4px 12px;
  border: 0;
  border-radius: 5px;
  background: none;
  font: inherit;
  color: var(--text-primary);
}

.segmented button.active {
  background: var(--row-selected);
}

.segmented button:disabled {
  opacity: 0.5;
}

.fields.indent {
  margin-left: 26px;
}

.choice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.choice input,
.swatches {
  flex-shrink: 0;
}

.choice input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
}

.swatches {
  display: inline-flex;
  gap: 3px;
}

.swatches i {
  width: 14px;
  height: 14px;
  border-radius: 3px;
}

/* The swatches show both schemes whichever is chosen. */
.accessible .added {
  background: #3b8ff6;
}

.accessible .removed {
  background: #e8873a;
}

.classic .added {
  background: #2da44e;
}

.classic .removed {
  background: #e5484d;
}

.folder-row {
  font-size: 13px;
}

.folder {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.small-note {
  font-size: 12.5px;
}

.update-row {
  margin-top: 12px;
  font-size: 13px;
}

.update-error {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.account {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 10px;
}

.account-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
}

.account-names {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 0 6px;
  padding-left: 20px;
  color: var(--text-secondary);
}

.steps .secondary-button {
  padding: 4px 14px;
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

.avatars-choice {
  margin-top: 16px;
}

.error {
  margin: 12px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--error-bg);
  color: var(--danger);
  font-size: 12.5px;
  white-space: pre-wrap;
}
</style>
