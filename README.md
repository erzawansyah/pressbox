# PressBox

**Chat with your WordPress site. An AI agent does the work in an isolated sandbox on Vultr; you preview the result before it reaches production.**

Built for the [Vultr Agent Rush](https://lablab.build/ai-hackathons/vultr-hackathon) hackathon, Challenge 1: *Blast Radius Zero*.

> Work in progress. Full documentation (architecture, Vultr usage, containment, demo) is being written.

## How it works

1. You ask for a change in plain language ("add a table reservation form to the Contact page").
2. PressBox clones the production site into a **fresh disposable sandbox** (secrets redacted, no network, CPU/RAM/PID/time limits, non-root, all Linux capabilities dropped).
3. The agent (LLM on **Vultr Serverless Inference**) edits only the site's single custom plugin and runs allow-listed WP-CLI commands inside the sandbox. It tests the site, reads PHP errors, and fixes its own mistakes. It follows the official [WordPress Agent Skills](https://github.com/WordPress/agent-skills).
4. A **deterministic gate** (not the model) judges the result: PHP lint, every page renders, no fatal errors, no dangerous functions, no unapproved outbound connections, admin accounts unchanged.
5. You review a clickable preview and the exact changeset, then **apply to production**: the changeset is replayed after a backup, with automatic rollback. The sandbox database is never copied back.
6. The sandbox is destroyed.

## Run locally

```bash
cp .env.example .env   # set LLM_API_KEY (Vultr Serverless Inference) and LLM_MODEL
docker compose up -d --build
```

- PressBox app: http://localhost:8300
- Demo production site: http://localhost:8080 (wp-admin user `pemilik`)
- End-to-end test: `node scripts/smoke.mjs all`

Without `LLM_API_KEY` the app runs in clearly labeled scripted mode (pipeline test only).

## License

MIT (see `LICENSE`). The files in `control/knowledge/wp-agent-skills/` are from WordPress/agent-skills and remain under their GPL license (see the `NOTICE.md` there).
