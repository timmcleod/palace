<script setup>
import { computed, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadAvatars } from "../lib/avatars.js";
import { openForm } from "../lib/overlays.js";
import { settings } from "../lib/settings.js";

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

const account = ref(null);
const githubError = ref("");
const signingIn = ref(false);

invoke("github_account").then((a) => (account.value = a));

// A new classic token with the scopes Palace needs: private repositories, workflow
// files (pushing changes to .github/workflows), and organisations.
const NEW_TOKEN_URL = "https://github.com/settings/tokens/new?description=Palace&scopes=repo,workflow,read:org";

async function signIn() {
  const values = await openForm({
    title: "Sign In to GitHub",
    message:
      "Paste a personal access token. Palace keeps it in your system keyring and uses it to fetch, pull and push your GitHub repositories.",
    fields: [{ key: "token", label: "Token", type: "password", placeholder: "ghp_…" }],
    confirmLabel: "Sign In",
  });
  if (!values) return;
  githubError.value = "";
  signingIn.value = true;
  try {
    account.value = await invoke("github_sign_in", { token: values.token });
    // Private repositories' authors can now be looked up too.
    loadAvatars(props.path);
  } catch (e) {
    githubError.value = String(e);
  } finally {
    signingIn.value = false;
  }
}

async function signOut() {
  githubError.value = "";
  try {
    await invoke("github_sign_out");
    account.value = null;
  } catch (e) {
    githubError.value = String(e);
  }
}

const THEMES = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const TAB_SIZES = [2, 4, 8];
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
          <span class="label top">Colours:</span>
          <div class="stack">
            <label class="choice">
              <input v-model="settings.diffColors" type="radio" value="accessible" />
              <span class="swatches accessible"><i class="added" /><i class="removed" /></span>
              <span>Blue and orange <span class="dim">— easy to tell apart with red-green colour blindness</span></span>
            </label>
            <label class="choice">
              <input v-model="settings.diffColors" type="radio" value="classic" />
              <span class="swatches classic"><i class="added" /><i class="removed" /></span>
              Green and red
            </label>
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
              with the <strong>repo</strong>, <strong>workflow</strong> and <strong>read:org</strong> scopes (they're
              ticked for you), and copy it.
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
