<script setup>
import { computed } from "vue";

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
    {{ initials }}
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
}
</style>
