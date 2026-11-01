import { defineConfig } from "mygo-cli";
import pkg from "../package.json" with { type: "json" };

// The app has no frontend of its own for mygo to embed: the window shows the game as the agent server serves
// it (see main.go). buildCommand builds the game and that server; the game ships as the resource "dist".
export default defineConfig({
  name: "Neon City Agents",
  identifier: "com.neoncityagents.app",
  version: pkg.version,
  buildCommand: "bun scripts/build.mjs",
  resources: ["../dist"],
  out: "build",
});
