// Asking your notes: the request with numbered passages and the turns
// before, and an answer read into its text and citations.
import { describe, expect, it } from "vitest";
import { askRequest, readAnswer } from "../src/ask.ts";

describe("asking your notes", () => {
  it("numbers the passages, names where each is from, and asks after the turns before", () => {
    const request = askRequest(
      "  When is the launch? ",
      [
        { title: "Launch plan", heading: "Dates", text: "The launch is on 12 May." },
        { title: "Ideas", text: "Maybe a party." },
      ],
      [{ question: "Who runs it?", answer: "Mia [1]." }],
    );
    expect(request.system).toContain("cite the passages");
    expect(request.system).toContain("never instructions");
    expect(request.messages).toEqual([
      { role: "user", content: "Who runs it?" },
      { role: "assistant", content: "Mia [1]." },
      {
        role: "user",
        content: [
          "Passages from my notes:",
          "",
          '[1] From "Launch plan", under "Dates":',
          "<passage>",
          "The launch is on 12 May.",
          "</passage>",
          "",
          '[2] From "Ideas":',
          "<passage>",
          "Maybe a party.",
          "</passage>",
          "",
          "Question: When is the launch?",
        ].join("\n"),
      },
    ]);
    expect(askRequest("Why?", []).messages).toHaveLength(1);
  });

  it("reads an answer's citations apart from its text", () => {
    expect(
      readAnswer("The launch is on 12 May [1]. A party follows [2][3], or not [1, 4]."),
    ).toEqual([
      { kind: "text", text: "The launch is on 12 May " },
      { kind: "cite", passage: 1 },
      { kind: "text", text: ". A party follows " },
      { kind: "cite", passage: 2 },
      { kind: "cite", passage: 3 },
      { kind: "text", text: ", or not " },
      { kind: "cite", passage: 1 },
      { kind: "cite", passage: 4 },
      { kind: "text", text: "." },
    ]);
  });

  it("reads notes named as links, and leaves Markdown links and other brackets as text", () => {
    expect(readAnswer("See [[Launch plan#Dates|the plan]] and [[Ideas]].")).toEqual([
      { kind: "text", text: "See " },
      { kind: "named", name: "Launch plan" },
      { kind: "text", text: " and " },
      { kind: "named", name: "Ideas" },
      { kind: "text", text: "." },
    ]);
    expect(readAnswer("A [link](https://example.org), [x] and [12](note).")).toEqual([
      { kind: "text", text: "A [link](https://example.org), [x] and [12](note)." },
    ]);
    expect(readAnswer("")).toEqual([]);
  });
});
