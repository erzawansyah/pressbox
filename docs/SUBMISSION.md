# lablab submission text

**Project title:** PressBox

**Short description (one line):**
Chat with your WordPress site: an AI agent builds each change in a disposable Vultr sandbox, a deterministic gate checks it, and you approve before it reaches production.

**Long description:**

WordPress runs about 43% of the web, and changing a live site is still risky: one bad plugin or code edit takes it down. An AI agent that edits production directly makes this worse, because it writes and runs PHP on the server that holds customer data.

PressBox lets a site owner change their WordPress site by chatting, without the agent ever touching production. Each request clones production into a fresh Docker container on a Vultr VM: secrets redacted, no network route out (no internet, no cloud metadata, no production), no API keys, capabilities dropped, non-root, CPU/RAM/process limits, and PHP limits copied from production. The agent, an LLM on Vultr Serverless Inference (DeepSeek V4.1 Flash), works only through sandboxed tools: it writes the feature into the site's single custom plugin, runs allow-listed WP-CLI, tests the pages, reads PHP errors and fixes its own mistakes, following the official WordPress Agent Skills.

A deterministic gate, not the model, decides whether the result may ship: PHP lint, every page renders, no fatal errors, no dangerous functions, no unapproved outbound calls, PHP extensions match production, admin accounts unchanged. The owner previews the sandbox site and reads the exact diff, then applies: PressBox backs up production, replays the changeset, health-checks it and rolls back automatically on failure. The sandbox database is never copied back. The sandbox is destroyed after every task, and the destruction is verified and logged.

A PressBox MU-plugin ships inside every managed site. It reports the web server's real PHP profile, which becomes the constraint set for sandboxes, the agent and the gate, and it locks plugin installs in wp-admin so every change goes through PressBox: one theme, one plugin, no plugin pile.

Measured on the Vultr VM: a reservation-form request goes from chat to gate-approved preview in 34–47 seconds for about $0.02–0.04 of inference; an external-API request and a runaway loop are both blocked and the sandbox destroyed.

**Containment moment in the video:** 3:20 (sandbox destroyed after apply) and 3:30 (outbound call blocked, sandbox destroyed, production untouched).

**Technologies:** Vultr Cloud Compute, Vultr Serverless Inference, Vultr API, Docker, WordPress, WP-CLI, Node.js, SQLite.

**Tags:** AI agents, sandbox, WordPress, containment, Vultr, code execution.

**Links:**
- Live demo: http://149.28.138.40:8300 (app: /app)
- Production demo site: http://149.28.138.40:8080
- Repository: https://github.com/erzawansyah/pressbox
- Judge access code: _(put the code in the private judges field, never in this public file)_

**Team:** Ngorbit Lab (Muhamad Erza Wansyah).
