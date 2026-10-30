import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { sign, payload, hookRequest, HOOK_URL } from "./helpers";

const KEY = (env as unknown as { SF_SIGNING_KEY: string }).SF_SIGNING_KEY;
const now = () => Math.floor(Date.now() / 1000);

describe("intake Worker routing", () => {
	it("returns 404 for anything but the hook path", async () => {
		const response = await exports.default.fetch("https://intake.test/");
		expect(response.status).toBe(404);
	});

	it("returns 405 for non-POST requests to the hook", async () => {
		const response = await exports.default.fetch(HOOK_URL);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
	});

	it("returns a bare 401 for an unsigned request", async () => {
		const response = await exports.default.fetch(hookRequest(payload(now())));
		expect(response.status).toBe(401);
		expect(await response.text()).toBe("");
	});

	it("returns the same bare 401 for a bad signature, so callers can't tell which check failed", async () => {
		const body = payload(now());
		const response = await exports.default.fetch(hookRequest(body, await sign(body, "wrong-key")));
		expect(response.status).toBe(401);
		expect(await response.text()).toBe("");
	});

	it("returns 202 for a valid signed request", async () => {
		const body = payload(now());
		const response = await exports.default.fetch(hookRequest(body, await sign(body, KEY)));
		expect(response.status).toBe(202);
	});
});