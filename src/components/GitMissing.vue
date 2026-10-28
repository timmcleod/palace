<script setup>
import { computed, ref } from "vue";
import { Check, CircleAlert, Copy } from "lucide-vue-next";

// Shown instead of the app when git isn't installed, or is too old to use.
const props = defineProps({
  // { version, minimum, supported } from git_check.
  status: { type: Object, required: true },
  checking: { type: Boolean, default: false },
});
const emit = defineEmits(["recheck"]);

// apt installs git if it's missing and updates it if it's old.
const command = "sudo apt install git";

const title = computed(() => (props.status.version ? "Palace needs a newer Git" : "Palace needs Git"));
const message = computed(() =>
  props.status.version
    ? `Git ${props.status.version} is installed, but Palace needs ${props.status.minimum} or newer. Update it in a terminal:`
    : "Palace uses Git to make every change to your repositories, and it isn't installed. Install it in a terminal:",
);

const copied = ref(false);
async function copy() {
  await navigator.clipboard.writeText(command);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <main class="git-missing">
    <div class="card">
      <CircleAlert :size="40" :stroke-width="1.25" class="icon" />
      <h1>{{ title }}</h1>
      <p>{{ message }}</p>

      <div class="command">
        <code class="mono selectable">{{ command }}</code>
        <button class="icon-button small" :title="copied ? 'Copied' : 'Copy'" @click="copy">
          <Check v-if="copied" :size="15" />
          <Copy v-else :size="15" />
        </button>
      </div>

      <p class="dim">Then check again. On other distributions, install Git with their package manager.</p>
      <button class="primary-button" :disabled="checking" @click="emit('recheck')">
        {{ checking ? "Checking…" : "Check Again" }}
      </button>
    </div>
  </main>
</template>

<style scoped>
.git-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--sidebar-bg);
}

.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(480px, calc(100vw - 32px));
  padding: 36px 32px 28px;
  border-radius: 14px;
  background: var(--content-bg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 8px 30px rgba(0, 0, 0, 0.08);
  text-align: center;
}

.icon {
  color: var(--danger);
}

h1 {
  margin: 10px 0 8px;
  font-size: 20px;
  font-weight: 600;
}

p {
  margin: 0 0 16px;
  line-height: 1.45;
  color: var(--text-secondary);
}

p.dim {
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.command {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 6px 6px 6px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg);
}

code {
  font-size: 13.5px;
}
</style>
