import { createRequire } from "node:module";
import { defineConfig } from "@hey-api/openapi-ts";

const require = createRequire(import.meta.url);

export default defineConfig({
  client: "@hey-api/client-fetch",
  input: "../../hindsight-docs/static/openapi.json",
  output: {
    path: "./generated",
    postProcess: [
      {
        name: "Prettier",
        command: process.execPath,
        args: [require.resolve("prettier/bin/prettier.cjs"), "--write", "{{path}}"],
      },
    ],
  },
  plugins: ["@hey-api/typescript", "@hey-api/sdk"],
});
