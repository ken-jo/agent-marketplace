---
name: k-skill-wrapper
description: Overview and setup wrapper for the NomaDamas/k-skill Korean automation skill bundle; individual upstream skills are published as separate marketplace entries.
triggers: [k-skill-wrapper, k-skill, korea, korean]
---

# k-skill Wrapper

Use this wrapper when the user wants a high-level entrypoint for the upstream
`NomaDamas/k-skill` bundle or needs setup guidance before choosing a specific
Korean-local automation skill.

## Source

- Repository: `https://github.com/NomaDamas/k-skill`
- License: MIT

## Install

The individual upstream skills are published as separate Ave marketplace skill
packages. If the user wants the full upstream bundle installed outside Ave,
install it from the source repository:

```bash
npx --yes skills add NomaDamas/k-skill --all -g
```

After installing the upstream bundle, run `k-skill-setup` when credential or
proxy configuration is needed.

## Operating Policy

- Do not run persistent setup such as `cron`, `launchd`, `schtasks`, or GitHub
  starring without explicit user consent.
- When a workflow needs credentials, ask only for the specific required
  environment variable names and prefer the user's existing secret vault.
- Do not store secrets inside the repository. The upstream fallback location is
  `~/.config/k-skill/secrets.env` with file mode `0600`.
- For hosted-proxy workflows, use the upstream default proxy behavior unless the
  user explicitly provides a self-hosted proxy URL.

## Routing

Prefer the matching individual marketplace skill for concrete user requests,
such as `srt-booking`, `ktx-booking`, `korea-weather`, `kbo-results`,
`coupang-product-search`, `korean-law-search`, or `korean-patent-search`.
Use this wrapper only for bundle-level orientation and setup.
