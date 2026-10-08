# Testbed

Runs the SDK against a Subako deployment the `subako` CLI is already signed in
to — staging, production, or a local `subako-core serve` — and prepares the
credentials and the model config the examples publish their agents with.

```sh
pnpm testbed          # credentials: an api key and the model config, into testbed/.state
pnpm example chat     # one of examples/*: credentials, packages, its server, and Vite
pnpm testbed:down     # stop the example's server and Vite
```

| Piece        | Where                                                                           |
| ------------ | ------------------------------------------------------------------------------- |
| Credentials  | `testbed/cloud.sh` mints an api key with the CLI, into `testbed/.state/sdk.env` |
| Model config | `testbed/agent.json`, copied to `testbed/.state/agent-config.json`              |
| Examples     | `examples/*`, each with Vite on :5173 and its own server on :9800               |

## Which deployment it talks to

**The CLI reads its server from its credential profile, not from the
environment.** `SUBAKO_SERVER` does nothing; `subako profile list` is what says
where a profile is signed in, and the `*` marks the current one:

```
* kikuvi              org=kikuvi   server=https://api.us.cloud.subako.ai
  my-staging          org=…        server=https://api.us-stg.cloud.subako.ai
```

`testbed/cloud.sh` takes the current profile, and `SUBAKO_PROFILE` names another
without switching the current one. It reads the profile's server and workspace,
mints one api key, and writes `testbed/.state/sdk.env`. It mints nothing when
that file is already there, so rerunning it is free; delete the file to mint
another, and revoke the old key with `subako api-key revoke <id>`.

```sh
SUBAKO_CLI=~/Downloads/subako-test/subako SUBAKO_PROFILE=my-staging pnpm example todo
```

| Variable              | What it does                                                       |
| --------------------- | ------------------------------------------------------------------ |
| `SUBAKO_CLI`          | The CLI binary; `subako` on the PATH by default                    |
| `SUBAKO_PROFILE`      | The credential profile to act as; the current one by default       |
| `SUBAKO_AGENT_CONFIG` | The model config to publish; `testbed/agent.json` by default       |
| `EXAMPLE_PORT`        | The example server's port, 9800 by default                         |
| `EXAMPLE_WEB_PORT`    | Vite's port, 5173 by default; the example server opens CORS for it |

The workspace needs a live model provider whose `format` matches
`testbed/agent.json` — `openai_responses` as it ships. `subako model-provider
list` shows what the workspace has.

## Examples

`pnpm example <name>` runs one of `examples/*` against this deployment: it
mints the credentials if they are not there, builds the packages, starts the
example's own server on `EXAMPLE_PORT`, and serves the page with Vite on
`EXAMPLE_WEB_PORT`. `examples/README.md` lists them and says what each one
shows.

### Pointing at a different model

`testbed/agent.json` is the model config every example publishes: its `format`
picks the workspace's provider, and `SUBAKO_MODEL_PROVIDER_ID` names one
outright. The config is part of the agent's config hash, so changing it
republishes on the next start.
