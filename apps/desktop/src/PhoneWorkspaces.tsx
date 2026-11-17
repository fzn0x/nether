// The phone's welcome screen, for its servers (ADR 0087): signing in, and
// the workspaces of each account signed in to, each opened as a new vault on
// the phone, linked to it, which the workspace fills as it syncs. Loaded in
// the mobile build only.
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { backend } from "./backend.ts";
import { t } from "./messages.ts";
import type { VaultInfo } from "./mygo.ts";
import { type Workspace, account } from "./server.ts";
import { type VaultLink, hostOf } from "./sync.ts";

const ServersDialog = lazy(() =>
  import("./ServersDialog.tsx").then(({ ServersDialog: dialog }) => ({ default: dialog })),
);

/** A server signed in to, and its account's workspaces, or why they cannot be read. */
interface Listed {
  readonly url: string;
  readonly workspaces?: readonly Workspace[];
  readonly problem?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PhoneWorkspaces(props: { readonly onOpen: (vault: VaultInfo) => void }) {
  const { onOpen } = props;
  const [listed, setListed] = useState<readonly Listed[]>([]);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    const servers = await backend.servers();
    setListed(
      await Promise.all(
        servers.map(async ({ url }): Promise<Listed> => {
          const token = await backend.serverToken(url);
          if (token === undefined)
            return { url, problem: t("syncSignedOut", { server: hostOf(url) }) };
          try {
            return { url, workspaces: (await account(backend.serverFetch, url, token)).workspaces };
          } catch (reason) {
            return { url, problem: messageOf(reason) };
          }
        }),
      ),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (server: string, workspace: Workspace) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (workspace.encrypted) {
        // Its key must open on this phone before it can sync here.
        const token = await backend.serverToken(server);
        if (token === undefined) throw new Error(t("syncSignedOut", { server: hostOf(server) }));
        const { workspaceEncryption } = await import("./encryption.ts");
        await workspaceEncryption(server, token, workspace.id);
      }
      const link: VaultLink = {
        server,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        ...(workspace.encrypted ? { encrypted: true } : {}),
      };
      if (backend.openWorkspace === undefined) return;
      onOpen(await backend.openWorkspace(link));
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="recent" aria-labelledby="phone-servers-title">
      <h2 id="phone-servers-title">{t("phoneServers")}</h2>
      {listed.map((server) => (
        <div key={server.url}>
          <h3 className="vault-path">{hostOf(server.url)}</h3>
          {server.problem === undefined ? null : <p className="hint">{server.problem}</p>}
          {server.workspaces === undefined ? null : server.workspaces.length === 0 ? (
            <p className="hint">{t("webNoWorkspaces")}</p>
          ) : (
            <ul>
              {server.workspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    type="button"
                    className="vault-link"
                    disabled={busy}
                    aria-label={t("phoneOpenWorkspace", {
                      name: workspace.name,
                      server: hostOf(server.url),
                    })}
                    onClick={() => void open(server.url, workspace)}
                  >
                    <span className="vault-name">{workspace.name}</span>
                    {workspace.encrypted ? (
                      <span className="vault-path">{t("webEncrypted")}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {error === undefined ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            setDialog(true);
          }}
        >
          {listed.length === 0 ? t("phoneSignIn") : t("phoneServersManage")}
        </button>
        <p className="hint">{t("phoneServersHint")}</p>
      </div>
      {dialog ? (
        <Suspense fallback={null}>
          <ServersDialog
            onAccount={() => {
              void load();
            }}
            onClose={() => {
              setDialog(false);
              void load();
            }}
          />
        </Suspense>
      ) : null}
    </section>
  );
}
