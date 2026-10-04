---
description: Refactor workflow - scout finds code, planner designs refactor, worker implements
---
Use agentScope: "project" and confirmProjectAgents: true for every subagent call.

Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code related to: $@
   - Identify the code structure, dependencies, and interfaces
2. Then, use the "planner" agent to design a refactoring plan for "$@" using the context from the previous step (use {previous} placeholder)
   - Focus on keeping the same external behavior
   - Identify extractable modules, cleaner patterns
3. Finally, use the "worker" agent to implement the refactoring plan from the previous step (use {previous} placeholder)
   - Keep changes minimal and reversible
   - Run existing tests to verify no regression

Execute this as a chain, passing output between steps via {previous}.