---
description: Document workflow - scout reads code, worker generates documentation
---
Use agentScope: "project" and confirmProjectAgents: true for every subagent call.

Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to read and understand: $@
   - Read all relevant source files, interfaces, and exports
   - Understand the public API, usage patterns, and edge cases
2. Then, use the "worker" agent to generate documentation based on the previous step (use {previous} placeholder)
   - Generate README, JSDoc, or inline comments as appropriate
   - Include usage examples, API reference, and setup instructions

Execute this as a chain, passing output between steps via {previous}.