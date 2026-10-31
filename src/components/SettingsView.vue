<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { FileDiff, FolderDown, GitCommitHorizontal, Github, Palette, RefreshCw, Star } from "lucide-vue-next";
import { loadAvatars } from "../lib/avatars.js";
import { githubAccount as account, NEW_TOKEN_URL, signInWithToken, signOut as githubSignOut } from "../lib/github.js";
import { settings } from "../lib/settings.js";
import { cloneFolder } from "../lib/clone.js";
import { checkForUpdates, updates } from "../lib/updates.js";
import { PALACE_URL } from "../lib/star.js";

const props = defineProps({
  path: { type: String, required: true },
  name: { type: String, required: true },
});

// The page's sections, for the list beside them on wide windows.
const SECTIONS = [
  { id: "github", label: "GitHub", icon: Github },
  { id: "commits", label: "Commits", icon: GitCommitHorizontal },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "diffs", label: "Diffs", icon: FileDiff },
  { id: "repositories", label: "Repositories", icon: FolderDown },
  { id: "updates", label: "Updates", icon: RefreshCw },
];

const scroller = ref(null);
const current = ref(SECTIONS[0].id);

function show(id) {
  scroller.value?.querySelector(`#settings-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// The list marks the topmost section on screen.
let observer = null;
onMounted(() => {
  const visible = new Set();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.id.replace("settings-", "");
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      const first = SECTIONS.find((s) => visible.has(s.id));
      if (first) current.value = first.id;
    },
    { root: scroller.value, rootMargin: "-80px 0px -60% 0px" },
  );
  for (const s of SECTIONS) {
    const el = scroller.value.querySelector(`#settings-${s.id}`);
    if (el) observer.observe(el);
  }
});
onBeforeUnmount(() => observer?.disconnect());

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

const globalChanged = computed(
  () => identity.global_name !== saved.value.global_name || identity.global_email !== saved.value.global_email,
);
const localChanged = computed(
  () => identity.local_name !== saved.value.local_name || identity.local_email !== saved.value.local_email,
);

async function saveIdentity(global) {
  identityError.value = "";
  savedNote.value = "";
  const prefix = global ? "global" : "local";
  try {
    await invoke("set_git_identity", {
      path: props.path,
      global,
      name: identity[`${prefix}_name`],
      email: identity[`${prefix}_email`],
    });
    await loadIdentity();
    savedNote.value = prefix;
  } catch (e) {
    identityError.value = String(e);
  }
}

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
      return "Checking for updates…";
    case "none":
      return "Up to date";
    case "available":
      return `Palace ${updates.version} is available`;
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

// --- Choices ---------------------------------------------------------------------

const THEMES = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];
const DIFF_COLORS = [
  ["accessible", "Blue and orange", "Easy to tell apart with red-green color blindness"],
  ["classic", "Green and red", "The traditional colors"],
];
const TAB_SIZES = [2, 4, 8];
const LAYOUTS = [
  ["unified", "Unified"],
  ["split", "Side by Side"],
];
const FETCH_MINUTES = [5, 15, 30];

// The sample diff, shown with the diff settings as they are. A tab starts each
// indented line, so the tab width shows too.
const SAMPLE = {
  removed: [
    ["kw", "function "],
    ["fn", "greet"],
    ["", "(name) {"],
  ],
  added: [
    ["kw", "function "],
    ["fn", "greet"],
    ["", "(name = "],
    ["str", '"world"'],
    ["", ") {"],
  ],
  context: [
    ["", "\t"],
    ["kw", "return "],
    ["str", "`Hello, ${name}!`"],
    ["", ";"],
  ],
};
</script>

<template>
  <div ref="scroller" class="settings">
    <div class="layout">
      <nav class="section-list">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          :class="{ current: current === s.id }"
          @click="show(s.id)"
        >
          <component :is="s.icon" :size="15" /> {{ s.label }}
        </button>
      </nav>

      <div class="page">
        <header class="hero">
          <img src="/palace.svg" alt="" class="hero-icon" />
          <div class="hero-text">
            <h1>Palace</h1>
            <span class="hero-version">
              Version {{ updates.current || "…" }}
              <template v-if="updateStatus">
                ·
                <span :class="{ 'update-error': updates.state === 'error', fresh: updates.state === 'available' }">{{
                  updateStatus
                }}</span>
              </template>
            </span>
          </div>
          <div class="hero-actions">
            <button
              class="secondary-button"
              :disabled="updates.state === 'checking' || updates.state === 'installing'"
              @click="checkNow"
            >
              Check for Updates
            </button>
            <button class="secondary-button star" @click="openUrl(PALACE_URL)"><Star :size="14" /> Star on GitHub</button>
          </div>
        </header>

        <!-- GitHub -->
        <section id="settings-github">
          <h2>GitHub</h2>
          <div class="card">
            <div v-if="account" class="item">
              <img :src="account.avatar_url" alt="" class="account-avatar" />
              <div class="text">
                <div class="title">{{ account.name || account.login }}</div>
                <div class="desc">
                  Signed in as {{ account.login }}. Palace fetches, pulls and pushes with your token, private
                  repositories included. Git in the terminal isn't affected.
                </div>
              </div>
              <button class="secondary-button" @click="signOut">Sign Out</button>
            </div>
            <div v-else class="item">
              <div class="text">
                <div class="title">Not signed in</div>
                <div class="desc">
                  Sign in so Palace can fetch, pull and push your GitHub repositories, private ones included, without
                  setting up a login for git yourself.
                  <button class="link-button" @click="openUrl(NEW_TOKEN_URL)">Create a token</button>
                  with the scopes Palace needs (they're ticked for you), copy it, then sign in with it.
                </div>
              </div>
              <button class="primary-button" :disabled="signingIn" @click="signIn">
                {{ signingIn ? "Checking…" : "Sign In with Token…" }}
              </button>
            </div>
            <div class="item">
              <div class="text">
                <div class="title">Profile pictures</div>
                <div class="desc">
                  Look up commit authors on GitHub for repositories hosted there. Off keeps everything local, and
                  authors show their initials.
                </div>
              </div>
              <label class="switch"><input v-model="settings.githubAvatars" type="checkbox" /><span /></label>
            </div>
          </div>
          <p v-if="githubError" class="error">{{ githubError }}</p>
        </section>

        <!-- Commit identity -->
        <section id="settings-commits">
          <h2>Commits</h2>
          <div class="card">
            <div class="item column">
              <div class="text">
                <div class="title">Your name and email</div>
                <div class="desc">Recorded on your commits, in every repository unless one sets its own.</div>
              </div>
              <div class="identity">
                <input v-model="identity.global_name" type="text" placeholder="Your Name" spellcheck="false" />
                <input v-model="identity.global_email" type="text" placeholder="you@example.com" spellcheck="false" />
                <button class="secondary-button" :disabled="!globalChanged" @click="saveIdentity(true)">
                  {{ savedNote === "global" && !globalChanged ? "Saved" : "Save" }}
                </button>
              </div>
            </div>
            <div class="item column">
              <div class="text">
                <div class="title">For {{ name }} only</div>
                <div class="desc">Leave these empty to use the ones above, or use a work email for work projects.</div>
              </div>
              <div class="identity">
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
                <button class="secondary-button" :disabled="!localChanged" @click="saveIdentity(false)">
                  {{ savedNote === "local" && !localChanged ? "Saved" : "Save" }}
                </button>
              </div>
            </div>
          </div>
          <p v-if="identityError" class="error">{{ identityError }}</p>
        </section>

        <!-- Appearance -->
        <section id="settings-appearance">
          <h2>Appearance</h2>
          <div class="card">
            <div class="item column">
              <div class="text">
                <div class="title">Theme</div>
                <div class="desc">System follows your computer's light or dark appearance.</div>
              </div>
              <div class="themes">
                <button
                  v-for="[value, label] in THEMES"
                  :key="value"
                  class="theme"
                  :class="{ active: settings.theme === value }"
                  @click="settings.theme = value"
                >
                  <span class="mini-window" :class="value">
                    <i class="side" /><i class="bar" /><i class="stripe one" /><i class="stripe two" /><i class="stripe three" />
                  </span>
                  {{ label }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- Diffs -->
        <section id="settings-diffs">
          <h2>Diffs</h2>
          <div class="card">
            <div class="preview" :class="[settings.diffLayout, { plain: !settings.syntaxHighlighting }]">
              <template v-if="settings.diffLayout === 'split'">
                <div class="side-by-side">
                  <div class="half">
                    <div class="line removed">
                      <span class="num">1</span><span class="mark">−</span>
                      <span class="code"><span v-for="([kind, text], i) in SAMPLE.removed" :key="i" :class="kind">{{ text }}</span></span>
                    </div>
                    <div class="line">
                      <span class="num">2</span><span class="mark" />
                      <span class="code"><span v-for="([kind, text], i) in SAMPLE.context" :key="i" :class="kind">{{ text }}</span></span>
                    </div>
                  </div>
                  <div class="half">
                    <div class="line added">
                      <span class="num">1</span><span class="mark">+</span>
                      <span class="code"><span v-for="([kind, text], i) in SAMPLE.added" :key="i" :class="kind">{{ text }}</span></span>
                    </div>
                    <div class="line">
                      <span class="num">2</span><span class="mark" />
                      <span class="code"><span v-for="([kind, text], i) in SAMPLE.context" :key="i" :class="kind">{{ text }}</span></span>
                    </div>
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="line removed">
                  <span class="num">1</span><span class="num" /><span class="mark">−</span>
                  <span class="code"><span v-for="([kind, text], i) in SAMPLE.removed" :key="i" :class="kind">{{ text }}</span></span>
                </div>
                <div class="line added">
                  <span class="num" /><span class="num">1</span><span class="mark">+</span>
                  <span class="code"><span v-for="([kind, text], i) in SAMPLE.added" :key="i" :class="kind">{{ text }}</span></span>
                </div>
                <div class="line">
                  <span class="num">2</span><span class="num">2</span><span class="mark" />
                  <span class="code"><span v-for="([kind, text], i) in SAMPLE.context" :key="i" :class="kind">{{ text }}</span></span>
                </div>
              </template>
            </div>

            <div class="item column">
              <div class="text">
                <div class="title">Colors</div>
              </div>
              <div class="color-choices">
                <button
                  v-for="[value, label, detail] in DIFF_COLORS"
                  :key="value"
                  class="color-choice"
                  :class="{ active: settings.diffColors === value }"
                  @click="settings.diffColors = value"
                >
                  <span class="swatches" :class="value"><i class="added">+</i><i class="removed">−</i></span>
                  <span class="text">
                    <span class="title">{{ label }}</span>
                    <span class="desc">{{ detail }}</span>
                  </span>
                </button>
              </div>
            </div>
            <div class="item">
              <div class="text"><div class="title">Layout</div></div>
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
            </div>
            <div class="item">
              <div class="text"><div class="title">Tab width</div></div>
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
            <div class="item">
              <div class="text">
                <div class="title">Syntax highlighting</div>
                <div class="desc">In diffs and file contents.</div>
              </div>
              <label class="switch"><input v-model="settings.syntaxHighlighting" type="checkbox" /><span /></label>
            </div>
          </div>
        </section>

        <!-- Repositories -->
        <section id="settings-repositories">
          <h2>Repositories</h2>
          <div class="card">
            <div class="item">
              <div class="text">
                <div class="title">Clone into</div>
                <div class="desc">
                  <code class="mono folder">{{ cloneInto }}</code>
                  Repositories go in a folder for their owner, such as {{ cloneInto }}/acme/website. You can change it
                  for each clone.
                </div>
              </div>
              <button class="secondary-button" @click="chooseCloneFolder">Choose…</button>
            </div>
            <div class="item">
              <div class="text">
                <div class="title">Fetch in the background</div>
                <div class="desc">
                  Keeps the counts of commits to pull and push up to date. Fetching never changes your branches or
                  files.
                </div>
              </div>
              <label class="switch"><input v-model="settings.fetchInBackground" type="checkbox" /><span /></label>
            </div>
            <div class="item" :class="{ off: !settings.fetchInBackground }">
              <div class="text"><div class="title">Fetch every</div></div>
              <div class="segmented">
                <button
                  v-for="minutes in FETCH_MINUTES"
                  :key="minutes"
                  :class="{ active: settings.fetchMinutes === minutes }"
                  :disabled="!settings.fetchInBackground"
                  @click="settings.fetchMinutes = minutes"
                >
                  {{ minutes }} min
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- Updates -->
        <section id="settings-updates">
          <h2>Updates</h2>
          <div class="card">
            <div class="item">
              <div class="text">
                <div class="title">Check for updates automatically</div>
                <div class="desc">
                  When Palace starts, once a day, and when you come back to it after an hour or more. Updates are
                  installed only when you say so.
                </div>
              </div>
              <label class="switch"><input v-model="settings.checkForUpdates" type="checkbox" /><span /></label>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  --card-bg: color-mix(in srgb, var(--text-primary) 3%, var(--content-bg));

  flex: 1;
  overflow-y: auto;
  background: var(--content-bg);
}

/* The list of sections, beside the page when there's room for it. */
.layout {
  display: grid;
  grid-template-columns: 170px minmax(0, 680px);
  justify-content: center;
  gap: 32px;
  padding: 28px 28px 48px;
}

.section-list {
  position: sticky;
  top: 28px;
  display: flex;
  flex-direction: column;
  align-self: start;
  gap: 2px;
  margin-top: 96px;
}

.section-list button {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  border: 0;
  border-radius: 7px;
  background: none;
  font: inherit;
  text-align: left;
  color: var(--text-secondary);
}

.section-list button:hover {
  background: var(--row-hover);
}

.section-list button.current {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

@media (max-width: 1180px) {
  .layout {
    grid-template-columns: minmax(0, 680px);
  }

  .section-list {
    display: none;
  }
}

/* --- Header ---------------------------------------------------------------------- */

.hero {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 60%),
    var(--card-bg);
}

.hero-icon {
  width: 64px;
  height: 64px;
  filter: drop-shadow(0 4px 10px color-mix(in srgb, var(--accent) 35%, transparent));
}

.hero-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 180px;
}

h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.hero-version {
  color: var(--text-secondary);
  font-size: 13px;
}

.hero-version .fresh {
  font-weight: 600;
  color: var(--accent);
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.hero-actions .secondary-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--content-bg);
}

.hero-actions .star svg {
  color: #e3a008;
}

/* --- Sections and cards ---------------------------------------------------------- */

section {
  margin-top: 28px;
  scroll-margin-top: 20px;
}

h2 {
  margin: 0 0 8px 4px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}

.card {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg);
}

/* A setting: what it is on the left, its control on the right, or below it in a
   column. */
.item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
}

.item + .item,
.preview + .item {
  border-top: 1px solid var(--border);
}

.item.column {
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}

.item.off {
  opacity: 0.55;
}

.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.title {
  font-weight: 550;
  color: var(--text-primary);
}

.desc {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.item > .secondary-button,
.item > .primary-button {
  flex-shrink: 0;
  padding: 6px 14px;
}

.account-avatar {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--content-bg), 0 0 0 3px var(--border);
}

.folder {
  display: block;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-primary);
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

/* --- Controls -------------------------------------------------------------------- */

.switch {
  position: relative;
  flex-shrink: 0;
  width: 38px;
  height: 22px;
}

.switch input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.switch span {
  position: absolute;
  inset: 0;
  border-radius: 11px;
  background: color-mix(in srgb, var(--text-primary) 22%, transparent);
  transition: background 0.18s;
}

.switch span::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform 0.18s;
}

.switch input:checked + span {
  background: var(--accent);
}

.switch input:checked + span::after {
  transform: translateX(16px);
}

.switch input:focus-visible + span {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent);
}

.segmented {
  display: inline-flex;
  flex-shrink: 0;
  padding: 2px;
  border-radius: 8px;
  background: var(--toolbar-group-bg);
}

.segmented button {
  min-width: 52px;
  padding: 4px 12px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  color: var(--text-primary);
}

.segmented button.active {
  background: var(--content-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}

.identity {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) auto;
  gap: 8px;
}

.identity .secondary-button {
  min-width: 70px;
  padding: 6px 14px;
}

@media (max-width: 760px) {
  .identity {
    grid-template-columns: minmax(0, 1fr);
  }

  .identity .secondary-button {
    justify-self: start;
  }
}

input[type="text"] {
  width: 100%;
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

/* --- Theme previews: small windows in each theme's colors, whatever the current
   one. ---------------------------------------------------------------------------- */

.themes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 150px));
  gap: 16px;
}

.theme {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--text-secondary);
}

.theme.active {
  font-weight: 600;
  color: var(--text-primary);
}

.mini-window {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  border-radius: 9px;
  box-shadow: 0 0 0 1px var(--border);
  transition: box-shadow 0.15s;
}

.theme:hover .mini-window {
  box-shadow: 0 0 0 1px var(--border), 0 4px 14px rgba(0, 0, 0, 0.12);
}

.theme.active .mini-window {
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 5px color-mix(in srgb, var(--accent) 25%, transparent);
}

.mini-window.light {
  --w-bg: #ffffff;
  --w-side: #f4f4f4;
  --w-line: #e3e3e3;
}

.mini-window.dark {
  --w-bg: #131a26;
  --w-side: #212a3a;
  --w-line: #364257;
}

.mini-window.light,
.mini-window.dark {
  background: var(--w-bg);
}

/* Half light, half dark. */
.mini-window.system {
  --w-side: #f4f4f4;
  --w-line: #d9d9d9;
  background: linear-gradient(90deg, #ffffff 50%, #131a26 50%);
}

.mini-window i {
  position: absolute;
  display: block;
}

.mini-window .side {
  inset: 0 auto 0 0;
  width: 28%;
  background: var(--w-side);
}

.mini-window .bar {
  top: 10%;
  left: 34%;
  width: 40%;
  height: 8%;
  border-radius: 3px;
  background: #1f7cf2;
}

.mini-window .stripe {
  left: 34%;
  height: 6%;
  border-radius: 3px;
  background: var(--w-line);
}

.mini-window.system .stripe {
  background: rgba(128, 128, 128, 0.35);
}

.mini-window .one {
  top: 32%;
  width: 56%;
}

.mini-window .two {
  top: 46%;
  width: 46%;
}

.mini-window .three {
  top: 60%;
  width: 52%;
}

/* --- Diff colors ----------------------------------------------------------------- */

.color-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 760px) {
  .color-choices {
    grid-template-columns: minmax(0, 1fr);
  }
}

.color-choice {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--content-bg);
  font: inherit;
  text-align: left;
}

.color-choice.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
}

.swatches {
  display: inline-flex;
  flex-shrink: 0;
  gap: 4px;
}

.swatches i {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-style: normal;
  font-weight: 700;
  color: #fff;
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

/* --- The sample diff, in the diff colors as they are now. ------------------------ */

.preview {
  padding: 10px 0;
  overflow-x: auto;
  background: var(--content-bg);
  font-family: ui-monospace, "SF Mono", Menlo, "Ubuntu Mono", monospace;
  font-size: 12px;
  line-height: 1.7;
  tab-size: var(--tab-size);
}

.side-by-side {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.half + .half {
  border-left: 1px solid var(--border);
}

.line {
  display: flex;
  white-space: pre;
}

.line.added {
  background: var(--diff-added-bg);
}

.line.removed {
  background: var(--diff-removed-bg);
}

.num {
  flex-shrink: 0;
  width: 32px;
  padding-right: 8px;
  text-align: right;
  color: var(--text-tertiary);
}

.mark {
  flex-shrink: 0;
  width: 16px;
  color: var(--text-tertiary);
}

.added .mark {
  color: var(--diff-added-text);
}

.removed .mark {
  color: var(--diff-removed-text);
}

.code {
  padding-right: 12px;
  color: var(--text-primary);
}

.code .kw {
  color: var(--syntax-keyword);
}

.code .fn {
  color: var(--syntax-title);
}

.code .str {
  color: var(--syntax-string);
}

.plain .code span {
  color: inherit;
}

/* --- Messages -------------------------------------------------------------------- */

.update-error {
  color: var(--danger);
  overflow-wrap: anywhere;
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
</style>
