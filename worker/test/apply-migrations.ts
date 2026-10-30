// Runs before each test file: applies the same migrations as production to the local test D1.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

type Migrations = Parameters<typeof applyD1Migrations>[1];
const testEnv = env as unknown as { AUDIT_DB: D1Database; TEST_MIGRATIONS: Migrations };
await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_MIGRATIONS);