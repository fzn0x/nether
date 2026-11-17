// A provider's sign-in on a phone (ADR 0087): the page's flow (server.ts)
// waits for the browser to come back to the app's own scheme, as the desktop
// app waits on a loopback address. On iOS the system's sign-in sheet,
// ASWebAuthenticationSession through the app's plugin, takes the scheme back
// itself. On Android a Custom Tab opens the provider, and the app's intent
// filter takes the scheme back, which Capacitor's App plugin hands the page.
import { t } from "./messages.ts";
import type { LoopbackWait } from "./server.ts";

/** Where the server sends the browser back, which it accepts at this path only. */
export const returnAddress = "io.github.fzn0x.nether:/sign-in/provider";

/** The scheme alone, as the iOS sheet takes it. */
export const returnScheme = "io.github.fzn0x.nether";

/** How long a closed tab waits for its address: Android may tell of each in either order. */
export const closedTabGrace = 2_000;

/** What the handoff needs of the phone. */
export interface Handoff {
  /**
   * iOS: opens the system's sign-in sheet at an address, and gives the
   * address it came back to, or undefined when it was cancelled.
   */
  readonly sheet?: (url: string) => Promise<string | undefined>;
  /** Android: opens an address in a Custom Tab. */
  readonly openTab: (url: string) => Promise<void>;
  /** Calls `listener` with each address the app is opened at; gives what stops it. */
  readonly onAddress: (listener: (url: string) => void) => () => void;
  /** Calls `listener` when the Custom Tab closes; gives what stops it. */
  readonly onTabClosed: (listener: () => void) => () => void;
}

/** The query an address at the app's return path came back with; undefined for any other. */
export function returnedQuery(address: string): Readonly<Record<string, string>> | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (`${url.protocol}${url.pathname}` !== returnAddress) return undefined;
  return Object.fromEntries(url.searchParams);
}

/** A wait for a provider's sign-in to come back to the app's scheme. */
export function schemeWait(handoff: Handoff): LoopbackWait {
  const stops: (() => void)[] = [];
  let done = false;
  let resolve: (query: Readonly<Record<string, string>>) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const result = new Promise<Readonly<Record<string, string>>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Ended before anyone waits, as when the tab cannot open, it reports nothing on its own.
  result.catch(() => undefined);

  const finish = (end: () => void) => {
    if (done) return;
    done = true;
    for (const stop of stops.splice(0)) stop();
    end();
  };
  const cancelled = () => {
    finish(() => {
      reject(new Error(t("providerCancelled")));
    });
  };
  const arrived = (address: string) => {
    const query = returnedQuery(address);
    if (query !== undefined) {
      finish(() => {
        resolve(query);
      });
    }
  };

  return {
    redirect: returnAddress,
    async open(url) {
      const sheet = handoff.sheet;
      if (sheet !== undefined) {
        void sheet(url).then(
          (address) => {
            if (address === undefined) cancelled();
            else arrived(address);
          },
          (reason: unknown) => {
            finish(() => {
              reject(reason);
            });
          },
        );
        return;
      }
      stops.push(handoff.onAddress(arrived));
      stops.push(
        handoff.onTabClosed(() => {
          const timer = setTimeout(cancelled, closedTabGrace);
          stops.push(() => {
            clearTimeout(timer);
          });
        }),
      );
      await handoff.openTab(url);
    },
    wait: () => result,
    close() {
      cancelled();
      return Promise.resolve();
    },
  };
}
