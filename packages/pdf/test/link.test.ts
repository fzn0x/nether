import { describe, expect, it } from "vitest";
import {
  isArea,
  isPdf,
  markedOf,
  namesPassage,
  readEmbedSize,
  readPdfPlace,
  writePdfPlace,
} from "../src/index.ts";

describe("places in a PDF, as Obsidian links to them", () => {
  it("reads a page, and a passage on it as Copy link to selection writes it", () => {
    expect(readPdfPlace("page=3")).toEqual({ page: 3 });
    expect(readPdfPlace("page=1&selection=32,0,32,14")).toEqual({
      page: 1,
      selection: { beginIndex: 32, beginOffset: 0, endIndex: 32, endOffset: 14 },
    });
    expect(readPdfPlace("#page=2&selection=4,1,5,20")?.selection?.endIndex).toBe(5);
  });

  it("keeps the page of a link with other things after its #", () => {
    expect(readPdfPlace("page=3&height=400")).toEqual({ page: 3 });
    expect(readPdfPlace("page=3&annotation=11R")).toEqual({ page: 3 });
    expect(readPdfPlace("page=1&selection=0,1,2,3&color=yellow")?.selection).toEqual({
      beginIndex: 0,
      beginOffset: 1,
      endIndex: 2,
      endOffset: 3,
    });
    expect(readPdfPlace("selection=0,1,2,3&page=4")?.page).toBe(4);
  });

  it("names no place without a page, and keeps the page of a passage that does not read", () => {
    expect(readPdfPlace("")).toBeUndefined();
    expect(readPdfPlace("height=400")).toBeUndefined();
    expect(readPdfPlace("page=0")).toBeUndefined();
    expect(readPdfPlace("page=two")).toBeUndefined();
    expect(readPdfPlace("page=-1")).toBeUndefined();
    expect(readPdfPlace("page=2&selection=1,2,3")).toEqual({ page: 2 });
    expect(readPdfPlace("page=2&selection=1,a,3,4")).toEqual({ page: 2 });
    expect(readPdfPlace("page=2&selection=5,0,4,1")).toEqual({ page: 2 });
  });

  it("writes a page and a passage as Obsidian does, and reads back what it writes", () => {
    expect(writePdfPlace({ page: 3 })).toBe("page=3");
    const place = {
      page: 12,
      selection: { beginIndex: 4, beginOffset: 0, endIndex: 5, endOffset: 20 },
    };
    expect(writePdfPlace(place)).toBe("page=12&selection=4,0,5,20");
    expect(readPdfPlace(writePdfPlace(place))).toEqual(place);
  });

  it("reads PDF++'s color as written, and writes it after the passage", () => {
    expect(readPdfPlace("page=1&selection=4,0,5,20&color=Red")).toEqual({
      page: 1,
      selection: { beginIndex: 4, beginOffset: 0, endIndex: 5, endOffset: 20 },
      color: "Red",
    });
    expect(readPdfPlace("page=1&selection=4,0,5,20&color=255, 0,0")?.color).toBe("255, 0,0");
    expect(readPdfPlace("page=1&color=")).toEqual({ page: 1 });
    const colored = {
      page: 1,
      selection: { beginIndex: 4, beginOffset: 0, endIndex: 5, endOffset: 20 },
      color: "red",
    };
    expect(writePdfPlace(colored)).toBe("page=1&selection=4,0,5,20&color=red");
    expect(readPdfPlace(writePdfPlace(colored))).toEqual(colored);
  });

  it("tells links to a passage from other links, and PDFs from other files", () => {
    expect(namesPassage("page=1&selection=0,0,0,4")).toBe(true);
    expect(namesPassage("page=1")).toBe(false);
    expect(namesPassage("Next steps")).toBe(false);
    expect(namesPassage("selection=0,0,0,4")).toBe(false);
    expect(namesPassage(undefined)).toBe(false);
    expect(isPdf("Papers/Paper.PDF")).toBe(true);
    expect(isPdf("Board.canvas")).toBe(false);
  });

  it("reads PDF++'s box, corners in either order, and writes it in whole units", () => {
    expect(readPdfPlace("page=1&rect=300,200,700,600")).toEqual({
      page: 1,
      rect: [300, 200, 700, 600],
    });
    expect(readPdfPlace("page=1&rect=700.5,600,300,200.25&color=red")).toEqual({
      page: 1,
      rect: [300, 200.25, 700.5, 600],
      color: "red",
    });
    for (const bad of ["1,2,3", "1,2,3,x", "1,2,1,5", "1,2,3,2", "1,,3,4"]) {
      expect(readPdfPlace(`page=2&rect=${bad}`)).toEqual({ page: 2 });
    }
    expect(writePdfPlace({ page: 3, rect: [72.4, 400.6, 300, 600], color: "note" })).toBe(
      "page=3&rect=72,401,300,600&color=note",
    );
    expect(namesPassage("page=3&rect=72,401,300,600")).toBe(true);
    expect(namesPassage("page=3&rect=1,2")).toBe(false);
  });

  it("tells a box from a passage, and marks a passage when a link has both", () => {
    const box = readPdfPlace("page=1&rect=1,2,3,4");
    expect(box !== undefined && isArea(box)).toBe(true);
    const both = markedOf(readPdfPlace("page=1&selection=0,0,0,1&rect=1,2,3,4"));
    expect(both !== undefined && isArea(both)).toBe(false);
    expect(markedOf(readPdfPlace("page=1"))).toBeUndefined();
    expect(markedOf(undefined)).toBeUndefined();
  });

  it("reads an embed's size, Obsidian's height and PDF++'s width", () => {
    expect(readEmbedSize("page=3&height=400")).toEqual({ height: 400 });
    expect(readEmbedSize("#page=1&rect=1,2,3,4&width=300")).toEqual({ width: 300 });
    expect(readEmbedSize("height=0&width=x")).toEqual({});
    expect(readEmbedSize(undefined)).toEqual({});
  });
});
