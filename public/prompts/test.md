---
description: Test workflow - worker implements, then adds tests
---
Use agentScope: "project" and confirmProjectAgents: true for every subagent call.

Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@
   - Write the implementation code
2. Then, use the "worker" agent again to add tests for the implementation from the previous step (use {previous} placeholder)
   - Add unit tests covering the new code
   - Run the tests to verify they pass

Execute this as a chain, passing output between steps via {previous}.