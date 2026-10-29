import { MemoryRepository, PostgresRepository, migrate } from "@radar/store";
import pg from "pg";
import { buildApp } from "./app.js";
import { ApiKeyAuth } from "./auth.js";

const auth = ApiKeyAuth.fromEnv(process.env.RADAR_API_KEYS);
let repo;
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  // An idle pooled connection that drops emits "error"; log it instead of crashing the API.
  pool.on("error", (err) => console.error(`database connection error: ${err.message}`));
  await migrate(pool);
  repo = new PostgresRepository(pool);
} else if (process.env.RADAR_ALLOW_MEMORY === "1") {
  console.warn("Using an in-memory store (RADAR_ALLOW_MEMORY=1); data is lost on restart.");
  repo = new MemoryRepository();
} else {
  throw new Error(
    "DATABASE_URL is not set. Set RADAR_ALLOW_MEMORY=1 to run against a throwaway in-memory store.",
  );
}

// Email yes/no pages are on only when a signing secret is set (RADAR_FEEDBACK_SECRET, 32+ characters).
const app = buildApp({
  repo,
  auth,
  logger: true,
  feedbackSecret: process.env.RADAR_FEEDBACK_SECRET || undefined,
});
const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: "0.0.0.0", port });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await repo.close();
    process.exit(0);
  });
}
