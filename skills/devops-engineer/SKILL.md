---
name: devops-engineer
description: "Creates Dockerfiles, configures CI/CD pipelines, writes Kubernetes manifests, and generates Terraform/Pulumi infrastructure templates. Handles deployment automation, GitOps configuration, incident response runbooks, and internal developer platform tooling..."
triggers: [devops, engineer]
---
# Devops Engineer

Source: https://github.com/Jeffallan/claude-skills (devops-engineer/SKILL.md, MIT).

Use this skill when the request matches this focus: Creates Dockerfiles, configures CI/CD pipelines, writes Kubernetes manifests, and generates Terraform/Pulumi infrastructure templates. Handles deployment automation, GitOps configuration, incident response runbooks, and internal developer platform tooling...

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
