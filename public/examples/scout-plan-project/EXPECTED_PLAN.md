# Human-written acceptance rubric

**This is a manually authored rubric, not model output and not evidence of a successful Pi run.** Wording and step order may vary. Assess whether the actual plan identifies the following evidence and requirements.

| Source evidence | Expected planning decision |
| --- | --- |
| `src/catalog.mjs:1` — `listBooks` | Extend the options with an optional tag; preserve order, avoid mutations, and combine filters |
| `src/cli.mjs:4` — argument parsing | Parse `--tag`, trim the value, reject missing/blank values, update usage, and pass the tag to `listBooks` |
| `src/cli.mjs:18` — data loading | Use the existing JSON data path; no new service or persistence layer is needed |
| `data/books.json:1` — synthetic records | Existing tags already provide examples; do not fabricate a need for a schema migration |
| `test/catalog.test.mjs:11` — baseline tests | Keep current coverage and add case-insensitive tag and combined-filter checks |
| `package.json` — test command | Add a CLI test if needed so invalid arguments are checked through a real process |

The plan should propose verification such as:

```console
node --test test/*.test.mjs
node src/cli.mjs --tag FICTION
node src/cli.mjs --status reading --tag fiction
```

These future `--tag` commands are **acceptance checks after implementation**. They do not work in the unchanged sample. After implementation, `--tag FICTION` should return `book-001`, `book-003`, and `book-004`; adding `--status reading` should return only `book-004`.

A planning-only run should leave the sample sources, tests, and records unchanged. Runtime `.pi` files are separate. A useful plan should discuss whitespace/empty values, case normalization, compatibility with `--status`, and testing the CLI's exit code. This rubric does not prescribe a particular algorithm or guarantee agent output.
