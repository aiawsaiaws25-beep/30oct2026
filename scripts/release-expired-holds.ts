import { config } from "dotenv";
import { getCleanupProvider } from "../src/services/cleanup";

config({ path: ".env.local", quiet: true });

getCleanupProvider()
  .releaseExpiredHolds(new Date())
  .then(({ released }) => {
    console.log(`Released ${released.length} expired hold(s)`);
    for (const id of released) console.log(`  ${id}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
