// `npm run lint`: checks the page's code for mistakes the build lets through, such as a
// name used but never imported, or one a template uses that its component doesn't have.
// Only rules that find bugs: how code is laid out is left to the editor.
import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import globals from "globals";

export default [
  { ignores: ["dist/**", "src-tauri/**", "public/**", "node_modules/**"] },

  js.configs.recommended,
  ...vue.configs["flat/essential"],

  {
    files: ["**/*.{js,mjs,vue}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      // A template's name that its component doesn't have, as an icon given a `file` that
      // isn't there.
      "vue/no-undef-properties": "error",
      "vue/no-undef-components": ["error", { ignorePatterns: ["^(Teleport|Transition|TransitionGroup|KeepAlive|component)$"] }],
      // Something set up and never used is usually something meant to be used.
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none" }],
      // A prop isn't replaced, but its fields may be changed: the commit message's draft,
      // which App.vue hands Working Copy to fill in, is shared that way on purpose.
      "vue/no-mutating-props": ["error", { shallowOnly: true }],
      // Palace's single-file components are named for what they are, as Sidebar.
      "vue/multi-word-component-names": "off",
    },
  },

  // The build's scripts run in Node.
  {
    files: ["scripts/**", "*.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },

  // Tests run in Vitest, beside what they test.
  {
    files: ["**/*.test.js", "src/test/**"],
    languageOptions: { globals: { ...globals.node } },
  },
];
