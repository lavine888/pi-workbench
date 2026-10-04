---
description: Debug workflow - scout finds the bug, worker fixes it
---
Use agentScope: "project" and confirmProjectAgents: true for every subagent call.

Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to investigate the bug or error: $@
   - Read error logs, stack traces, test output
   - Find the root cause and affected files
2. Then, use the "worker" agent to fix the bug found in the previous step (use {previous} placeholder)
   - Apply the minimal fix needed
   - Run verification to confirm the fix

Execute this as a chain, passing output between steps via {previous}.