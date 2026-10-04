# Planning task

Plan a `--tag <tag>` filter for this reading-list CLI. Do not implement it and do not modify files.

Requirements:

- Match a tag case-insensitively after trimming the provided tag.
- Combine `--tag` and the existing `--status` filter using AND semantics.
- Preserve the current output order and behavior when `--tag` is absent.
- Reject a missing or blank tag value with a nonzero exit code and a useful message.
- Cover matching, combination, invalid input, and existing behavior with tests.

Return a concrete implementation plan with relative file paths and line references from the actual source. Include functions to change, validation commands, and risks. Do not treat the human-written acceptance rubric as source evidence.
