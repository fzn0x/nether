// The admin console's Nodes section (ADR 0082): the server's nodes that
// wrote their heartbeat in the last two minutes, the one that answered this
// page marked. It is in every build, as the Features page is.
import { useCallback, useEffect, useState } from "react";
import { language, t } from "./messages.ts";
import { messageOf, webFetch, webServer } from "./web.ts";

interface ServerNode {
  readonly name: string;
  readonly version: string;
  readonly startedAt: string;
  readonly current: boolean;
}

function isServerNode(value: unknown): value is ServerNode {
  const node = value as Partial<ServerNode> | null;
  return (
    typeof node?.name === "string" &&
    typeof node.version === "string" &&
    typeof node.startedAt === "string" &&
    typeof node.current === "boolean"
  );
}

const when = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });

export function NodesSection() {
  const [nodes, setNodes] = useState<readonly ServerNode[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(async () => {
    const answer = await webFetch(`${webServer}/api/instance/nodes`);
    if (!answer.ok) throw new Error(await messageOf(answer));
    const body = (await answer.json()) as { readonly nodes?: unknown };
    setNodes(Array.isArray(body.nodes) ? body.nodes.filter(isServerNode) : []);
  }, []);

  useEffect(() => {
    load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [load]);

  return (
    <section className="admin-section" aria-labelledby="admin-nodes">
      <h2 id="admin-nodes">{t("adminNodes")}</h2>
      <p className="hint">{t("adminNodesIntro")}</p>
      {nodes === undefined ? null : (
        <ul className="admin-nodes">
          {nodes.map((node) => (
            <li key={`${node.name} ${node.startedAt}`}>
              {t("adminNode", {
                name: node.name,
                version: node.version,
                started: when.format(new Date(node.startedAt)),
              })}
              {node.current ? ` ${t("adminNodeCurrent")}` : null}
            </li>
          ))}
        </ul>
      )}
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}
