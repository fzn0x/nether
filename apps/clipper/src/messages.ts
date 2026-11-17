// Every string the clipper's popup shows, so that each can be translated.
// English first; {name} in a message is filled in from its values.
export const messages = {
  title: "Clip to Nether",
  setupHint:
    "Clips go to your own Nether server, and nowhere else. Make a write token in Nether: Servers and signing in, then API tokens.",
  server: "Server address",
  token: "API token",
  connect: "Connect",
  serverInvalid: "That is not a server's address, such as nether.example.org.",
  permissionRefused: "The browser did not let the clipper reach {server}.",
  readToken: "This token only reads: make one that reads and writes.",
  signedInAs: "Signed in to {server} as {name}.",
  disconnect: "Disconnect",
  clip: "Clip",
  theSelection: "The selection",
  theWholePage: "The whole page",
  workspace: "Workspace",
  noWorkspaces:
    "This token reaches no workspace the server can read: encrypted ones take no clips.",
  saveAs: "Save as",
  newNote: "A new note",
  addToNote: "Added to a note",
  databaseRow: "A database row",
  folder: "Folder",
  noteTitle: "Title",
  findNote: "Find a note",
  find: "Find",
  note: "Note",
  noNotes: "No note matches.",
  chooseNote: "Find the note to add the clip to first.",
  database: "Database",
  noDatabases: "This workspace has no databases.",
  markdown: "Markdown",
  save: "Save the clip",
  saving: "Saving…",
  reading: "Reading the page…",
  savedTo: "Saved to {path} in {workspace}.",
  cannotRead:
    "Nether cannot read this page: browsers keep their own pages, and their stores', from extensions.",
} as const;

export type MessageKey = keyof typeof messages;

/** A message, with its {placeholders} filled in. */
export function t(key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}
