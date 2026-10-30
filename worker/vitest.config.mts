import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Test-only value. The real key exists only as a Worker secret and in Credential Manager.
				bindings: { SF_SIGNING_KEY: "test-key-for-vitest-only-not-the-real-one" },
			},
		}),
	],
});