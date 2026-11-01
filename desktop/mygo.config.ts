import { defineConfig } from "mygo-cli";
import pkg from "../package.json" with { type: "json" };

// The app has no frontend of its own for mygo to embed: the window shows the game as the agent server serves
// it (see main.go). buildCommand builds the game and that server; the game ships as the resource "dist".
export default defineConfig({
  name: "Agent Runner",
  identifier: "com.agentrunner.app",
  version: pkg.version,
  buildCommand: "bun scripts/build.mjs",
  resources: ["../dist"],
  out: "build",
  macos: {
    infoPlist: {
      // push to talk in an agent's terminal (src/agents/talk.js): without these macOS ends the app when the game
      // asks for the microphone, or refuses the server's AppleScript to the terminal an agent runs in
      NSMicrophoneUsageDescription: "Hold Space in an agent's terminal to talk to the agent. The speech is turned into text on this Mac.",
      NSAppleEventsUsageDescription: "What you say to an agent is typed into the terminal it runs in (Ghostty, iTerm2 or Terminal).",
    },
  },
});
