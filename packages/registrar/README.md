# Registrar

The Worker that hands out `<name>.frizz.sh`. It records who owns a name; the [relay](../relay) serves
it. One wildcard DNS record covers every name, so a claim creates no infrastructure at all — which is
what removed the 200-name ceiling the original tunnel design could never get past.

It runs during signup and never again. **It is not on the data plane** — a board that is already
running keeps working whether or not this Worker is up, and nothing in Frizz has to reach it to stay
reachable. Protect that property above anything else here.

## How a name is owned

A name belongs to whoever holds an Ed25519 private key, kept at `identity.key` under Frizz's state root (`~/.frizz/` on an install that has that directory, the platform's state directory otherwise) on the
claiming machine. Every claim is signed; the signature covers the public key, so a request cannot be
re-attributed by swapping it. Ownership moves between machines the way an SSH key does: copy the file.

**A private name needs nothing more.** Twenty random base32 characters can't be squatted, so the
registrar recognizes that shape and waives the GitHub gate. Unauthenticated creation is capped at 10
names an hour per network address, and renewals never count against it.

**A custom name also needs a GitHub account, and that is the only thing standing between it and a
squatter.** The CLI asks `gh` for a token; the registrar spends it on `api.github.com/user`, keeps the
numeric id and discards the token. One name per account, and an account younger than 30 days cannot
claim. Nothing afterwards touches GitHub — the keypair alone renews the lease, so a name keeps working
whether or not GitHub does. Set `REQUIRE_GITHUB=0` to lift the gate on a test deployment; never on the
one anybody can reach.

A name is a **30-day lease**, renewed on every launch. An unrenewed name is released — on demand when
someone else asks for it, and by a daily sweep for names nobody wants.

## Deploying

Relay mode — the default — creates no Cloudflare resources, so it needs no API token. The secrets
below are read only when `CLOUD_MODE=tunnel` puts the old per-name tunnel path back.

```sh
cd packages/registrar

# 1. the registry: one small JSON row per claimed name
wrangler kv namespace create CLAIMS      # paste the id into wrangler.toml

# 2. ship it
wrangler deploy
```

Three things that will waste your time otherwise:

- **A WORKERS ROUTE BEATS A CUSTOM DOMAIN.** The relay owns `*.frizz.sh/*`, which swallowed
  `registrar.frizz.sh` the day it shipped and took signup down — the wildcard answered "No Frizz board
  has claimed this name." to every claim. `wrangler.toml` therefore declares BOTH the custom domain and
  a more specific `registrar.frizz.sh/*` route; the route is what wins. Do not remove either.
- **The deploy exits 1 unless the token can read Workers Routes.** Wrangler reconciles routes *after*
  uploading, so the Worker really is deployed and the failure is cosmetic — but any script treats it as
  a failed deploy. Add **Zone → Workers Routes → Edit** to the token for a clean exit.
- **Deleting a secret needs `--name`.** Plain `wrangler secret delete X --force` prints usage and
  silently does nothing, so a temporary override outlives the test that set it. Use
  `wrangler secret delete X --name frizz-registrar`, then `wrangler secret list --name frizz-registrar`
  to confirm.

Then point the CLI at it. The default is `https://registrar.frizz.sh`; override with `FRIZZ_REGISTRAR`
to test against a deployment before it takes that name.

```sh
FRIZZ_REGISTRAR=https://frizz-registrar.<subdomain>.workers.dev frizz --cloud
```

## The limits that shape this

A relay-served name costs one KV row and nothing else, so the ceiling is nominal: `MAX_NAMES_RELAY` is
100,000, and `MAX_NAMES` overrides it without a deploy.

That is the whole point of the relay, and it is worth knowing what it replaced. A name used to cost one
DNS record and one tunnel, and both are capped — 200 records on a free zone created after 2024-09-01,
3,500 on Pro, 1,000 tunnels per account. `CLOUD_MODE=tunnel` still walks that path, and everything in
`claim-handler.ts` that looks like fussy cleanup is from it: with a per-name tunnel, a leak on a failed
claim or a name that is never released is a countdown to new signups stopping for a reason nothing
points at.

## Verifying

The decision logic takes its side effects by injection, so it runs against fakes:

```sh
nub --test packages/registrar/src/          # the handler, the Worker, the Cloudflare client
nub scripts/verify-claim-e2e.mjs            # CLI client → real socket → real handler
```

`cloudflare.ts` was exercised against the live API on 2026-08-24, before the relay made it optional.
Two of its shapes came back different from the documentation, and both are commented where they bite:
a tunnel delete needs `?cascade=true` (`cloudflare.ts`), and an orphaned tunnel makes a name
permanently unclaimable with error 1013 unless `create()` reclaims it first (`claim-handler.ts`).
