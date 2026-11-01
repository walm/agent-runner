// `mygo build`'s buildCommand: the game (Vite, at the repo's root, into dist/, which mygo.config.ts ships as a
// resource) and the agent server compiled by Bun into one executable per Mac architecture, in the resources
// directory mygo merges into the app of that architecture.
import { $ } from "bun";
import { rm } from "node:fs/promises";

const root = new URL("../..", import.meta.url).pathname;
const desktop = new URL("..", import.meta.url).pathname;

await $`npm run build`.cwd(root);
for (const [bun, dir] of [["bun-darwin-arm64", "darwin-arm64"], ["bun-darwin-x64", "darwin-amd64"]]) {
  // whatever else is in there ships too (a helper left from an older build, under an older name)
  await rm(`${desktop}resources/${dir}`, { recursive: true, force: true });
  await $`bun build --compile --minify --target=${bun} ${root}server/index.mjs --outfile ${desktop}resources/${dir}/agent-runner-server`;
}
