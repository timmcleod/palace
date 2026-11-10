<script setup>
import { computed, ref, shallowRef } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, ExternalLink, Search, X } from "lucide-vue-next";

// The open-source projects Palace is made with (see scripts/acknowledgments.mjs),
// behind a button: their names in columns, families of packages, such as
// @codemirror/* or tauri-*, as one, and a project's license on clicking it. Loaded
// the first time they're shown.
const data = shallowRef(null);
const shown = ref(false);

function toggle() {
  shown.value = !shown.value;
  if (shown.value && !data.value) {
    import("../lib/acknowledgments.json")
      .then((module) => (data.value = module.default))
      .catch(() => (data.value = { groups: [], texts: [] }));
  }
}

const query = ref("");
// The entry open below its list, as "group:name", and the package shown in a family.
const selected = ref(null);
const member = ref(null);

// "@codemirror/view" is in @codemirror, "tauri-runtime" and "tauri" in tauri.
const familyOf = (name) => (name.startsWith("@") ? name.split("/")[0] : name.split(/[-_]/)[0]);

// Each package once, with every version of it that's included, and families of two or
// more as one entry.
function entries(packages) {
  const byName = new Map();
  for (const p of packages) {
    if (!byName.has(p.name)) byName.set(p.name, { name: p.name, versions: [] });
    byName.get(p.name).versions.push(p);
  }
  const byFamily = new Map();
  for (const project of byName.values()) {
    const family = familyOf(project.name);
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(project);
  }
  return [...byFamily.entries()]
    .map(([family, members]) => (members.length > 1 ? { name: family, members } : members[0]))
    .sort((a, b) => a.name.replace(/^@/, "").localeCompare(b.name.replace(/^@/, "")));
}

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (data.value?.groups ?? []).map((group) => {
    const packages = q ? group.packages.filter((p) => p.name.toLowerCase().includes(q)) : group.packages;
    return { name: group.name, entries: entries(packages) };
  });
});

const total = computed(() => new Set((data.value?.groups ?? []).flatMap((g) => g.packages.map((p) => p.name))).size);
const keyOf = (group, entry) => `${group.name}:${entry.name}`;

function select(group, entry) {
  const key = keyOf(group, entry);
  selected.value = selected.value === key ? null : key;
  member.value = null;
}

// What the card below the list shows the license of: the project, or the package
// chosen in the family.
const licensed = (entry) => (entry.members ? entry.members.find((m) => m.name === member.value) : entry);
const textsOf = (project) => [...new Set(project.versions.flatMap((v) => v.texts))];

const TITLES = { App: "The app", Backend: "Behind it" };
</script>

<template>
  <div class="acknowledgments">
    <p class="intro">Palace is made with open-source projects. Thank you to everyone who works on them.</p>
    <button class="secondary-button toggle" @click="toggle">
      <component :is="shown ? ChevronDown : ChevronRight" :size="14" />
      {{ shown ? "Hide the projects" : "Show the projects and their licenses" }}
    </button>

    <div v-if="shown" class="projects">
      <p v-if="!data" class="none">Loading…</p>
      <template v-else>
        <div class="search">
          <Search :size="14" />
          <input v-model="query" type="text" :placeholder="`Find one of ${total.toLocaleString()} packages`" spellcheck="false" />
        </div>
        <template v-for="group in groups" :key="group.name">
          <div v-if="group.entries.length" class="group">
            <div class="group-name">{{ TITLES[group.name] ?? group.name }}</div>
            <div class="names">
              <button
                v-for="entry in group.entries"
                :key="entry.name"
                class="name"
                :class="{ selected: selected === keyOf(group, entry) }"
                :title="entry.members ? entry.members.map((m) => m.name).join(', ') : entry.versions.map((v) => `${v.name} ${v.version}`).join(', ')"
                @click="select(group, entry)"
              >
                {{ entry.name }}<span v-if="entry.members" class="count"> {{ entry.members.length }}</span>
              </button>
            </div>
            <template v-for="entry in group.entries" :key="entry.name">
              <div v-if="selected === keyOf(group, entry)" class="details">
                <div class="details-header">
                  <span class="details-name">{{ entry.name }}</span>
                  <span v-if="entry.members" class="details-meta">{{ entry.members.length }} packages</span>
                  <span class="spacer" />
                  <button class="icon-button small" title="Close" @click="selected = null"><X :size="13" /></button>
                </div>
                <div v-if="entry.members" class="members">
                  <button
                    v-for="m in entry.members"
                    :key="m.name"
                    class="member"
                    :class="{ selected: member === m.name }"
                    @click="member = member === m.name ? null : m.name"
                  >
                    {{ m.name }}
                  </button>
                </div>
                <template v-if="licensed(entry)">
                  <div class="license-line">
                    <span v-if="entry.members" class="details-name">{{ licensed(entry).name }}</span>
                    <span class="details-meta">
                      {{ licensed(entry).versions.map((v) => v.version).join(", ") }} ·
                      {{ licensed(entry).versions[0].license || "See its license" }}
                    </span>
                    <button v-if="licensed(entry).versions[0].url" class="link" @click="openUrl(licensed(entry).versions[0].url)">
                      <ExternalLink :size="12" /> Project
                    </button>
                  </div>
                  <pre v-for="i in textsOf(licensed(entry))" :key="i" class="text">{{ data.texts[i] }}</pre>
                  <p v-if="!textsOf(licensed(entry)).length" class="none">
                    Licensed {{ licensed(entry).versions[0].license }}. Its package doesn't include the license's text.
                  </p>
                </template>
                <p v-else class="none">Click one to see its license.</p>
              </div>
            </template>
          </div>
        </template>
        <p v-if="query && groups.every((g) => !g.entries.length)" class="none">Nothing matches.</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.intro {
  margin: 0 0 10px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px 4px 8px;
  font-size: var(--font-ui);
}

.projects {
  margin-top: 16px;
}

.search {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 16px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--content-bg);
  color: var(--icon);
}

.search input {
  flex: 1;
  min-width: 0;
  height: 30px;
  border: 0;
  outline: none;
  background: none;
  font: inherit;
  color: var(--text-primary);
}

.group + .group {
  margin-top: 20px;
}

.group-name {
  margin: 0 0 6px 2px;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

/* As many columns as fit, filled top to bottom. */
.names {
  columns: 4 140px;
  column-gap: 12px;
}

.name {
  display: block;
  width: 100%;
  padding: 1px 6px;
  overflow: hidden;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  font-size: var(--font-sm);
  line-height: 1.6;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  break-inside: avoid;
}

.count {
  color: var(--text-tertiary);
}

.name:hover,
.member:hover {
  background: var(--row-hover);
  color: var(--text-primary);
}

.name.selected,
.member.selected {
  background: var(--accent-fill);
  color: white;
}

.name.selected .count {
  color: inherit;
  opacity: 0.75;
}

.details {
  margin-top: 10px;
  padding: 10px 12px 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background: var(--card-bg);
}

.details-header,
.license-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: var(--font-ui);
}

.details-name {
  font-weight: 600;
}

.details-meta {
  color: var(--text-tertiary);
}

.spacer {
  flex: 1;
}

.members {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 4px;
  margin-bottom: 10px;
}

.member {
  padding: 1px 7px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  font: inherit;
  font-size: var(--font-sm);
  line-height: 1.6;
  color: var(--text-secondary);
}

.link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
}

.link:hover {
  text-decoration: underline;
}

.text {
  max-height: 220px;
  margin: 0 0 8px;
  padding: 10px 12px;
  overflow: auto;
  border-radius: var(--radius-md);
  background: var(--content-bg);
  font-family: ui-monospace, Menlo, monospace;
  font-size: var(--font-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  color: var(--text-secondary);
}

.none {
  margin: 0 0 8px;
  font-size: var(--font-ui);
  color: var(--text-tertiary);
}
</style>
