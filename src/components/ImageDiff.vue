<script setup>
import { computed, reactive, watch } from "vue";
import { formatSize } from "../lib/format.js";

// The old and new versions of a changed image, next to each other.
const props = defineProps({
  // { old, new }, each { size, url } or null for an added or deleted image.
  images: { type: Object, required: true },
});

const sides = computed(() =>
  [
    ["old", props.images.new ? "Before" : "Deleted"],
    ["new", props.images.old ? "After" : "Added"],
  ].filter(([side]) => props.images[side]),
);

// Each side's size in pixels, known once its image has loaded.
const dimensions = reactive({});
watch(
  () => props.images,
  () => {
    delete dimensions.old;
    delete dimensions.new;
  },
);

function loaded(side, event) {
  dimensions[side] = `${event.target.naturalWidth} × ${event.target.naturalHeight}`;
}
</script>

<template>
  <div class="image-diff">
    <figure v-for="[side, label] in sides" :key="side" :class="side">
      <figcaption>
        <span class="label">{{ label }}</span>
        <span class="dim">
          <template v-if="dimensions[side]">{{ dimensions[side] }} · </template>{{ formatSize(images[side].size) }}
        </span>
      </figcaption>
      <div class="frame">
        <img v-if="images[side].url" :src="images[side].url" alt="" @load="loaded(side, $event)" />
        <p v-else class="dim">Too large to show.</p>
      </div>
    </figure>
  </div>
</template>

<style scoped>
.image-diff {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  gap: 12px;
  padding: 12px;
}

figure {
  min-width: 0;
  margin: 0;
}

figcaption {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}

.label {
  font-weight: 600;
}

.old .label {
  color: var(--diff-removed-text);
}

.new .label {
  color: var(--diff-added-text);
}

.dim {
  color: var(--text-tertiary);
}

/* A checkerboard, so transparent parts of an image can be told from its background. */
.frame {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  padding: 8px;
  border: 2px solid var(--border);
  border-radius: 6px;
  background: repeating-conic-gradient(var(--toolbar-group-bg) 0 25%, transparent 0 50%) 0 0 / 16px 16px;
}

.old .frame {
  border-color: var(--diff-removed-gutter);
}

.new .frame {
  border-color: var(--diff-added-gutter);
}

img {
  display: block;
  max-width: 100%;
  max-height: 420px;
  object-fit: contain;
}

.frame p {
  margin: 0;
}
</style>
