import { computed, nextTick, ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { issueFilters } from "./issues.js";

// Suggests open issues while "#" is typed, so "Fixes #42" is quick to write: the
// number, or words from the title, narrow the list, and picking one puts in its
// number. With `people`, "@" suggests the repository's people the same way. The
// newest open issues are loaded the first time, and again after a few minutes.

const FRESH_FOR = 3 * 60 * 1000;
const loaded = new Map();

function openIssues({ owner, repo }) {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = loaded.get(key);
  if (!cached || Date.now() - cached.at > FRESH_FOR) {
    const issues = invoke("github_issues", { owner, repo, filters: "is:open", page: 1 })
      .then((page) => page.issues)
      .catch(() => {
        loaded.delete(key);
        return [];
      });
    loaded.set(key, { at: Date.now(), issues });
  }
  return loaded.get(key).issues;
}

// "#" (or "@") at the start or after a space or bracket, then what's typed since.
const TYPING = /(?:^|[\s([])([#@])([\w-]*)$/;

/**
 * `repo()` gives the GitHub repository ({ owner, repo }), or null for none. The field
 * calls onInput(event, setValue) as it changes and onKeydown(event) first on each key,
 * which returns true when it handled the key. Items are { key, kind ("issue" or
 * "person"), label, detail, avatar }.
 */
export function useIssueSuggestions(repo, { people = false } = {}) {
  const issues = shallowRef([]);
  const persons = shallowRef([]);
  const trigger = ref("#");
  const query = ref("");
  const index = ref(0);
  // Where the list goes: above the field, or below it near the top of the window.
  const position = ref(null);
  let field = null;
  let setValue = null;
  let start = 0;

  const items = computed(() => {
    if (!position.value) return [];
    const q = query.value.toLowerCase();
    if (trigger.value === "@") {
      return persons.value
        .filter((p) => p.login.toLowerCase().includes(q))
        .slice(0, 8)
        .map((p) => ({ key: p.login, kind: "person", label: p.login, detail: "", avatar: p.avatar_url, insert: `@${p.login}` }));
    }
    const matches = /^\d+$/.test(q)
      ? issues.value.filter((i) => String(i.number).startsWith(q))
      : issues.value.filter((i) => i.title.toLowerCase().includes(q));
    return matches
      .slice(0, 8)
      .map((i) => ({ key: i.number, kind: "issue", label: `#${i.number}`, detail: i.title, insert: `#${i.number}` }));
  });

  async function onInput(event, set) {
    const r = repo();
    const el = event.target;
    const typed = el.value.slice(0, el.selectionStart).match(TYPING);
    if (!r || !typed || (typed[1] === "@" && !people)) {
      close();
      return;
    }
    field = el;
    setValue = set;
    trigger.value = typed[1];
    start = el.selectionStart - typed[2].length - 1;
    query.value = typed[2];
    index.value = 0;
    const rect = el.getBoundingClientRect();
    const where = rect.top > 280 ? { bottom: `${window.innerHeight - rect.top + 4}px` } : { top: `${rect.bottom + 4}px` };
    position.value = { left: `${rect.left}px`, width: `${rect.width}px`, ...where };
    if (typed[1] === "@") persons.value = (await issueFilters(r)).assignees;
    else issues.value = await openIssues(r);
  }

  function pick(item) {
    const value = field.value;
    const end = start + 1 + query.value.length;
    const inserted = `${item.insert} `;
    setValue(value.slice(0, start) + inserted + value.slice(end));
    const caret = start + inserted.length;
    const el = field;
    close();
    nextTick(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function onKeydown(event) {
    if (!items.value.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      index.value = (index.value + step + items.value.length) % items.value.length;
    } else if ((event.key === "Enter" && !event.ctrlKey && !event.metaKey) || event.key === "Tab") {
      pick(items.value[index.value]);
    } else if (event.key === "Escape") {
      close();
      event.stopPropagation();
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  function close() {
    position.value = null;
  }

  return { items, index, position, onInput, onKeydown, pick, close };
}
