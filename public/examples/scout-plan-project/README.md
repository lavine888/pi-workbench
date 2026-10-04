# Synthetic reading-list CLI

A deliberately small, dependency-free project for trying pi-workbench's `/scout-and-plan` workflow. Titles and records are synthetic. It has no provider configuration, credentials, external services, or model calls.

From this sample's directory:

```console
node src/cli.mjs
node src/cli.mjs --status reading
node --test test/catalog.test.mjs
```

No package installation is needed. The current CLI supports only `--status`; the proposed `--tag` option is deliberately unimplemented. The four baseline tests exercise the existing catalog behavior, not Pi or subagent integration.

Read [TASK.md](TASK.md) for the planning task and [EXPECTED_PLAN.md](EXPECTED_PLAN.md) for the human-written acceptance rubric. The rubric is not a captured model response. Do not feed it to the agents if you want to independently assess their findings.
