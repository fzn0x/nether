# 0084. The console's Security page sets session lengths, sign-in limits and email codes, unless the environment does

- Status: Accepted
- Date: 2026-11-17

## Context

The [requirements](../requirements.md#enterprise-features-free-and-open-source)
ask the admin console for "security settings in one place".
[ADR 0079](0079-enterprise-features-are-in-every-image-off-and-switched-in-the-console-or-pinned-by-the-environment.md)
named the Security page: the sign-in methods, the sessions' length and the
rate limits, set in one place, those the environment sets shown as set by
it.

What is fixed today:

- **Sessions** end after 30 days unused, or 90 days after they began
  ([ADR 0032](0032-sessions-are-bearer-tokens-and-accounts-come-by-invitation.md)),
  constants in `sessions.ts`. A session's end is written when it starts.
- **Rate limits** are constants at each route, in Valkey when it is set
  ([ADR 0054](0054-docker-compose-starts-the-server-with-postgresql-valkey-and-volumes.md)):
  signing in allows 30 tries per address in 5 minutes and 10 per account
  in 15; redeeming an email code, 30 per address in 5 minutes.
- **Sign-in methods**: a password always; a code by email whenever the
  server can send mail
  ([ADR 0033](0033-sign-in-by-email-with-a-code-and-the-link-with-the-web-app.md));
  the environment's OpenID Connect provider when it names one
  ([ADR 0034](0034-sign-in-with-openid-connect-through-the-server-and-back-to-the-app.md)).
- **Single sign-on** (ADR 0080, in progress) will require providers for
  some accounts or for everyone, on its own page.

## Decision

**Five settings, each the console's unless the environment pins it.**

| Setting | Default | Range | Pinned by |
| --- | --- | --- | --- |
| Days a session lasts unused | 30 | 1 to 365 | `NETHER_SESSION_IDLE_DAYS` |
| Days a session lasts however used | 90 | 1 to 3650 | `NETHER_SESSION_LIFETIME_DAYS` |
| Sign-in tries per account, in 15 minutes | 10 | 3 to 100 | `NETHER_SIGN_IN_TRIES_ACCOUNT` |
| Sign-in tries per address, in 5 minutes | 30 | 5 to 1000 | `NETHER_SIGN_IN_TRIES_ADDRESS` |
| Sign in with a code by email | on | on or off | `NETHER_SIGN_IN_EMAIL_CODES` |

- **They are kept in `instance_settings`**, as the switches are, and each
  server reads them again at most every five seconds. A change takes
  effect on every node within that, with no restart.
- **A pinned setting** shows its variable and no control, as a pinned
  switch does. A variable out of range stops the server at startup,
  saying which.
- **The page is the `admin` feature's**, with its routes. With it off, the
  values kept still apply and the environment still pins them; the page
  is hidden.
- **Core reads them; the module writes them.** Core keeps the settings'
  names, defaults, ranges and variables, and gives the module a way to
  read and set them, beside `disconnect` in what the server shares with
  every module. Core never imports the module.

**Session lengths apply to every session at once.** A session is used
while it was used within the idle days and began within the lifetime days,
as the settings are now, not as they were when it began. Shortening
either ends the sessions past it at their next request; lengthening keeps
them going. The end a session is given when it starts, and its cookie's,
still come from the lifetime of that moment.

**The limits apply to signing in.** The account and address limits are
those of `POST /api/sessions`; the address limit is also that of
redeeming an email code, which tries a code as signing in tries a
password. The other routes keep their own limits: they guard resources,
not accounts, and an admin has no reason to tune them.

**Email codes can be turned off.** Some organizations allow only passwords
and single sign-on. Off, the server says it offers no codes, and asking
for one or redeeming one answers 404. It shows only when the server can
send mail; without mail there are no codes to turn off.

**The sign-in methods are shown, not set, beside them.** The page lists
the password, email codes, the environment's OpenID Connect provider by
name, and, when single sign-on is on, a pointer to its page. Requiring a
provider, and with it turning passwords off for some or all accounts, is
single sign-on's enforcement, with its exemptions and its way back in
(ADR 0080). Turning passwords off here too would be two switches for one
thing, and this one without a way back in.

## Alternatives

- **Every rate limit on the page.** There are more than twenty, most
  guarding a resource, as the API's or a share link's. A page of numbers
  invites mistakes and is no safer.
- **Lengths that apply only to new sessions.** A shorter lifetime meant to
  end old sessions would take up to 90 days to.
- **Settings in the environment only**, as today. The requirement asks for
  them in one place, and a restart of every node to change one is the
  step ADR 0079 took the switches past.
- **Password sign-in off from this page.** Single sign-on's enforcement
  does it with its exemptions, and owns the way back in.

## Consequences

- An instance admin sets these in the console, or a host pins them with
  five new variables, each documented with its range.
- `sessionAccount` takes the lengths as they are now. `startSession` gives
  a session's end from the lifetime of that moment.
- A limit's maximum is read per request, from the settings kept for five
  seconds.
- Asking for an email code, or redeeming one, can answer 404 while the
  setting is off, as on a server without mail.
