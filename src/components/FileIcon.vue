<script setup>
import { computed } from "vue";
import { File, FileSymlink, Folder, FolderGit2, FolderOpen } from "lucide-vue-next";
import { fileIconUrl } from "../lib/fileIcons.js";
import { settings } from "../lib/settings.js";

// A file or folder's icon: colorful, by its name, or a plain outline when Settings says
// so, or until the colorful ones have loaded.
const props = defineProps({
  // Its name, or path.
  name: { type: String, required: true },
  // "file", "dir", "link" or "submodule".
  kind: { type: String, default: "file" },
  // A folder that's open.
  open: { type: Boolean, default: false },
  size: { type: Number, default: 16 },
});

const url = computed(() => (settings.fileIcons ? fileIconUrl(props.name, props.kind, props.open) : null));

const PLAIN = { file: File, link: FileSymlink, submodule: FolderGit2 };
const plain = computed(() => (props.kind === "dir" ? (props.open ? FolderOpen : Folder) : PLAIN[props.kind] ?? File));
</script>

<template>
  <img v-if="url" :src="url" alt="" class="file-icon" :width="size" :height="size" draggable="false" />
  <component :is="plain" v-else :size="size" :stroke-width="1.5" class="file-icon plain" :class="{ folder: kind === 'dir' }" />
</template>

<style scoped>
.file-icon {
  flex-shrink: 0;
}

img.file-icon {
  -webkit-user-select: none;
  user-select: none;
}

.plain {
  color: var(--icon);
}

.plain.folder {
  color: var(--accent);
}
</style>
