// A provider's sign-in on a phone (ADR 0087): the handoff through the app's
// own scheme, by the iOS sign-in sheet or an Android Custom Tab.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Handoff,
  closedTabGrace,
  returnAddress,
  returnedQuery,
  schemeWait,
} from "../src/mobileSignIn.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** An Android phone: a tab that opens, and the events the test sends it. */
function android() {
  const opened: string[] = [];
  const addressListeners = new Set<(url: string) => void>();
  const closedListeners = new Set<() => void>();
  const handoff: Handoff = {
    openTab(url) {
      opened.push(url);
      return Promise.resolve();
    },
    onAddress(listener) {
      addressListeners.add(listener);
      return () => addressListeners.delete(listener);
    },
    onTabClosed(listener) {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
  };
  return {
    handoff,
    opened,
    comeBack(url: string) {
      for (const listener of [...addressListeners]) listener(url);
    },
    closeTab() {
      for (const listener of [...closedListeners]) listener();
    },
    listening: () => addressListeners.size + closedListeners.size,
  };
}

describe("returnedQuery", () => {
  it("reads the query back from the app's return path only", () => {
    expect(returnedQuery(`${returnAddress}?code=abc&from=nether`)).toEqual({
      code: "abc",
      from: "nether",
    });
    expect(returnedQuery(`${returnAddress}?error=access_denied`)).toEqual({
      error: "access_denied",
    });
    expect(returnedQuery("io.github.fzn0x.nether:/sign-in/elsewhere?code=abc")).toBeUndefined();
    expect(returnedQuery("io.github.fzn0x.other:/sign-in/provider?code=abc")).toBeUndefined();
    expect(returnedQuery("not an address")).toBeUndefined();
  });
});

describe("schemeWait on Android", () => {
  it("opens the provider in a tab, and gives the code the app is opened with", async () => {
    const phone = android();
    const wait = schemeWait(phone.handoff);
    expect(wait.redirect).toBe("io.github.fzn0x.nether:/sign-in/provider");
    await wait.open?.("https://provider.example.org/authorize?x=1");
    expect(phone.opened).toEqual(["https://provider.example.org/authorize?x=1"]);
    // Another link opening the app is not the sign-in's.
    phone.comeBack("io.github.fzn0x.nether:/capture?text=hi");
    phone.comeBack(`${returnAddress}?code=abc`);
    await expect(wait.wait()).resolves.toEqual({ code: "abc" });
    expect(phone.listening()).toBe(0);
  });

  it("takes the address when the tab says it closed first", async () => {
    vi.useFakeTimers();
    const phone = android();
    const wait = schemeWait(phone.handoff);
    await wait.open?.("https://provider.example.org/");
    phone.closeTab();
    await vi.advanceTimersByTimeAsync(closedTabGrace / 2);
    phone.comeBack(`${returnAddress}?code=abc`);
    await expect(wait.wait()).resolves.toEqual({ code: "abc" });
  });

  it("ends as cancelled when the tab closes without coming back", async () => {
    vi.useFakeTimers();
    const phone = android();
    const wait = schemeWait(phone.handoff);
    await wait.open?.("https://provider.example.org/");
    const result = wait.wait();
    const checked = expect(result).rejects.toThrow("Signing in was cancelled at the provider.");
    phone.closeTab();
    await vi.advanceTimersByTimeAsync(closedTabGrace);
    await checked;
    expect(phone.listening()).toBe(0);
  });

  it("ends as cancelled when closed, as the dialog's Cancel does", async () => {
    const phone = android();
    const wait = schemeWait(phone.handoff);
    await wait.open?.("https://provider.example.org/");
    await wait.close();
    await expect(wait.wait()).rejects.toThrow("Signing in was cancelled at the provider.");
    // Coming back after does nothing.
    phone.comeBack(`${returnAddress}?code=abc`);
    expect(phone.listening()).toBe(0);
  });
});

describe("schemeWait on iOS", () => {
  it("opens the sign-in sheet, which gives the address it came back to", async () => {
    const phone = android();
    const sheet = vi.fn((url: string) =>
      Promise.resolve(`${returnAddress}?code=${String(url.length)}`),
    );
    const wait = schemeWait({ ...phone.handoff, sheet });
    await wait.open?.("https://p.example.org/");
    expect(sheet).toHaveBeenCalledWith("https://p.example.org/");
    expect(phone.opened).toEqual([]);
    await expect(wait.wait()).resolves.toEqual({ code: "22" });
  });

  it("ends as cancelled when the sheet is cancelled, and fails as the sheet fails", async () => {
    const phone = android();
    const cancelled = schemeWait({ ...phone.handoff, sheet: () => Promise.resolve(undefined) });
    await cancelled.open?.("https://p.example.org/");
    await expect(cancelled.wait()).rejects.toThrow("Signing in was cancelled at the provider.");
    const failed = schemeWait({
      ...phone.handoff,
      sheet: () => Promise.reject(new Error("No window to show the sheet in.")),
    });
    await failed.open?.("https://p.example.org/");
    await expect(failed.wait()).rejects.toThrow("No window to show the sheet in.");
  });
});
