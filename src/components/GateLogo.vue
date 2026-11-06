<script setup>
import { onBeforeUnmount, ref, watch } from "vue";

// Palace's icon, which answers Check for Updates: while it checks, a light runs around
// the gatehouse, as the spinner does around its gate; up to date, the archway glows
// for a moment; with an update waiting, it stays lit.
const props = defineProps({
  // updates.state (see updates.js).
  state: { type: String, default: "idle" },
  size: { type: Number, default: 38 },
});

// One lap of the light, and so the least it runs: a quick check would only flash it.
const LAP = 1200;

// Drawn over the icon's artwork, in its coordinates (see public/palace.svg).
const PLACE = "matrix(1.09181 0 0 1.09181 -74.30 33.79)";
const GATEHOUSE =
  "M385 588 L393.3 292.7 L454 278.3 L458.3 316 L500 304 L500.7 261.7 L535.5 252.7 L570.3 261.7 L571 304 L612.7 316 L617 278.3 L677.7 292.7 L686 588 L603 570 L603 444.2 A67.5 67.5 0 0 0 468 444.2 L468 570 Z";
const ARCH = "M468 571 L468 444.2 A67.5 67.5 0 0 1 603 444.2 L603 571 Z";

const tracing = ref(false);
// "glow" (up to date, once), "lit" (an update's waiting), or "".
const arch = ref("");
let tracedSince = 0;
let timer;

watch(
  () => props.state,
  (state, before) => {
    clearTimeout(timer);
    if (state === "checking" || state === "installing") {
      arch.value = "";
      tracing.value = true;
      tracedSince = performance.now();
      return;
    }
    // What the check found shows once the light's run at least a lap.
    const show = () => {
      tracing.value = false;
      if (state === "available") arch.value = "lit";
      else if (state === "none" && before === "checking") arch.value = "glow";
      else arch.value = "";
    };
    const left = tracing.value ? LAP - (performance.now() - tracedSince) : 0;
    if (left > 0) timer = setTimeout(show, left);
    else show();
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <span class="gate-logo" :style="{ width: `${size}px`, height: `${size}px`, '--lap': `${LAP}ms` }">
    <img src="/palace.svg" alt="" />
    <svg viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <radialGradient id="gate-logo-light" cx="535.5" cy="540" r="140" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#fff4cf" />
          <stop offset="0.6" stop-color="#ffd772" />
          <stop offset="1" stop-color="#f5b842" stop-opacity="0.6" />
        </radialGradient>
      </defs>
      <g :transform="PLACE">
        <path
          v-if="arch"
          :key="arch"
          :class="['arch', arch]"
          :d="ARCH"
          fill="url(#gate-logo-light)"
          @animationend="arch === 'glow' && (arch = '')"
        />
        <path v-if="tracing" class="trace" :d="GATEHOUSE" pathLength="100" />
      </g>
    </svg>
  </span>
</template>

<style scoped>
.gate-logo {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
}

.gate-logo img,
.gate-logo svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.gate-logo svg {
  overflow: visible;
  pointer-events: none;
}

.trace {
  fill: none;
  stroke: #fff6dc;
  stroke-width: 30;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 22 78;
  filter: drop-shadow(0 0 40px #ffd772);
  animation: trace var(--lap) linear infinite;
}

@keyframes trace {
  to {
    stroke-dashoffset: -100;
  }
}

/* Up to date: the archway lights, and goes dark again. */
.arch.glow {
  animation: glow 1.6s ease-out forwards;
}

@keyframes glow {
  0% {
    opacity: 0;
  }
  25% {
    opacity: 1;
    filter: drop-shadow(0 0 60px #ffd772);
  }
  100% {
    opacity: 0;
  }
}

/* An update's waiting: the archway stays lit, softly breathing. */
.arch.lit {
  animation: lit 2.4s ease-in-out infinite alternate;
}

@keyframes lit {
  from {
    opacity: 0.55;
  }
  to {
    opacity: 0.95;
    filter: drop-shadow(0 0 50px #ffd772);
  }
}

@media (prefers-reduced-motion: reduce) {
  .trace {
    animation-duration: 3s;
  }

  .arch.lit {
    animation: none;
    opacity: 0.8;
  }
}
</style>
