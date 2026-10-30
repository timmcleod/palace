<script setup>
import { LoaderCircle } from "lucide-vue-next";

// A turning circle for something that's loading, usually beside a few words saying what.
defineProps({ size: { type: Number, default: 15 } });
</script>

<template>
  <LoaderCircle :size="size" :stroke-width="2" class="spinner" aria-hidden="true" />
</template>

<style scoped>
.spinner {
  flex-shrink: 0;
  animation: turn 0.8s linear infinite;
}

@keyframes turn {
  to {
    transform: rotate(360deg);
  }
}
</style>
