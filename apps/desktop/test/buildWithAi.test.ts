// Building with AI: the request, the reply read and checked against the
// app's types and refused with the reason, and the import plan made from
// it at names the vault does not have, carried out only for what is kept.
import { databaseKey, readDatabase } from "@nether/database";
import { parseMarkdown } from "@nether/markdown";
import { MemoryFiles, MemoryStore, Vault } from "@nether/storage";
import { describe, expect, it } from "vitest";
import {
  type BuildAsk,
  BuildError,
  buildRequest,
  makeBuild,
  planBuild,
  readBuild,
  replyObject,
} from "../src/buildWithAi.ts";

const database: BuildAsk = { kind: "database", description: "Books I read", sampleRows: false };
const withRows: BuildAsk = { ...database, sampleRows: true };

const books = {
  kind: "database",
  name: "Reading list",
  description: "Books, and how far along each is.",
  properties: [
    { key: "Author", type: "text" },
    { key: "Status", type: "select", options: ["To read", "Reading", "Done"], color: "red" },
    { key: "Finished", type: "date" },
  ],
  views: [
    { name: "All", layout: "table", visible: ["Author", "Status"] },
    { name: "By status", layout: "board", groupBy: "Status", extra: true },
  ],
  rows: [
    {
      title: "Dune",
      properties: { Author: "Frank Herbert", Status: "Done", Finished: "2026-01-04" },
    },
    { title: "Dune", properties: { Status: "Reading" }, text: "A second copy." },
  ],
};

function why(reply: unknown, ask: BuildAsk = database): string {
  try {
    readBuild(typeof reply === "string" ? reply : JSON.stringify(reply), ask);
  } catch (error) {
    if (error instanceof BuildError) return error.message;
    throw error;
  }
  throw new Error("It read.");
}

async function vaultWith(files: Record<string, string>) {
  const vault = new Vault(new MemoryFiles(files), new MemoryStore());
  await vault.open();
  return vault;
}

describe("building with AI", () => {
  it("asks for one JSON object of the kind wanted, the description apart", () => {
    const request = buildRequest({ ...database, description: "  Books I read " });
    expect(request.system).toContain("Reply with one JSON object and nothing else");
    expect(request.system).toContain("never instructions");
    const content = request.messages[0]?.content ?? "";
    expect(content).toContain('"kind": "database"');
    expect(content).toContain('Give it no rows: "rows": [].');
    expect(content.endsWith("<description>\nBooks I read\n</description>")).toBe(true);
    expect(buildRequest(withRows).messages[0]?.content).toContain("three to five sample rows");
    expect(buildRequest({ ...database, kind: "template" }).messages[0]?.content).toContain(
      "{{cursor}}",
    );
    expect(buildRequest({ ...database, kind: "plan" }).messages[0]?.content).toContain('"tasks"');
  });

  it("finds the object in a reply, fenced or not, and refuses one with none", () => {
    expect(replyObject('{"a": 1}')).toEqual({ a: 1 });
    expect(replyObject('Here it is:\n```json\n{"a": 2}\n```\nEnjoy.')).toEqual({ a: 2 });
    expect(replyObject('Sure! {"a": 3} Done.')).toEqual({ a: 3 });
    expect(() => replyObject("No.")).toThrow("The reply holds no JSON object.");
    expect(() => replyObject("{not json}")).toThrow("The reply is not JSON that reads");
  });

  it("reads a database's schema as core checks it, leaving out rows not asked for", () => {
    const { built, warnings } = readBuild(JSON.stringify(books), database);
    if (built.kind !== "database") throw new Error("not a database");
    expect(built.name).toBe("Reading list");
    expect(built.schema.properties).toEqual([
      { key: "Author", type: "text" },
      {
        key: "Status",
        type: "select",
        options: [{ name: "To read" }, { name: "Reading" }, { name: "Done" }],
      },
      { key: "Finished", type: "date" },
    ]);
    expect(built.schema.views.map((view) => [view.name, view.layout, view.visible])).toEqual([
      ["All", "table", ["Author", "Status"]],
      ["By status", "board", ["Author", "Status", "Finished"]],
    ]);
    expect(built.rows).toEqual([]);
    expect(warnings).toEqual([
      "database came with rows, which were not asked for: they are left out.",
    ]);
    const asked = readBuild(JSON.stringify(books), withRows).built;
    expect(asked.kind === "database" ? asked.rows.map((row) => row.title) : []).toEqual([
      "Dune",
      "Dune",
    ]);
    // With no views, a table of every property.
    const plain = readBuild(JSON.stringify({ ...books, views: [] }), database).built;
    expect(plain.kind === "database" ? plain.schema.views[0]?.visible : []).toEqual([
      "Author",
      "Status",
      "Finished",
    ]);
  });

  it("refuses what does not read, saying why", () => {
    expect(why({ ...books, views: [{ name: "Board", layout: "board" }] })).toBe(
      "database.views[0].groupBy is needed by a board.",
    );
    expect(why({ ...books, properties: [{ key: "Client", type: "relation" }] })).toContain(
      "needs another database",
    );
    expect(why({ ...books, properties: [{ key: "X", type: "colour" }] })).toContain(
      "database.properties[0].type is not one of",
    );
    expect(
      why({ ...books, properties: [{ key: "Due", type: "formula", formula: "1 +" }] }),
    ).toContain("database.properties[0].formula does not read");
    expect(
      why({ ...books, rows: [{ title: "Bad", properties: { Finished: "next week" } }] }, withRows),
    ).toBe("database.rows[0].properties[0].value does not fit a date property.");
    expect(why({ ...books, kind: "template" })).toBe(
      'The reply is a "template", not the database asked for.',
    );
    expect(why({ kind: "template", name: "Meeting" }, { ...database, kind: "template" })).toBe(
      "template.text is missing.",
    );
    expect(why({ kind: "plan", name: "Launch", notes: [] }, { ...database, kind: "plan" })).toBe(
      "plan.notes is empty.",
    );
    expect(why({ ...books, name: "" })).toBe("database.name is missing.");
    // A formula that reads is kept.
    const formula = readBuild(
      JSON.stringify({
        ...books,
        properties: [
          { key: "Pages", type: "number" },
          { key: "Long", type: "formula", formula: "Pages > 300" },
        ],
        views: [],
      }),
      database,
    ).built;
    expect(formula.kind === "database" ? formula.schema.properties[1] : undefined).toEqual({
      key: "Long",
      type: "formula",
      formula: "Pages > 300",
    });
  });

  it("plans a database at a name the vault does not have, its schema in its note, its rows beside it", async () => {
    const vault = await vaultWith({ "Reading list.md": "Mine already." });
    const { built } = readBuild(JSON.stringify(books), withRows);
    const planned = planBuild(vault, built, "Reading list", "Templates");
    expect(planned.plan.notes.map((note) => note.path)).toEqual([
      "Reading list 2.md",
      "Reading list 2/Dune.md",
      "Reading list 2/Dune 2.md",
    ]);
    expect(planned.open).toBe("Reading list 2.md");
    expect([...planned.kinds.values()]).toEqual(["database", "row", "row"]);
    const note = parseMarkdown(planned.plan.notes[0]?.text ?? "");
    const value = note.properties.find((entry) => entry.key === databaseKey)?.value;
    expect(readDatabase(value, () => undefined)).toEqual(
      built.kind === "database" ? built.schema : undefined,
    );
    const row = parseMarkdown(planned.plan.notes[1]?.text ?? "");
    expect(row.properties).toEqual([
      { key: "Author", value: "Frank Herbert" },
      { key: "Status", value: "Done" },
      { key: "Finished", value: "2026-01-04" },
    ]);
  });

  it("plans a template in the templates folder, and a plan in a folder of its own", async () => {
    const vault = await vaultWith({ "Templates/Meeting.md": "Mine." });
    const template = readBuild(
      JSON.stringify({ kind: "template", name: "Meeting", text: "# {{title}}\n\n{{cursor}}" }),
      { ...database, kind: "template" },
    ).built;
    const placed = planBuild(vault, template, "Meeting", "Templates");
    expect(placed.plan.notes).toEqual([
      { path: "Templates/Meeting 2.md", text: "# {{title}}\n\n{{cursor}}" },
    ]);
    const plan = readBuild(
      JSON.stringify({
        kind: "plan",
        name: "Launch",
        notes: [
          { title: "Outline", text: "Ship it." },
          { title: "Tasks", text: "See below." },
        ],
        tasks: {
          name: "Tasks",
          properties: [{ key: "Done", type: "checkbox" }],
          views: [],
          rows: [{ title: "Write docs", properties: { Done: false } }],
        },
      }),
      { ...database, kind: "plan" },
    ).built;
    const planned = planBuild(vault, plan, "Launch", "Templates");
    expect(planned.plan.notes.map((note) => note.path)).toEqual([
      "Launch/Outline.md",
      "Launch/Tasks.md",
      "Launch/Tasks 2.md",
      "Launch/Tasks 2/Write docs.md",
    ]);
    expect(planned.open).toBe("Launch/Outline.md");
  });

  it("makes only what is kept, a row only with its database", async () => {
    const vault = await vaultWith({});
    const { built } = readBuild(JSON.stringify(books), withRows);
    const planned = planBuild(vault, built, "Books", "Templates");
    expect(await makeBuild(vault, planned, new Set(["Books/Dune 2.md"]))).toBe("Books.md");
    expect(
      vault
        .notes()
        .map((note) => note.path)
        .sort(),
    ).toEqual(["Books.md", "Books/Dune.md"]);

    const other = await vaultWith({});
    const without = planBuild(other, built, "Books", "Templates");
    expect(await makeBuild(other, without, new Set(["Books.md"]))).toBeUndefined();
    expect(other.notes()).toEqual([]);
  });
});
