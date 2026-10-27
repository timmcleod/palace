<script setup>
import { computed } from "vue";

const props = defineProps({
  graph: { type: Object, default: null },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  // Draw only the lines entering the top of this graph row, straight through, with
  // no dot. Month headers use this so lines continue between commits.
  through: { type: Boolean, default: false },
});

const LANE_WIDTH = 14;
const COLORS = ["--lane-1", "--lane-2", "--lane-3", "--lane-4", "--lane-5", "--lane-6"];

const x = (lane) => 10 + lane * LANE_WIDTH;
const color = (lane) => `var(${COLORS[lane % COLORS.length]})`;

const lines = computed(() => {
  const g = props.graph;
  if (!g) return [];

  const h = props.height;
  const mid = h / 2;
  const node = x(g.lane);

  if (props.through) {
    return [...g.pass, ...g.merge_in].map((lane) => ({ d: `M${x(lane)} 0V${h}`, color: color(lane) }));
  }

  return [
    ...g.pass.map((lane) => ({ d: `M${x(lane)} 0V${h}`, color: color(lane) })),
    // Lines from above that end at this commit, curving in from their own column.
    ...g.merge_in.map((lane) => ({
      d: `M${x(lane)} 0C${x(lane)} ${mid / 2} ${node} ${mid / 2} ${node} ${mid}`,
      color: color(lane),
    })),
    // Lines to this commit's parents, curving out to the column they continue in.
    ...g.out.map((lane) => ({
      d: `M${node} ${mid}C${node} ${mid * 1.5} ${x(lane)} ${mid * 1.5} ${x(lane)} ${h}`,
      color: color(lane),
    })),
  ];
});
</script>

<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`">
    <path v-for="(line, i) in lines" :key="i" :d="line.d" :stroke="line.color" stroke-width="2" fill="none" />
    <circle
      v-if="graph && !through"
      :cx="x(graph.lane)"
      :cy="height / 2"
      r="5"
      :stroke="color(graph.lane)"
      stroke-width="2"
      fill="var(--content-bg)"
    />
  </svg>
</template>
