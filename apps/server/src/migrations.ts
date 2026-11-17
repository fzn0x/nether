// The database's schema, as numbered migrations of plain SQL that run when
// the server starts (ADR 0031). They run in one transaction, under a lock
// every server node takes, so several starting at once apply each once, and
// a failed one leaves the database as it was.
//
// Migrations expand, and contract a release later (ADR 0082): most only
// add, so the previous release's server runs on the new schema, as it does
// during a rolling upgrade. A step that renames, drops or narrows what an
// older server reads says which schema version first stopped reading it,
// and a server older than that refuses the database.
import type { Database } from "./db.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /**
   * A contract step's: the schema version of the first release that no
   * longer needed what it removes. A server at that version or later may
   * run on a database that has the step; one that only adds has none.
   */
  readonly readableFrom?: number;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "accounts, workspaces and their members",
    sql: `
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        -- The address as it is compared: lowercase, so one person has one account.
        email_key text NOT NULL UNIQUE,
        name text NOT NULL,
        -- An argon2id hash, as its encoded string; none for an account that signs in otherwise.
        password_hash text,
        instance_admin boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- A workspace, also called a vault: the unit of sync, permission and encryption.
      CREATE TABLE workspaces (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        encryption text NOT NULL DEFAULT 'none' CHECK (encryption IN ('none', 'end-to-end')),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE memberships (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, user_id)
      );

      CREATE INDEX memberships_by_user ON memberships (user_id);
    `,
  },
  {
    version: 2,
    name: "sessions and invitations",
    sql: `
      -- A signed-in client. Only its token's SHA-256 is kept, so this table signs no one in.
      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        -- The client's User-Agent, for its owner to tell their sessions apart.
        client text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        used_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );

      CREATE INDEX sessions_by_user ON sessions (user_id);

      CREATE TABLE invitations (
        id uuid PRIMARY KEY,
        token_hash text NOT NULL UNIQUE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
        -- When set, only this address may accept.
        email text,
        invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
        accepted_at timestamptz
      );

      CREATE INDEX invitations_by_workspace ON invitations (workspace_id);
    `,
  },
  {
    version: 3,
    name: "sign-in codes",
    sql: `
      -- A code emailed to sign in with, kept as its SHA-256; one per account at a time.
      CREATE TABLE sign_in_codes (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        code_hash text NOT NULL,
        tries integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );

      CREATE INDEX sign_in_codes_by_user ON sign_in_codes (user_id);
    `,
  },
  {
    version: 4,
    name: "identities from OpenID Connect providers",
    sql: `
      -- Who an account is at an identity provider: its issuer and the subject it names.
      CREATE TABLE identities (
        issuer text NOT NULL,
        subject text NOT NULL,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (issuer, subject)
      );

      CREATE INDEX identities_by_user ON identities (user_id);

      -- A sign-in through the provider, from the app's start to the app's
      -- redeeming it. Only hashes of the state and the handoff code are kept.
      CREATE TABLE oidc_flows (
        id uuid PRIMARY KEY,
        state_hash text NOT NULL UNIQUE,
        nonce text NOT NULL,
        -- The server's PKCE verifier, for the provider.
        verifier text NOT NULL,
        -- Where the browser goes back to the app, and the app's own PKCE challenge.
        redirect text NOT NULL,
        challenge text NOT NULL,
        invitation_hash text,
        -- Set once the provider has answered.
        handoff_hash text UNIQUE,
        user_id uuid REFERENCES users (id) ON DELETE CASCADE,
        workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: "documents",
    sql: `
      -- Numbers each store of a document, so a client asks what changed since one.
      CREATE SEQUENCE document_seq;

      -- A workspace's Yjs documents, merged: its vault document, named vault,
      -- and each note's, named by the note's ID.
      CREATE TABLE documents (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name text NOT NULL,
        state bytea NOT NULL,
        seq bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, name)
      );

      CREATE INDEX documents_by_seq ON documents (workspace_id, seq);
    `,
  },
  {
    version: 6,
    name: "end-to-end encryption",
    sql: `
      -- An account's key pair for encrypted workspaces: its public key, and its
      -- private key in a box only its recovery phrase opens, which the server cannot.
      CREATE TABLE user_keys (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        public_key bytea NOT NULL,
        recovery_box bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- An encrypted workspace's key, as a client sealed it to each member's public key.
      CREATE TABLE workspace_keys (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        version integer NOT NULL,
        sealed_key bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, user_id, version)
      );

      -- An encrypted workspace's documents: each update as its client encrypted
      -- it, numbered from the documents' sequence; a snapshot replaces those before it.
      CREATE TABLE encrypted_updates (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name text NOT NULL,
        seq bigint NOT NULL,
        data bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, name, seq)
      );

      CREATE INDEX encrypted_updates_by_seq ON encrypted_updates (workspace_id, seq);
    `,
  },
  {
    version: 7,
    name: "attachments",
    sql: `
      -- A workspace's files, by the SHA-256 of their bytes, which the blob store keeps.
      CREATE TABLE attachments (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        hash text NOT NULL,
        size bigint NOT NULL,
        content_type text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, hash)
      );
    `,
  },
  {
    version: 8,
    name: "document versions",
    sql: `
      -- Each note's earlier states (ADR 0041): the state a store replaced, when
      -- the note's last version was ten minutes old, kept as long as the admin says.
      CREATE TABLE document_versions (
        id bigserial PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name text NOT NULL,
        state bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX document_versions_by_note ON document_versions (workspace_id, name, created_at);
      CREATE INDEX document_versions_by_age ON document_versions (created_at);
    `,
  },
  {
    version: 9,
    name: "units",
    sql: `
      -- A workspace's sync units besides General (ADR 0042): teamspaces, private
      -- spaces and shared pages, each with its own vault document.
      CREATE TABLE units (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('team', 'private', 'page')),
        -- A teamspace's name, which its folder has.
        name text,
        -- A private space's member.
        owner_id uuid REFERENCES users (id) ON DELETE CASCADE,
        -- A shared page's note, the root of its subtree, and the unit it sits
        -- in (none for General); restricted, only its grants open it.
        root_note text,
        parent_id uuid REFERENCES units (id) ON DELETE RESTRICT,
        restricted boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, root_note)
      );

      CREATE UNIQUE INDEX units_teamspace_names ON units (workspace_id, lower(name))
        WHERE kind = 'team';
      CREATE UNIQUE INDEX units_private_spaces ON units (workspace_id, owner_id)
        WHERE kind = 'private';

      -- Who may open a unit, at which level.
      CREATE TABLE unit_grants (
        unit_id uuid NOT NULL REFERENCES units (id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        level text NOT NULL CHECK (level IN ('full', 'edit', 'comment', 'view')),
        PRIMARY KEY (unit_id, user_id)
      );

      -- The unit each note is in; a note not here is in General. A unit with
      -- notes is not deleted, so they never fall to General by accident.
      CREATE TABLE note_units (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        note text NOT NULL,
        unit_id uuid NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
        PRIMARY KEY (workspace_id, note)
      );

      CREATE INDEX note_units_by_unit ON note_units (unit_id);
    `,
  },
  {
    version: 10,
    name: "page invitations",
    sql: `
      -- An invitation to one shared page, at a level: accepted, it makes a guest
      -- who opens that page alone (ADR 0042).
      ALTER TABLE invitations
        ADD COLUMN unit_id uuid REFERENCES units (id) ON DELETE CASCADE,
        ADD COLUMN level text CHECK (level IN ('full', 'edit', 'comment', 'view'));
    `,
  },
  {
    version: 11,
    name: "notifications",
    sql: `
      -- What someone is told of in the app, and by email: a mention of them by
      -- another member, in a note's comments (ADR 0045). The title and the
      -- excerpt are the client's, and none for an encrypted workspace.
      CREATE TABLE notifications (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
        kind text NOT NULL CHECK (kind IN ('mention')),
        note text NOT NULL,
        thread text,
        title text,
        excerpt text,
        created_at timestamptz NOT NULL DEFAULT now(),
        read_at timestamptz
      );

      CREATE INDEX notifications_by_user ON notifications (user_id, created_at DESC);
      CREATE INDEX notifications_by_age ON notifications (created_at);

      -- Whether an account is emailed when it is mentioned.
      ALTER TABLE users ADD COLUMN email_notifications boolean NOT NULL DEFAULT true;
    `,
  },
  {
    version: 12,
    name: "search",
    sql: `
      -- What workspace search reads of each note the server can read
      -- (ADR 0050): its path and title from its unit's vault document, and
      -- its text, tags and properties from its own. A note no vault
      -- document lists has no path, and is not found.
      CREATE TABLE note_search (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        note text NOT NULL,
        path text NOT NULL DEFAULT '',
        title text NOT NULL DEFAULT '',
        body text NOT NULL DEFAULT '',
        tags text[] NOT NULL DEFAULT '{}',
        properties jsonb NOT NULL DEFAULT '{}',
        search tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', title), 'A') ||
          setweight(to_tsvector('simple', body), 'B')
        ) STORED,
        PRIMARY KEY (workspace_id, note)
      );

      CREATE INDEX note_search_text ON note_search USING gin (search);

      -- The notes stored before this, indexed once as the server starts.
      CREATE TABLE search_backfill (pending boolean PRIMARY KEY);
      INSERT INTO search_backfill VALUES (true);
    `,
  },
  {
    version: 13,
    name: "backups",
    sql: `
      -- When the last scheduled backup began (ADR 0052): a node claims the
      -- next by moving it on, so of several nodes one makes each backup.
      CREATE TABLE backup_state (
        only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
        last_started timestamptz
      );
      INSERT INTO backup_state (only_row) VALUES (true);
    `,
  },
  {
    version: 14,
    name: "the public API: tokens, and notes listed by path",
    sql: `
      -- A token for the public API (ADR 0059), acting as its account, read
      -- only or read and write, for one workspace or all of the account's.
      -- Kept as its SHA-256, with its last characters for its owner to tell
      -- it from the others.
      CREATE TABLE api_tokens (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        hint text NOT NULL,
        access text NOT NULL CHECK (access IN ('read', 'write')),
        workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        used_at timestamptz
      );

      CREATE INDEX api_tokens_by_user ON api_tokens (user_id, created_at);

      -- The API lists a workspace's notes by path, a page at a time.
      CREATE INDEX note_search_by_path ON note_search (workspace_id, path COLLATE "C", note);
    `,
  },
  {
    version: 15,
    name: "webhooks",
    sql: `
      -- A workspace's webhooks (ADR 0060), made by an owner or admin who stays
      -- their maker, and go when the maker leaves the workspace. The secret
      -- is kept as it is, since the server signs with it.
      CREATE TABLE webhooks (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL,
        maker_id uuid NOT NULL,
        url text NOT NULL,
        secret text NOT NULL,
        events text[] NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        -- Since when its deliveries fail with no success between, and why.
        failing_since timestamptz,
        last_error text,
        -- Until when a node is sending to it, so one node sends to it at a time.
        sending_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (workspace_id, maker_id)
          REFERENCES memberships (workspace_id, user_id) ON DELETE CASCADE
      );

      CREATE INDEX webhooks_by_workspace ON webhooks (workspace_id);

      -- Notes changed in a workspace with webhooks, one row a note, each told
      -- when it is due: 30 seconds after its last store, at most five
      -- minutes after its first.
      CREATE TABLE webhook_changes (
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        note text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('created', 'updated', 'deleted')),
        -- Where it last was, which a removed note's event carries.
        path text NOT NULL,
        first_at timestamptz NOT NULL,
        last_at timestamptz NOT NULL,
        due_at timestamptz NOT NULL,
        PRIMARY KEY (workspace_id, note)
      );

      CREATE INDEX webhook_changes_by_due ON webhook_changes (due_at);

      -- Events for a webhook: waiting, sent or failed, kept seven days after.
      -- The body is the same on every try.
      CREATE TABLE webhook_deliveries (
        id uuid PRIMARY KEY,
        webhook_id uuid NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
        type text NOT NULL,
        body text NOT NULL,
        status text NOT NULL CHECK (status IN ('waiting', 'sent', 'failed')),
        attempts integer NOT NULL DEFAULT 0,
        next_at timestamptz,
        -- The last answer's status, or why there was none.
        answer integer,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      );

      CREATE INDEX webhook_deliveries_waiting ON webhook_deliveries (webhook_id, next_at)
        WHERE status = 'waiting';
      CREATE INDEX webhook_deliveries_by_webhook ON webhook_deliveries (webhook_id, created_at);
      CREATE INDEX webhook_deliveries_finished ON webhook_deliveries (finished_at)
        WHERE status <> 'waiting';
    `,
  },
  {
    version: 16,
    name: "share links, and the visits they start",
    sql: `
      -- A link that opens a page shared on its own to anyone with it
      -- (ADR 0071), kept as it is so that it can be copied again.
      CREATE TABLE share_links (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        unit_id uuid NOT NULL REFERENCES units (id) ON DELETE CASCADE,
        token text NOT NULL UNIQUE,
        level text NOT NULL CHECK (level IN ('view', 'comment', 'edit')),
        -- An argon2id hash, as an account's password is; none for a link without one.
        password_hash text,
        expires_at timestamptz,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX share_links_by_unit ON share_links (unit_id, created_at);

      -- A visit a link started, by its token's SHA-256; it ends with its link.
      CREATE TABLE link_visits (
        token_hash text PRIMARY KEY,
        link_id uuid NOT NULL REFERENCES share_links (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );

      CREATE INDEX link_visits_by_link ON link_visits (link_id);
    `,
  },
  {
    version: 17,
    name: "the switch that turns AI off for a workspace",
    sql: `
      -- Whether its members' apps offer AI in it (ADR 0068): on until an
      -- owner or admin turns it off.
      ALTER TABLE workspaces ADD COLUMN ai boolean NOT NULL DEFAULT true;
    `,
  },
  {
    version: 18,
    name: "AI providers kept by the server for the web app",
    sql: `
      -- A provider the web app's requests go to through the server (ADR
      -- 0070): an account's own, or with no account the instance's, which
      -- its admins set for everyone. Its key is sealed with the server's
      -- NETHER_SECRET_KEY, bound to the provider's ID; none for a model that
      -- needs none.
      CREATE TABLE ai_providers (
        id uuid PRIMARY KEY,
        user_id uuid REFERENCES users (id) ON DELETE CASCADE,
        name text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('openai', 'anthropic')),
        url text NOT NULL,
        model text NOT NULL,
        key_box bytea,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX ai_providers_by_user ON ai_providers (user_id, created_at);

      -- The provider an account's vaults use unless they choose another.
      CREATE TABLE ai_defaults (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        provider_id uuid NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 19,
    name: "published sites",
    sql: `
      -- Whether its notes may be published (ADR 0076): on until an owner or
      -- admin turns it off, when its sites answer as not there.
      ALTER TABLE workspaces ADD COLUMN publishing boolean NOT NULL DEFAULT true;

      -- A site: a note with its subpages, or a folder, published as the one
      -- who published it, who takes it with them when they leave.
      CREATE TABLE sites (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL,
        publisher_id uuid NOT NULL,
        -- Its address on this server, /p/<name>/.
        name text NOT NULL UNIQUE,
        title text NOT NULL,
        root_note text,
        root_folder text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((root_note IS NULL) <> (root_folder IS NULL)),
        UNIQUE (workspace_id, root_note),
        UNIQUE (workspace_id, root_folder),
        FOREIGN KEY (workspace_id, publisher_id)
          REFERENCES memberships (workspace_id, user_id) ON DELETE CASCADE
      );

      -- The files a site's pages showed, which it serves by their hash.
      CREATE TABLE site_files (
        site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
        hash text NOT NULL,
        PRIMARY KEY (site_id, hash)
      );
    `,
  },
  {
    version: 20,
    name: "sites' custom domains, and whether search engines index them",
    sql: `
      -- A custom domain a site claims (ADR 0077), with the value its TXT
      -- record at _nether-site.<domain> must have; verified once the record
      -- is found, when it names that site alone.
      ALTER TABLE sites ADD COLUMN domain text;
      ALTER TABLE sites ADD COLUMN domain_token text;
      ALTER TABLE sites ADD COLUMN domain_verified boolean NOT NULL DEFAULT false;
      CREATE UNIQUE INDEX sites_by_domain ON sites (domain) WHERE domain_verified;

      -- Whether its pages ask search engines to index them: yes until its
      -- publisher says no.
      ALTER TABLE sites ADD COLUMN indexed boolean NOT NULL DEFAULT true;
    `,
  },
  {
    version: 21,
    name: "the console's settings for the whole server",
    sql: `
      -- What the admin console sets for the whole server (ADR 0079): each
      -- enterprise feature's switch, under enterprise.<feature>, where the
      -- environment does not pin it.
      CREATE TABLE instance_settings (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    version: 22,
    name: "single sign-on's providers, their domains and their sign-ins",
    sql: `
      -- Single sign-on's providers (ADR 0080), set in the admin console:
      -- each SAML 2.0 or OpenID Connect, by a short name of the admin's,
      -- which its addresses carry, as /api/sso/<id>/saml/acs. The tables
      -- are in every schema, as the module is in every image (ADR 0079).
      CREATE TABLE sso_providers (
        id text PRIMARY KEY,
        kind text NOT NULL CHECK (kind IN ('saml', 'oidc')),
        -- For the apps' button.
        name text NOT NULL,
        -- Whether a first sign-in at one of its domains makes an account.
        make_accounts boolean NOT NULL DEFAULT true,
        -- What reaching and reading it takes, as the module keeps it.
        settings jsonb NOT NULL,
        -- Its secrets, sealed with NETHER_SECRET_KEY: SAML's key, OIDC's client secret.
        secrets bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      -- The email domains a provider is trusted for: one provider at most each.
      CREATE TABLE sso_domains (
        domain text PRIMARY KEY,
        provider_id text NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE
      );

      CREATE INDEX sso_domains_by_provider ON sso_domains (provider_id);

      -- A sign-in through a provider, from the app's start to the app's
      -- redeeming it, as oidc_flows are: only hashes of the state and the
      -- handoff code are kept.
      CREATE TABLE sso_flows (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL REFERENCES sso_providers (id) ON DELETE CASCADE,
        state_hash text NOT NULL UNIQUE,
        -- OpenID Connect's nonce and the server's PKCE verifier; none for SAML.
        nonce text,
        verifier text,
        -- SAML's AuthnRequest ID, which the answer must name; none for OpenID Connect.
        request_id text,
        redirect text NOT NULL,
        challenge text NOT NULL,
        invitation_hash text,
        handoff_hash text UNIQUE,
        user_id uuid REFERENCES users (id) ON DELETE CASCADE,
        workspace_id uuid REFERENCES workspaces (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );

      -- SAML's request IDs until answered, and the assertions received
      -- until they could no longer be accepted, so none counts twice.
      CREATE TABLE sso_kept (
        key text PRIMARY KEY,
        value text NOT NULL,
        expires_at timestamptz NOT NULL
      );
    `,
  },
  {
    version: 23,
    name: "audit log",
    sql: `
      -- The audit log (ADR 0081): what the server told of, each event chained
      -- to the one before by its hash. The audit module alone writes and
      -- reads it; it is here so a backup restores it. Names are kept as they
      -- were when the event happened.
      CREATE TABLE audit_events (
        seq bigint PRIMARY KEY,
        id uuid NOT NULL UNIQUE,
        at timestamptz NOT NULL,
        action text NOT NULL,
        outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
        reason text,
        -- account, visitor, anonymous or system.
        actor_type text NOT NULL,
        -- An account's ID, or a visitor's link's.
        actor_id text,
        actor_name text,
        actor_email text,
        token_id text,
        token_name text,
        workspace_id text,
        workspace_name text,
        target_type text,
        target_id text,
        target_name text,
        address text,
        user_agent text,
        details jsonb NOT NULL DEFAULT '{}',
        prev_hash text NOT NULL,
        hash text NOT NULL
      );
      CREATE INDEX audit_events_at ON audit_events (at);
      CREATE INDEX audit_events_actor ON audit_events (actor_id, seq);
      CREATE INDEX audit_events_email ON audit_events (lower(actor_email), seq);
      CREATE INDEX audit_events_workspace ON audit_events (workspace_id, seq);
      CREATE INDEX audit_events_action ON audit_events (action, seq);

      -- Append-only: no row changes, and none goes but those the retention
      -- purge names, through the setting it makes for its own transaction.
      CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.seq <= coalesce(
            nullif(current_setting('nether.audit_purge_through', true), ''), '0'
          )::bigint THEN
            RETURN OLD;
          END IF;
        END IF;
        RAISE EXCEPTION 'The audit log is append-only: % is refused.', TG_OP;
      END;
      $$;
      CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
      CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
    `,
  },
  {
    version: 24,
    name: "data policies for workspaces set apart",
    sql: `
      -- The data policy of a workspace an instance admin sets apart from
      -- every workspace's, which instance_settings keeps under
      -- policies.data (ADR 0088). Its settings are as the server reads them:
      -- one it does not know, or that is missing, narrows nothing.
      CREATE TABLE workspace_policies (
        workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
        policy jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    version: 25,
    name: "work that runs once across nodes, and each node's heartbeat",
    sql: `
      -- Work that runs once across the server's nodes (ADR 0082): each job's
      -- last start, and the node that claimed it, which a node claims when
      -- that start is older than the job's period.
      CREATE TABLE cluster_jobs (
        name text PRIMARY KEY,
        started_at timestamptz,
        node text
      );

      -- Each node, written every half a minute while it runs, and gone when it stops.
      CREATE TABLE cluster_nodes (
        id text PRIMARY KEY,
        name text NOT NULL,
        version text NOT NULL,
        started_at timestamptz NOT NULL,
        seen_at timestamptz NOT NULL
      );
    `,
  },
  {
    version: 26,
    name: "how each session began, and the providers single sign-on requires",
    sql: `
      -- How a session began (ADR 0080): password, code, oidc, invitation,
      -- setup, or sso, with single sign-on's provider beside it. A token
      -- keeps the method of the session that made it. Those begun before
      -- keep none, and enforcement ends them for the accounts it covers.
      ALTER TABLE sessions ADD COLUMN method text;
      ALTER TABLE sessions ADD COLUMN provider text;
      ALTER TABLE api_tokens ADD COLUMN method text;
      ALTER TABLE api_tokens ADD COLUMN provider text;

      -- Whether accounts at a provider's domains sign in through it alone.
      ALTER TABLE sso_providers ADD COLUMN required boolean NOT NULL DEFAULT false;
    `,
  },
];

/** The schema version this server writes and reads. */
export const schemaVersion = migrations.length;

/** A database a newer server has migrated, with a step this server's schema is too old for. */
export class NewerDatabase extends Error {
  readonly found: number;
  /** The oldest schema version a server may have to run on the database. */
  readonly needed: number;

  constructor(found: number, needed: number) {
    super(
      `The database's schema is at version ${String(found)}, newer than this server's ${String(schemaVersion)}, and needs a server at schema version ${String(needed)} or later: run the newer server, or restore a backup.`,
    );
    this.name = "NewerDatabase";
    this.found = found;
    this.needed = needed;
  }
}

/** The lock every node takes to migrate, by a number of Nether's own. */
const migrationLock = 7_446_872_101;

/**
 * Brings the database to this server's schema, or to an earlier version, as
 * a restore does to load a backup made at that version, and says from which
 * version to which. Versions in between are applied in order, in one
 * transaction, so a database may skip any number of them. A database a
 * newer server migrated is left as it is, unless a step since needs a
 * newer server than this one (`NewerDatabase`).
 */
export async function migrate(
  db: Database,
  upTo = schemaVersion,
): Promise<{ readonly from: number; readonly to: number }> {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [migrationLock]);
    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // A contract step's oldest schema that may run on it; none for one that only adds.
    await tx.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS readable_from integer");
    const { rows } = await tx.query(
      "SELECT max(version) AS version, max(readable_from) AS needed FROM schema_migrations",
    );
    const from = Number(rows[0]?.version ?? 0);
    const needed = Number(rows[0]?.needed ?? 0);
    if (from > schemaVersion && needed > schemaVersion) throw new NewerDatabase(from, needed);
    for (const migration of migrations) {
      if (migration.version <= from || migration.version > upTo) continue;
      await tx.query(migration.sql);
      await tx.query(
        "INSERT INTO schema_migrations (version, name, readable_from) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.readableFrom ?? null],
      );
    }
    return { from, to: Math.max(from, Math.min(upTo, schemaVersion)) };
  });
}
