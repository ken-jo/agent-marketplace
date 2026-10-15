---
name: sre-engineer
description: "Defines service level objectives, creates error budget policies, designs incident response procedures, develops capacity models, and produces monitoring configurations and automation scripts for production systems. Use when defining SLIs/SLOs, managing..."
triggers: [sre, engineer]
---
# Sre Engineer

Source: https://github.com/Jeffallan/claude-skills (sre-engineer/SKILL.md, MIT).

Use this skill when the request matches this focus: Defines service level objectives, creates error budget policies, designs incident response procedures, develops capacity models, and produces monitoring configurations and automation scripts for production systems. Use when defining SLIs/SLOs, managing...

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
