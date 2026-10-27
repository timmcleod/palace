import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
// Applies the theme before the first paint.
import "./lib/settings.js";

createApp(App).mount("#app");
