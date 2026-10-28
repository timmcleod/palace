<script setup>
import { ref } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, CircleAlert, ExternalLink, Minus } from "lucide-vue-next";
import { githubAccount, NEW_TOKEN_URL, SCOPES, signInWithToken, signOut } from "../lib/github.js";
import { askConfirm } from "../lib/overlays.js";

// Who Palace is signed in as, what the token allows, and signing out.
defineProps({
  // The token's scopes, or null for a fine-grained token (which doesn't list them).
  scopes: { type: Array, default: null },
});
const emit = defineEmits(["token-changed"]);

const error = ref("");

async function replaceToken() {
  error.value = (await signInWithToken()) ?? "";
  if (!error.value) emit("token-changed");
}

async function confirmSignOut() {
  const ok = await askConfirm({
    title: "Sign Out of GitHub",
    message:
      "Sign out of GitHub in Palace?\n\nPalace forgets the token. Fetching, pulling and pushing then use whatever login git has of its own, if any.",
    confirmLabel: "Sign Out",
    danger: true,
  });
  if (!ok) return;
  try {
    await signOut();
  } catch (e) {
    error.value = String(e);
  }
}
</script>

<template>
  <div class="account">
    <section class="who">
      <img :src="githubAccount.avatar_url" alt="" class="avatar" />
      <div>
        <h2>{{ githubAccount.name || githubAccount.login }}</h2>
        <button class="link-button" @click="openUrl(`https://github.com/${githubAccount.login}`)">
          github.com/{{ githubAccount.login }} <ExternalLink :size="12" />
        </button>
      </div>
    </section>

    <section>
      <h3>Personal Access Token</h3>
      <p class="note">
        Palace signs in to GitHub with this token, kept in your system keyring. Git in the terminal isn't affected.
      </p>
      <ul v-if="scopes" class="scopes">
        <li v-for="scope in SCOPES" :key="scope.name" :class="{ missing: !scopes.includes(scope.name) }">
          <Check v-if="scopes.includes(scope.name)" :size="15" class="yes" />
          <Minus v-else :size="15" class="no" />
          <span><code class="mono">{{ scope.name }}</code> — {{ scope.use }}</span>
        </li>
      </ul>
      <p v-else class="note">This is a fine-grained token: what it can do is set on GitHub, per repository.</p>
      <p v-if="scopes && SCOPES.some((s) => !scopes.includes(s.name))" class="note">
        To allow everything,
        <button class="link-button" @click="openUrl(NEW_TOKEN_URL)">create a new token</button>
        and replace this one with it.
      </p>
      <div class="buttons">
        <button class="secondary-button" @click="replaceToken">Replace Token…</button>
        <button class="secondary-button danger" @click="confirmSignOut">Sign Out…</button>
      </div>
      <p v-if="error" class="error"><CircleAlert :size="15" /> {{ error }}</p>
    </section>
  </div>
</template>

<style scoped>
.account {
  flex: 1;
  overflow-y: auto;
  padding: 8px 24px 24px;
}

section {
  max-width: 620px;
  padding: 18px 0;
  border-bottom: 1px solid var(--border);
}

section:last-child {
  border-bottom: 0;
}

.who {
  display: flex;
  align-items: center;
  gap: 16px;
}

.avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--pill-bg);
}

h2 {
  margin: 0 0 2px;
  font-size: 18px;
  font-weight: 600;
}

h3 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.note {
  margin: 0 0 12px;
  color: var(--text-secondary);
  line-height: 1.45;
}

.scopes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}

.scopes li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.scopes svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.scopes .missing {
  color: var(--text-tertiary);
}

.yes {
  color: var(--accent);
}

.buttons {
  display: flex;
  gap: 10px;
}

.secondary-button.danger {
  color: var(--danger);
}

.link-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

.error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 0;
  color: var(--danger);
}
</style>
