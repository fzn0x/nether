// A node of the failover test (ADR 0082): the server as the image runs it,
// with the `ha` module alone, its keys under the prefix the test gives, so
// test runs sharing one Valkey stay apart.
import { runServer } from "@nether/server/src/start.ts";
import { highAvailability } from "../src/index.ts";

runServer({
  enterpriseModules: [highAvailability({ prefix: process.env.NETHER_TEST_HA_PREFIX ?? "nether" })],
});
