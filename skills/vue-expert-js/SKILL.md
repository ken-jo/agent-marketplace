---
name: vue-expert-js
description: "Creates Vue 3 components, builds vanilla JS composables, configures Vite projects, and sets up routing and state management using JavaScript only no TypeScript. Generates JSDoc-typed code with @typedef, @param, and @returns annotations for full type..."
triggers: [vue, expert]
---
# Vue Expert Js

Source: https://github.com/Jeffallan/claude-skills (vue-expert-js/SKILL.md, MIT).

Use this skill when the request matches this focus: Creates Vue 3 components, builds vanilla JS composables, configures Vite projects, and sets up routing and state management using JavaScript only no TypeScript. Generates JSDoc-typed code with @typedef, @param, and @returns annotations for full type...

Workflow:
1. Confirm the user's target, constraints, and the relevant files or systems.
2. Inspect existing project conventions before proposing new structure.
3. Apply the domain lens from this skill first, then keep changes scoped to the user's task.
4. Prefer verifiable outputs: code, commands, checklists, tests, migration steps, or review findings.
5. State assumptions and residual risks when the evidence is incomplete.

Guardrails:
- Do not invent APIs, credentials, endpoints, schema fields, or policy details.
- Do not include secrets in generated examples; use placeholders such as [api-key], [host], or [account].
- Keep responses concise unless the user asks for a full reference.

Output format:
- Lead with the concrete recommendation or result.
- Include file paths, commands, validation steps, or review findings when relevant.
- Separate blocker questions from optional follow-ups.
