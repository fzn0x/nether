// The servers the app is signed in to, and signing in to another (ADR
// 0036): its address, then a password, a code it emails, or its OpenID
// Connect provider in the system's browser, as the server offers. A
// session's token goes to the system's keychain; signing out ends the
// session on the server, and forgets it here either way. Each account's
// end-to-end encryption (ADR 0038) is turned on here, showing its recovery
// phrase once, or unlocked on a new device with the phrase. Someone invited
// to a workspace joins here with the invitation's link, into the account
// they are signed in to on its server, or a new one. The web app keeps to
// its own server (ADR 0053): it starts at signing in there, and offers no
// other. Where single sign-on is on (ADR 0080), signing in asks for the
// address first, and goes straight to its domain's provider when it has
// one; where everyone signs in through a provider, the password and the
// code wait behind signing in as an instance admin.
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { backend } from "./backend.ts";
import type { PreparedKeys } from "./encryption.ts";
import { t } from "./messages.ts";
import type { ServerAccount } from "./mygo.ts";
import {
  type InvitationOffer,
  type LoopbackWait,
  type SignInMethods,
  type SignedIn,
  ServerError,
  acceptInvitation,
  accountKeys,
  askForCode,
  findProvider,
  lookUpInvitation,
  readInvitationLink,
  redeemCode,
  roleName,
  serverAddress,
  setUpServer,
  setupNeeded,
  signInMethods,
  signInWithPassword,
  signInWithProvider,
  signOut,
} from "./server.ts";
import { useModal } from "./useModal.ts";

type Step =
  | { readonly kind: "list" }
  | { readonly kind: "address" }
  | {
      readonly kind: "signIn";
      readonly url: string;
      readonly methods: SignInMethods;
      /**
       * The ways offered once the address is known: all of them, the
       * providers alone, or the password and code of an instance admin.
       * None yet asks for the address first, where single sign-on is on.
       */
      readonly ways?: Ways;
    }
  /** A server with no account yet, set up with the code in its log. */
  | { readonly kind: "setup"; readonly url: string }
  | {
      readonly kind: "code";
      readonly url: string;
      readonly methods: SignInMethods;
      readonly email: string;
    }
  | { readonly kind: "keys"; readonly account: ServerAccount; readonly keys: PreparedKeys }
  | { readonly kind: "unlock"; readonly account: ServerAccount }
  | { readonly kind: "join" }
  | {
      readonly kind: "joining";
      readonly url: string;
      readonly token: string;
      readonly offer: InvitationOffer;
      /** The account this app is signed in to on that server, which joins; none makes one. */
      readonly account: ServerAccount | undefined;
    };

/** The ways a sign-in step offers, once the address is known. */
type Ways = "all" | "providers" | "admin";

/** Whether a sign-in step asks for the address before anything else. */
function asksAddress(step: Step): boolean {
  return step.kind === "signIn" && step.ways === undefined && step.methods.sso.length > 0;
}

/** An account's end-to-end encryption: not turned on, on but not on this device, or on here. */
type Encryption = "off" | "locked" | "on";

/** Each account's encryption, as the server and this device's keychain tell it. */
async function encryptionOf(
  accounts: readonly ServerAccount[],
): Promise<ReadonlyMap<string, Encryption>> {
  const found = new Map<string, Encryption>();
  for (const account of accounts) {
    try {
      if ((await backend.serverKey(account.url)) !== undefined) {
        found.set(account.url, "on");
        continue;
      }
      const token = await backend.serverToken(account.url);
      if (token === undefined) continue;
      const keys = await accountKeys(backend.serverFetch, account.url, token);
      found.set(account.url, keys === undefined ? "off" : "locked");
    } catch {
      // A server that cannot be reached shows no encryption until it can.
    }
  }
  return found;
}

/** A server's address as the dialog shows it: its host, and port if any. */
function hostOf(url: string): string {
  return new URL(url).host;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Signing in to a server, or setting it up while it has no account; it throws for an address that is no Nether server's. */
async function firstStep(url: string): Promise<Step> {
  const methods = await signInMethods(backend.serverFetch, url);
  // A server that will not say, as behind a proxy that keeps it out, is signed in to.
  const needed = await setupNeeded(backend.serverFetch, url).catch(() => false);
  return needed ? { kind: "setup", url } : { kind: "signIn", url, methods };
}

export function ServersDialog(props: {
  readonly onClose: () => void;
  /** The one server to sign in to, as the web app's own. */
  readonly only?: string;
  /** An invitation's link to start with, as the web app opened at. */
  readonly invitation?: string;
  /** Called when an account signs in or out. */
  readonly onAccount?: () => void;
  /** Opens the API tokens of the account on a server (ADR 0059), where the app can. */
  readonly onTokens?: (server: string) => void;
}) {
  const { onClose, only, onAccount, onTokens } = props;
  const [accounts, setAccounts] = useState<readonly ServerAccount[] | undefined>();
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [phrase, setPhrase] = useState("");
  const [invitation, setInvitation] = useState(props.invitation ?? "");
  /** Signing in to the one server, once its ways are known. */
  const [onlySignIn, setOnlySignIn] = useState<Step | undefined>();
  const [name, setName] = useState("");
  const [written, setWritten] = useState(false);
  const [encryption, setEncryption] = useState<ReadonlyMap<string, Encryption>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  /** A sign-in in the system's browser, while the app waits for it to come back. */
  const [browser, setBrowser] = useState<LoopbackWait | undefined>();
  const waiting = useRef<LoopbackWait | undefined>(undefined);
  const cancelled = useRef(false);
  // Read through a function: the Cancel button changes it while a sign-in waits.
  const wasCancelled = () => cancelled.current;
  const dialog = useRef<HTMLFormElement>(null);
  useModal(dialog);

  // Each step starts at its main control: the field to fill, or Done.
  const ways = step.kind === "signIn" ? step.ways : undefined;
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step.kind, ways, accounts]);

  useEffect(() => {
    let current = true;
    // Read through a function: the cleanup changes it during the waits.
    const live = () => current;
    void backend.servers().then(async (list) => {
      if (!live()) return;
      setAccounts(list);
      if (props.invitation !== undefined) {
        setStep({ kind: "join" });
      } else if (list.length === 0 && only !== undefined) {
        // With the one server, the dialog starts at signing in there, or at
        // setting it up.
        try {
          const signIn = await firstStep(only);
          if (!live()) return;
          setOnlySignIn(signIn);
          setStep(signIn);
        } catch (reason) {
          if (live()) setError(messageOf(reason));
        }
      } else if (list.length === 0) {
        // With no server yet, the dialog starts at the address.
        setStep({ kind: "address" });
      }
      const found = await encryptionOf(list);
      if (live()) setEncryption(found);
    });
    return () => {
      current = false;
      // A sign-in still waiting for the browser stops when the dialog closes.
      void waiting.current?.close();
    };
  }, []);

  /** Runs an action, showing it busy, and its failure. */
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await action();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    const list = await backend.servers();
    setAccounts(list);
    setEncryption(await encryptionOf(list));
  };

  const finish = async (url: string, signedIn: SignedIn) => {
    await backend.saveServer({ url, user: signedIn.user }, signedIn.token);
    await refresh();
    setPassword("");
    setCode("");
    setStep({ kind: "list" });
    setStatus(t("signedInTo", { server: hostOf(url), name: signedIn.user.name }));
    onAccount?.();
  };

  const submit = () => {
    if (busy) return;
    if (step.kind === "list") {
      onClose();
    } else if (step.kind === "address") {
      const url = serverAddress(address);
      if (url === undefined) {
        setError(t("serverAddressInvalid"));
        return;
      }
      void act(async () => {
        setStep(await firstStep(url));
      });
    } else if (step.kind === "setup") {
      void act(async () => {
        const { url } = step;
        const signedIn = await setUpServer(backend.serverFetch, url, {
          code: setupCode,
          name,
          email,
          password,
          workspace,
        });
        await finish(url, signedIn);
        setStatus(t("setUpDone", { server: hostOf(url), name: signedIn.user.name }));
      });
    } else if (step.kind === "signIn" && asksAddress(step)) {
      const { url, methods } = step;
      void act(async () => {
        const found = await findProvider(backend.serverFetch, url, email);
        const ways: Ways = found.required || methods.ssoEveryone ? "providers" : "all";
        if (found.provider === undefined) {
          setStep({ kind: "signIn", url, methods, ways });
          return;
        }
        // Straight to its domain's provider; back here, the other ways it may use.
        setStep({ kind: "signIn", url, methods, ways });
        await throughProvider(url, found.provider.id);
      });
    } else if (step.kind === "signIn") {
      void act(async () => {
        await finish(
          step.url,
          await signInWithPassword(backend.serverFetch, step.url, email, password),
        );
      });
    } else if (step.kind === "code") {
      void act(async () => {
        await finish(step.url, await redeemCode(backend.serverFetch, step.url, step.email, code));
      });
    } else if (step.kind === "join") {
      const found = readInvitationLink(invitation);
      if (found === undefined) {
        setError(t("invitationLinkInvalid"));
        return;
      }
      if (only !== undefined && found.server !== only) {
        setError(t("invitationOtherServer", { server: hostOf(found.server) }));
        return;
      }
      void act(async () => {
        const offer = await lookUpInvitation(backend.serverFetch, found.server, found.token);
        if (offer.email !== null) setEmail(offer.email);
        setStep({
          kind: "joining",
          url: found.server,
          token: found.token,
          offer,
          account: accounts?.find((account) => account.url === found.server),
        });
      });
    } else if (step.kind === "joining") {
      void act(async () => {
        const { url, offer, account } = step;
        if (account === undefined) {
          let signedIn: SignedIn | undefined;
          try {
            signedIn = await acceptInvitation(backend.serverFetch, url, step.token, {
              name,
              email,
              password,
            });
          } catch (reason) {
            // Its provider makes or finds the account, which accepts the invitation.
            if (!(reason instanceof ServerError) || reason.sso === undefined) throw reason;
            setStatus(t("invitationThroughProvider", { name: reason.sso.name }));
            await throughProvider(url, reason.sso.id, step.token);
            setInvitation("");
            return;
          }
          if (signedIn !== undefined) await finish(url, signedIn);
        } else {
          const session = await backend.serverToken(url);
          if (session === undefined) throw new Error(t("syncSignedOut", { server: hostOf(url) }));
          await acceptInvitation(backend.serverFetch, url, step.token, { session });
          await refresh();
          setStep({ kind: "list" });
        }
        setInvitation("");
        setStatus(
          t(only === undefined ? "invitationJoined" : "invitationJoinedHere", {
            workspace: offer.workspace.name,
          }),
        );
      });
    } else if (step.kind === "keys") {
      if (!written) return;
      void act(async () => {
        const server = step.account.url;
        const token = await backend.serverToken(server);
        if (token === undefined) throw new Error(t("syncSignedOut", { server: hostOf(server) }));
        const { keepKeys } = await import("./encryption.ts");
        await keepKeys(server, token, step.keys);
        await refresh();
        setStep({ kind: "list" });
        setStatus(t("encryptionTurnedOn", { server: hostOf(server) }));
      });
    } else {
      void act(async () => {
        const server = step.account.url;
        const token = await backend.serverToken(server);
        if (token === undefined) throw new Error(t("syncSignedOut", { server: hostOf(server) }));
        const { unlockKeys } = await import("./encryption.ts");
        await unlockKeys(server, token, step.account.user.id, phrase);
        setPhrase("");
        await refresh();
        setStep({ kind: "list" });
        setStatus(t("encryptionUnlocked", { server: hostOf(server) }));
      });
    }
  };

  const turnOn = (account: ServerAccount) => {
    void act(async () => {
      // The keys are made here, and kept only once the phrase is written down.
      const { prepareKeys } = await import("./encryption.ts");
      setWritten(false);
      setStep({ kind: "keys", account, keys: await prepareKeys(account.user.id) });
    });
  };

  const signOutOf = (account: ServerAccount) => {
    void act(async () => {
      const token = await backend.serverToken(account.url);
      // The session ends on the server if it can be reached; here, either way.
      if (token !== undefined)
        await signOut(backend.serverFetch, account.url, token).catch(() => undefined);
      await backend.forgetServer(account.url);
      await refresh();
      setStatus(t("signedOutOf", { server: hostOf(account.url) }));
      onAccount?.();
    });
  };

  const emailCode = (url: string, methods: SignInMethods) => {
    void act(async () => {
      await askForCode(backend.serverFetch, url, email);
      setStep({ kind: "code", url, methods, email: email.trim() });
    });
  };

  /** Signs in through a provider in the system's browser, accepting an invitation if given one. */
  const throughProvider = async (url: string, sso?: string, invitationToken?: string) => {
    const loopback = await backend.loopback();
    waiting.current = loopback;
    cancelled.current = false;
    setBrowser(loopback);
    setStatus(t("waitingForBrowser"));
    try {
      await finish(
        url,
        await signInWithProvider(
          backend.serverFetch,
          url,
          loopback,
          (target) => backend.openUrl(target),
          sso,
          invitationToken,
        ),
      );
    } catch (reason) {
      // Cancelled here, by the Cancel button: nothing went wrong.
      if (!wasCancelled()) throw reason;
      setStatus(undefined);
    } finally {
      waiting.current = undefined;
      setBrowser(undefined);
    }
  };

  const withProvider = (url: string, sso?: string) => {
    void act(() => throughProvider(url, sso));
  };

  /** An account's encryption, and the way to turn it on or unlock it here. */
  const encryptionLine = (account: ServerAccount) => {
    const state = encryption.get(account.url);
    if (state === undefined) return null;
    const hint =
      state === "on"
        ? t("encryptionOnHint")
        : state === "locked"
          ? t("encryptionLockedHint")
          : t("encryptionOffHint");
    return (
      <>
        <span className="hint">{hint}</span>
        {state === "off" ? (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => {
              turnOn(account);
            }}
          >
            {t("encryptionTurnOn")}
          </button>
        ) : state === "locked" ? (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => {
              setError(undefined);
              setPhrase("");
              setStep({ kind: "unlock", account });
            }}
          >
            {t("encryptionUnlock")}
          </button>
        ) : null}
      </>
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  let body: ReactNode;
  let primary: string;
  let back: Step | undefined;
  if (step.kind === "list") {
    primary = t("done");
    body = (
      <>
        {accounts === undefined || accounts.length === 0 ? (
          <p className="hint">{t("serversNone")}</p>
        ) : (
          <ul className="server-list" aria-label={t("servers")}>
            {accounts.map((account) => (
              <li key={account.url}>
                <span>
                  <strong>{hostOf(account.url)}</strong>{" "}
                  {t("serverAccount", { name: account.user.name, email: account.user.email })}
                </span>
                {encryptionLine(account)}
                {onTokens === undefined ? null : (
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy}
                    onClick={() => {
                      onTokens(account.url);
                    }}
                  >
                    {t("apiTokensOf", { server: hostOf(account.url) })}
                  </button>
                )}
                {account.user.instanceAdmin ? (
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy}
                    onClick={() => {
                      // The console is the server's web app's page (ADR 0079), in the browser.
                      void backend.openUrl(`${account.url}/admin`);
                    }}
                  >
                    {t("adminConsoleOf", { server: hostOf(account.url) })}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => {
                    signOutOf(account);
                  }}
                >
                  {t("signOutOf", { server: hostOf(account.url) })}
                </button>
              </li>
            ))}
          </ul>
        )}
        {only !== undefined ? null : (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => {
              setError(undefined);
              setStatus(undefined);
              setStep({ kind: "address" });
            }}
          >
            {t("connectServer")}
          </button>
        )}
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => {
            setError(undefined);
            setStatus(undefined);
            setStep({ kind: "join" });
          }}
        >
          {t("invitationJoin")}
        </button>
      </>
    );
  } else if (step.kind === "join") {
    primary = t("continueStep");
    back =
      accounts === undefined || accounts.length === 0
        ? only === undefined
          ? { kind: "address" }
          : onlySignIn
        : { kind: "list" };
    body = (
      <label className="field">
        {t("invitationLink")}
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          required
          data-autofocus
          value={invitation}
          aria-describedby="invitation-link-hint"
          onChange={(event) => {
            setInvitation(event.target.value);
          }}
        />
        <span id="invitation-link-hint" className="hint">
          {t("invitationLinkHint")}
        </span>
      </label>
    );
  } else if (step.kind === "joining") {
    const { url, offer, account } = step;
    primary =
      account === undefined
        ? t("invitationMakeAccount")
        : t("invitationJoinAs", { name: account.user.name });
    back = { kind: "join" };
    body = (
      <>
        <p>
          {t("invitationTo", {
            workspace: offer.workspace.name,
            server: hostOf(url),
            role: roleName(offer.role),
          })}
          {offer.invitedBy === null ? null : ` ${t("invitationFrom", { name: offer.invitedBy })}`}
        </p>
        {account === undefined ? (
          <fieldset>
            <legend>{t("invitationNewAccount", { server: hostOf(url) })}</legend>
            <label className="field">
              {t("yourName")}
              <input
                type="text"
                autoComplete="name"
                required
                data-autofocus
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            <label className="field">
              {t("emailAddress")}
              <input
                type="email"
                autoComplete="username"
                required
                readOnly={offer.email !== null}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
            </label>
            <label className="field">
              {t("password")}
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={password}
                aria-describedby="new-password-hint"
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
              <span id="new-password-hint" className="hint">
                {t("newPasswordHint")}
              </span>
            </label>
            <p className="hint">{t("invitationHaveAccount", { server: hostOf(url) })}</p>
          </fieldset>
        ) : null}
      </>
    );
  } else if (step.kind === "keys") {
    primary = t("encryptionTurnOn");
    back = { kind: "list" };
    body = (
      <>
        <p>{t("recoveryPhraseIntro")}</p>
        <ol className="recovery-phrase" aria-label={t("recoveryPhrase")}>
          {step.keys.phrase.split(" ").map((word, index) => (
            <li key={index}>{word}</li>
          ))}
        </ol>
        <p className="hint">{t("recoveryPhraseWarning")}</p>
        <label className="field-check">
          <input
            type="checkbox"
            data-autofocus
            checked={written}
            onChange={(event) => {
              setWritten(event.target.checked);
            }}
          />
          {t("recoveryPhraseWritten")}
        </label>
      </>
    );
  } else if (step.kind === "unlock") {
    primary = t("encryptionUnlock");
    back = { kind: "list" };
    body = (
      <label className="field">
        {t("recoveryPhrase")}
        <textarea
          rows={4}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          required
          data-autofocus
          value={phrase}
          aria-describedby="recovery-phrase-hint"
          onChange={(event) => {
            setPhrase(event.target.value);
          }}
        />
        <span id="recovery-phrase-hint" className="hint">
          {t("recoveryPhraseUnlockHint")}
        </span>
      </label>
    );
  } else if (step.kind === "address") {
    primary = t("continueStep");
    back = accounts === undefined || accounts.length === 0 ? undefined : { kind: "list" };
    body = (
      <label className="field">
        {t("serverAddress")}
        <input
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          required
          data-autofocus
          value={address}
          aria-describedby="server-address-hint"
          onChange={(event) => {
            setAddress(event.target.value);
          }}
        />
        <span id="server-address-hint" className="hint">
          {t("serverAddressHint")}
        </span>
      </label>
    );
    body = (
      <>
        {body}
        <button
          type="button"
          className="quiet"
          disabled={busy}
          onClick={() => {
            setError(undefined);
            setStatus(undefined);
            setStep({ kind: "join" });
          }}
        >
          {t("invitationJoin")}
        </button>
      </>
    );
  } else if (step.kind === "setup") {
    const { url } = step;
    primary = t("setUpAction");
    back =
      only === undefined
        ? { kind: "address" }
        : accounts === undefined || accounts.length === 0
          ? undefined
          : { kind: "list" };
    body = (
      <fieldset>
        <legend>{t("setUpServer", { server: hostOf(url) })}</legend>
        <p className="hint">{t("setUpServerHint")}</p>
        <label className="field">
          {t("setupCode")}
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            data-autofocus
            value={setupCode}
            aria-describedby="setup-code-hint"
            onChange={(event) => {
              setSetupCode(event.target.value);
            }}
          />
          <span id="setup-code-hint" className="hint">
            {t("setupCodeHint")}
          </span>
        </label>
        <label className="field">
          {t("yourName")}
          <input
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <label className="field">
          {t("emailAddress")}
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </label>
        <label className="field">
          {t("password")}
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={password}
            aria-describedby="setup-password-hint"
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <span id="setup-password-hint" className="hint">
            {t("newPasswordHint")}
          </span>
        </label>
        <label className="field">
          {t("firstWorkspace")}
          <input
            type="text"
            required
            value={workspace}
            onChange={(event) => {
              setWorkspace(event.target.value);
            }}
          />
        </label>
      </fieldset>
    );
  } else if (step.kind === "signIn" && asksAddress(step)) {
    const { url } = step;
    primary = t("continueStep");
    back =
      only === undefined
        ? { kind: "address" }
        : accounts === undefined || accounts.length === 0
          ? undefined
          : { kind: "list" };
    body = (
      <fieldset>
        <legend>{t("signInTo", { server: hostOf(url) })}</legend>
        <label className="field">
          {t("emailAddress")}
          <input
            type="email"
            autoComplete="username"
            required
            data-autofocus
            value={email}
            aria-describedby="sign-in-address-hint"
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <span id="sign-in-address-hint" className="hint">
            {t("signInAddressHint")}
          </span>
        </label>
      </fieldset>
    );
  } else if (step.kind === "signIn" && step.ways === "providers") {
    const { url, methods } = step;
    primary = t("signIn");
    back = { kind: "signIn", url, methods };
    body = (
      <fieldset>
        <legend>{t("signInTo", { server: hostOf(url) })}</legend>
        <p className="hint">{t("signInThroughProvider", { email: email.trim() })}</p>
        {methods.oidc === null ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              withProvider(url);
            }}
          >
            {t("signInWith", { name: methods.oidc.name })}
          </button>
        )}
        {methods.sso.map((provider, index) => (
          <button
            key={provider.id}
            type="button"
            className={index === 0 && methods.oidc === null ? "primary" : undefined}
            disabled={busy}
            {...(index === 0 ? { "data-autofocus": true } : {})}
            onClick={() => {
              withProvider(url, provider.id);
            }}
          >
            {t("signInWith", { name: provider.name })}
          </button>
        ))}
        {methods.password || methods.emailCode ? (
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() => {
              setError(undefined);
              setStep({ kind: "signIn", url, methods, ways: "admin" });
            }}
          >
            {t("signInAsAdmin")}
          </button>
        ) : null}
      </fieldset>
    );
  } else if (step.kind === "signIn") {
    const { url, methods } = step;
    primary = t("signIn");
    back =
      step.ways !== undefined
        ? { kind: "signIn", url, methods }
        : only === undefined
          ? { kind: "address" }
          : accounts === undefined || accounts.length === 0
            ? undefined
            : { kind: "list" };
    body = (
      <fieldset>
        <legend>{t("signInTo", { server: hostOf(url) })}</legend>
        {step.ways === "admin" ? <p className="hint">{t("signInAsAdminHint")}</p> : null}
        {methods.password || methods.emailCode ? (
          <label className="field">
            {t("emailAddress")}
            <input
              type="email"
              autoComplete="username"
              required
              {...(step.ways === undefined ? { "data-autofocus": true } : {})}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </label>
        ) : null}
        {methods.password ? (
          <label className="field">
            {t("password")}
            <input
              type="password"
              autoComplete="current-password"
              required
              // With the address given already, the password is next.
              {...(step.ways === undefined ? {} : { "data-autofocus": true })}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          </label>
        ) : null}
        {methods.emailCode ? (
          <button
            type="button"
            className="quiet"
            disabled={busy || email.trim() === ""}
            onClick={() => {
              emailCode(url, methods);
            }}
          >
            {t("emailMeCode")}
          </button>
        ) : null}
        {methods.oidc === null ? null : (
          <button
            type="button"
            // The main way in when the server takes no password or code.
            className={methods.password || methods.emailCode ? "quiet" : "primary"}
            disabled={busy}
            {...(methods.password || methods.emailCode ? {} : { "data-autofocus": true })}
            onClick={() => {
              withProvider(url);
            }}
          >
            {t("signInWith", { name: methods.oidc.name })}
          </button>
        )}
        {methods.sso.map((provider, index) => {
          // The first is the main way in when the server takes no password, code or provider of its own.
          const main =
            !methods.password && !methods.emailCode && methods.oidc === null && index === 0;
          return (
            <button
              key={provider.id}
              type="button"
              className={main ? "primary" : "quiet"}
              disabled={busy}
              {...(main ? { "data-autofocus": true } : {})}
              onClick={() => {
                withProvider(url, provider.id);
              }}
            >
              {t("signInWith", { name: provider.name })}
            </button>
          );
        })}
      </fieldset>
    );
  } else {
    primary = t("signIn");
    back = { kind: "signIn", url: step.url, methods: step.methods };
    body = (
      <>
        <p>{t("codeSent", { email: step.email })}</p>
        <label className="field">
          {t("signInCode")}
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            data-autofocus
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </label>
      </>
    );
  }
  // Only a password signs in with the main button, after the address where
  // that comes first; a server without one offers its other ways as their
  // own buttons, as the providers' step does.
  const showPrimary =
    step.kind !== "signIn" ||
    asksAddress(step) ||
    (step.methods.password && step.ways !== "providers");

  return (
    <div
      className="switcher-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="switcher dialog settings-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="servers-title"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={onKeyDown}
      >
        <h2 id="servers-title">{only === undefined ? t("servers") : t("webAccount")}</h2>
        {/* Nothing shows until the servers signed in to are known. */}
        <div className="dialog-body">{accounts === undefined ? null : body}</div>
        <p role="status">{status}</p>
        {error === undefined ? null : <p role="alert">{error}</p>}
        <div className="dialog-actions">
          {back === undefined ? null : (
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                setStep(back);
              }}
            >
              {t("back")}
            </button>
          )}
          {browser === undefined ? null : (
            <button
              type="button"
              className="quiet"
              onClick={() => {
                cancelled.current = true;
                void browser.close();
              }}
            >
              {t("cancel")}
            </button>
          )}
          {showPrimary ? (
            <button
              type="submit"
              className="primary"
              disabled={busy || (step.kind === "keys" && !written)}
              {...(step.kind === "list" ? { "data-autofocus": true } : {})}
            >
              {primary}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
