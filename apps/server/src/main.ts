// The server's own entry, `node dist/main.js`, with no enterprise module:
// the image's entry is enterprise/server, which starts it with every one
// (ADR 0079). A feature pinned on here stops it at startup, saying so.
import { runServer } from "./start.ts";

runServer();
