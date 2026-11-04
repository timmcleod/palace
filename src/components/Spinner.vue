<script setup>
// For something that's loading, usually beside a few words saying what: a light running
// around the outline of Palace's gate, as in its icon.
defineProps({ size: { type: Number, default: 15 } });

const GATE = "M3 14.5 V7.5 A5 5 0 0 1 13 7.5 V14.5 Z";
</script>

<template>
  <svg class="spinner" :width="size" :height="size" viewBox="0 0 16 16" aria-hidden="true">
    <path class="track" :d="GATE" />
    <path class="trace" :d="GATE" pathLength="100" />
  </svg>
</template>

<style scoped>
.spinner {
  flex-shrink: 0;
  overflow: visible;
}

path {
  fill: none;
  stroke: currentColor;
  stroke-linejoin: round;
}

.track {
  stroke-width: 1.6;
  opacity: 0.2;
}

.trace {
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-dasharray: 26 74;
  animation: trace 1.3s linear infinite;
}

@keyframes trace {
  to {
    stroke-dashoffset: -100;
  }
}

@media (prefers-reduced-motion: reduce) {
  .trace {
    animation-duration: 3s;
  }
}
</style>
