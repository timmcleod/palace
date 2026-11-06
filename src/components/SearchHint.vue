<script setup>
// "Type / to search", with the key drawn as one, as on GitHub: shown over a toolbar
// search while it's empty and not being typed in, as a placeholder can't show the key.
// It follows the search's input, whose own placeholder is a space so the page can tell
// when it's empty (see .search-hint in styles.css).
defineProps({
  // What's searched, if not files and commits: "issues".
  what: { type: String, default: "" },
});
</script>

<template>
  <span class="search-hint" aria-hidden="true">Type <kbd>/</kbd> to search{{ what ? ` ${what}` : "" }}</span>
</template>
