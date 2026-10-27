<script setup>
import { computed, ref, watch } from "vue";
import { avatars, sizedAvatar } from "../lib/avatars.js";

const props = defineProps({
  name: { type: String, required: true },
  email: { type: String, default: "" },
  size: { type: Number, default: 32 },
});

const initials = computed(() => {
  const parts = props.name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : "")).toUpperCase();
});

// The author's GitHub picture, if they have one; initials until it loads, or if it
// can't (offline, say).
const picture = computed(() => {
  const url = avatars[props.email.trim().toLowerCase()];
  return url ? sizedAvatar(url, props.size) : null;
});
const loaded = ref(false);
watch(picture, () => (loaded.value = false));

// A stable colour per author, so the same person is recognisable everywhere.
const hue = computed(() => {
  let hash = 0;
  for (const char of (props.email || props.name).toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % 360;
});
</script>

<template>
  <div
    class="avatar"
    :style="{ '--hue': hue, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.375)}px` }"
    :title="email ? `${name} <${email}>` : name"
  >
    <span v-if="!loaded">{{ initials }}</span>
    <img v-if="picture" v-show="loaded" :src="picture" alt="" draggable="false" @load="loaded = true" @error="loaded = false" />
  </div>
</template>

<style scoped>
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 50%;
  background: hsl(var(--hue) 55% 88%);
  color: hsl(var(--hue) 45% 32%);
  font-weight: 600;
  overflow: hidden;
}

img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
