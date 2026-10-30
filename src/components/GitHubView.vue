<script setup>
import { computed, ref, shallowReactive, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, CircleAlert, ExternalLink, Folder, GitFork, Github, Lock, Search } from "lucide-vue-next";
import { githubAccount, NEW_TOKEN_URL, signInWithToken } from "../lib/github.js";
import { openForm } from "../lib/overlays.js";
import GitHubAccount from "./GitHubAccount.vue";
import Spinner from "./Spinner.vue";
import GitHubKeys from "./GitHubKeys.vue";

// Your GitHub account, organizations and collaborators on the left, the chosen one's
// repositories on the right, each ready to clone.
defineProps({
  // Shown on its own from the welcome screen, with a way back.
  standalone: { type: Boolean, default: false },
});
const emit = defineEmits(["clone", "back"]);

const owners = ref(null);
const ownersError = ref("");
const selected = ref(null);
const query = ref("");
// Repositories by owner login, once loaded: { repos } or { error }.
const listings = shallowReactive(new Map());
// Your own account has tabs: "repositories", "keys" and "account".
const tab = ref("repositories");
// What the token may do, for the Public Keys and Account tabs; undefined until known.
const scopes = ref(undefined);

async function loadScopes() {
  scopes.value = await invoke("github_scopes").catch(() => null);
}

async function loadOwners() {
  ownersError.value = "";
  owners.value = null;
  try {
    owners.value = await invoke("github_owners");
    selected.value ??= owners.value[0]?.login ?? null;
  } catch (e) {
    ownersError.value = String(e);
  }
}

watch(
  () => githubAccount.value?.login,
  (login) => {
    listings.clear();
    selected.value = null;
    tab.value = "repositories";
    scopes.value = undefined;
    if (login) {
      loadOwners();
      loadScopes();
    }
  },
  { immediate: true },
);

const owner = computed(() => owners.value?.find((o) => o.login === selected.value) ?? null);

async function loadRepos(o) {
  try {
    listings.set(o.login, { repos: await invoke("github_repos", { owner: o.login, kind: o.kind }) });
  } catch (e) {
    listings.set(o.login, { error: String(e) });
  }
}

watch(owner, (o) => {
  query.value = "";
  if (o?.kind !== "me") tab.value = "repositories";
  if (o && !listings.has(o.login)) loadRepos(o);
});

// Repositories can be created for yourself and in organizations, not for collaborators.
const createError = ref("");

async function createRepository() {
  const o = owner.value;
  const values = await openForm({
    title: `Create Repository${o.kind === "org" ? ` in ${o.login}` : ""}`,
    message: "Creates an empty repository on GitHub. Names can use letters, numbers, hyphens, underscores and dots.",
    fields: [
      { key: "name", label: "Name", type: "text", placeholder: "my-project" },
      { key: "description", label: "Description (optional)", type: "text", optional: true },
      { key: "private", label: "Private: only people you choose can see it", type: "checkbox", value: true },
      { key: "readme", label: "Add a README, so it starts with a first commit", type: "checkbox", value: true },
      { key: "clone", label: "Clone it to this computer", type: "checkbox", value: true },
    ],
    confirmLabel: "Create Repository",
  });
  if (!values) return;
  createError.value = "";
  try {
    const repo = await invoke("github_create_repo", {
      owner: o.login,
      kind: o.kind,
      name: values.name,
      description: values.description,
      private: values.private,
      readme: values.readme,
    });
    await loadRepos(o);
    if (values.clone) emit("clone", repo.clone_url);
  } catch (e) {
    createError.value = String(e);
  }
}

const listing = computed(() => (owner.value ? listings.get(owner.value.login) : null));
const repos = computed(() => {
  const all = listing.value?.repos ?? [];
  const q = query.value.trim().toLowerCase();
  return q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)) : all;
});

const GROUPS = { me: "", org: "Organizations", collaborator: "Collaborators" };
const groupStart = (i) => i > 0 && owners.value[i - 1].kind !== owners.value[i].kind;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
const updated = (repo) => (repo.pushed_at ? `updated ${dateFormat.format(new Date(repo.pushed_at))}` : "");

// A picture that can't load (offline, say) leaves just the circle behind it.
const hideImage = (event) => (event.target.style.visibility = "hidden");

const signInError = ref("");
async function signIn() {
  signInError.value = (await signInWithToken()) ?? "";
}
</script>

<template>
  <div class="github-view">
    <aside class="owners">
      <div class="owners-header">
        <button v-if="standalone" class="icon-button small" title="Back" @click="emit('back')">
          <ArrowLeft :size="16" />
        </button>
        <span>GitHub</span>
      </div>

      <template v-if="githubAccount">
        <p v-if="ownersError" class="message error"><CircleAlert :size="15" /> {{ ownersError }}</p>
        <p v-else-if="!owners" class="message dim"><Spinner /> Loading…</p>
        <template v-for="(o, i) in owners ?? []" :key="o.login">
          <div v-if="groupStart(i)" class="group-label">{{ GROUPS[o.kind] }}</div>
          <div class="owner" :class="{ selected: o.login === selected }" @click="selected = o.login">
            <img :src="o.avatar_url" alt="" class="avatar" @error="hideImage" />
            <div class="names">
              <strong>{{ o.login }}</strong>
              <span v-if="o.name" class="dim">{{ o.name }}</span>
            </div>
          </div>
        </template>
      </template>

      <div class="owners-footer">
        <button class="secondary-button" @click="emit('clone', '')">Clone from URL…</button>
      </div>
    </aside>

    <section class="repos">
      <div v-if="!githubAccount" class="sign-in">
        <Github :size="40" :stroke-width="1.25" />
        <h2>Sign in to GitHub</h2>
        <p>
          See your repositories and your organizations', private ones included, and clone them in a click. Palace signs
          in with a personal access token.
        </p>
        <ol>
          <li>
            <button class="link-button" @click="openUrl(NEW_TOKEN_URL)">Create a token on GitHub</button> with the
            scopes already ticked, and copy it.
          </li>
          <li><button class="primary-button" @click="signIn">Sign In with Token…</button></li>
        </ol>
        <p v-if="signInError" class="message error"><CircleAlert :size="15" /> {{ signInError }}</p>
        <p class="dim">Or clone any repository by its URL, from any host, with Clone from URL.</p>
      </div>

      <template v-else-if="owner">
        <header class="repos-header">
          <img :key="owner.login" :src="owner.avatar_url" alt="" class="avatar large" @error="hideImage" />
          <div class="names">
            <span class="title">
              <strong>{{ owner.login }}</strong>
              <button class="icon-button small" title="Open on GitHub" @click="openUrl(`https://github.com/${owner.login}`)">
                <ExternalLink :size="14" />
              </button>
            </span>
            <span class="dim">
              {{ owner.name ?? "" }}{{ owner.name && listing?.repos ? " · " : ""
              }}{{ listing?.repos ? `${listing.repos.length} ${listing.repos.length === 1 ? "repository" : "repositories"}` : "" }}
            </span>
          </div>
          <div v-if="owner.kind === 'me'" class="segmented">
            <button :class="{ active: tab === 'repositories' }" @click="tab = 'repositories'">Repositories</button>
            <button :class="{ active: tab === 'keys' }" @click="tab = 'keys'">Public Keys</button>
            <button :class="{ active: tab === 'account' }" @click="tab = 'account'">Account</button>
          </div>
        </header>

        <GitHubKeys v-if="tab === 'keys' && scopes !== undefined" :scopes="scopes" />
        <GitHubAccount v-else-if="tab === 'account' && scopes !== undefined" :scopes="scopes" @token-changed="loadScopes" />
        <p v-else-if="tab !== 'repositories'" class="message dim"><Spinner /> Loading…</p>

        <template v-else>
        <div class="list-bar">
          <span>REPOSITORIES</span>
          <button v-if="owner.kind !== 'collaborator'" class="secondary-button" @click="createRepository">
            Create Repository…
          </button>
          <label class="toolbar-search filter">
            <Search :size="15" :stroke-width="1.5" />
            <input v-model="query" placeholder="Filter Repositories" spellcheck="false" @keydown.esc="query = ''" />
          </label>
        </div>

        <p v-if="createError" class="message error"><CircleAlert :size="15" /> {{ createError }}</p>
        <p v-if="listing?.error" class="message error"><CircleAlert :size="15" /> {{ listing.error }}</p>
        <p v-else-if="!listing" class="message dim"><Spinner /> Loading repositories…</p>
        <p v-else-if="!repos.length" class="message dim">
          {{ query.trim() ? `No repositories match “${query.trim()}”.` : "No repositories." }}
        </p>

        <div class="repo-list">
          <div v-for="repo in repos" :key="repo.full_name" class="repo">
            <span class="lock"><Lock v-if="repo.private" :size="15" title="Private" /></span>
            <Folder :size="30" :stroke-width="1.25" class="folder" />
            <div class="repo-text">
              <div class="repo-line">
                <button class="repo-name" title="Open on GitHub" @click="openUrl(repo.html_url)">{{ repo.name }}</button>
                <span v-if="repo.fork" class="fork" title="A fork"><GitFork :size="12" /> fork</span>
                <span class="dim small">{{ updated(repo) }}</span>
              </div>
              <div class="description" :class="{ dim: !repo.description }">
                {{ repo.description || "No description given" }}
              </div>
            </div>
            <button class="secondary-button clone" @click="emit('clone', repo.clone_url)">Clone</button>
          </div>
        </div>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.github-view {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  min-height: 0;
  height: 100%;
}

.owners {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px;
  border-right: 1px solid var(--border);
  background: var(--sidebar-bg);
}

.owners-header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
}

.group-label {
  margin: 14px 8px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
}

.owner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 8px;
}

.owner:hover {
  background: var(--row-hover);
}

.owner.selected {
  background: var(--row-selected);
}

.avatar {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--pill-bg);
}

.avatar.large {
  width: 44px;
  height: 44px;
}

.names {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
}

.names strong,
.names span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.owners-footer {
  margin-top: auto;
  padding: 12px 0;
}

.owners-footer .secondary-button {
  width: 100%;
}

.repos {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--content-bg);
}

.repos-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
}

.repos-header .names {
  flex: 1;
}

.title {
  display: flex;
  align-items: center;
  gap: 4px;
}

.filter {
  width: 220px;
  flex-shrink: 1;
  min-width: 120px;
  margin-left: auto;
}

.list-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.list-bar .secondary-button {
  padding: 3px 12px;
  letter-spacing: normal;
}

.list-bar .filter {
  height: 30px;
  letter-spacing: normal;
}

.segmented {
  display: flex;
  flex-shrink: 0;
  padding: 2px;
  border-radius: 7px;
  background: var(--toolbar-group-bg);
}

.segmented button {
  padding: 3px 12px;
  border: 0;
  border-radius: 5px;
  background: none;
  font: inherit;
  color: var(--text-primary);
}

.segmented button.active {
  background: var(--row-selected);
}

.repo-list {
  flex: 1;
  overflow-y: auto;
}

.repo {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px 12px 10px;
  border-bottom: 1px solid var(--border);
}

.lock {
  display: flex;
  justify-content: center;
  width: 18px;
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.folder {
  flex-shrink: 0;
  color: var(--icon);
}

.repo-text {
  flex: 1;
  min-width: 0;
}

.repo-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.repo-name {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
}

.repo-name:hover {
  text-decoration: underline;
}

.fork {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.small {
  font-size: 12px;
  white-space: nowrap;
}

.description {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.description.dim {
  color: var(--text-tertiary);
}

.clone {
  flex-shrink: 0;
  padding: 4px 16px;
}

.message {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 16px 18px;
}

.owners .message {
  margin: 8px 6px;
}

.message.error {
  color: var(--danger);
}

.sign-in {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 440px;
  margin: 70px auto 0;
  padding: 0 20px;
  text-align: center;
  color: var(--text-secondary);
}

.sign-in svg {
  color: var(--text-primary);
}

.sign-in h2 {
  margin: 10px 0 6px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.sign-in p {
  margin: 0 0 14px;
  line-height: 1.45;
}

.sign-in ol {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 0 16px;
  padding-left: 20px;
  text-align: left;
}

.sign-in .dim {
  font-size: 12.5px;
  color: var(--text-tertiary);
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
