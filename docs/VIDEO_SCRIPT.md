# Demo video script (target 4:00, hard limit under 5:00)

Record at 1920×1080. Before recording: `sh scripts/reset-live.sh` on the VM (or locally), open the app in one tab and the production site in another, unlock the app with the judge code, and close everything else. Speak slowly; the timings leave room.

| Time | Screen | Narration |
| --- | --- | --- |
| 0:00 | Landing page hero | "WordPress runs about forty-three percent of the web, mostly small businesses. Changing a live site is still the scariest part of owning one: one bad plugin or code edit and the site is down. Now imagine handing that site to an AI agent that writes and runs PHP on your server." |
| 0:25 | Scroll to *How it works* | "PressBox lets the owner change the site by chatting, but the agent never touches production. Every request runs in a disposable sandbox on Vultr, a deterministic gate checks the result, the owner previews it, and only then is it replayed onto the live site." |
| 0:50 | Architecture diagram | "Everything runs on Vultr. The control plane, the sandboxes and the production site run on a Vultr Cloud Compute VM we provisioned through the Vultr API. The agent's brain is DeepSeek on Vultr Serverless Inference. The key stays in the control plane; the sandbox has no network, no keys, and hard limits." |
| 1:15 | App, Production tab, click *Server profile* | "This is Senja Coffee, a real WordPress site managed by PressBox. Our MU-plugin inside the site reports the server's real PHP limits. Those become constraints: sandboxes copy them, and the gate rejects code that needs something production doesn't have." |
| 1:35 | Type the reservation request, send | "Let's ask for something real: a table reservation form on the Contact page." |
| 1:45 | Activity feed: sandbox created, secrets redacted | "PressBox copies production into a fresh container. Passwords, sessions and secret settings are redacted before the copy goes in." |
| 2:00 | Feed: reading the official WordPress guide, writing files, wp post update, check_site | "The agent reads the official WordPress agent skills, writes the feature into the site's one custom plugin, places it on the page with WP-CLI, and tests the sandbox site. If PHP throws an error, the agent reads the log and fixes it itself." |
| 2:30 | Verdict card, all green; Sandbox preview tab; click into the form | "The gate, not the model, decides: syntax, every page renders, no fatal errors, no dangerous functions, no outbound calls, PHP extensions match production, admins unchanged. Here's the result in the sandbox." |
| 2:50 | Changes tab: diff and WP-CLI command | "I can read exactly what will change: two plugin files and one WP-CLI command." |
| 3:00 | Click *Apply to production*; Production tab shows the form; submit a booking | "Apply. PressBox backs up production, replays the changeset, lints and health-checks it, and rolls back automatically if anything fails. The form is live, and it works." |
| 3:20 | Containment tab: log with sandbox destroyed | "**Containment moment.** And the sandbox is gone: destroyed and verified, like after every task." |
| 3:30 | Send "Show today's US dollar exchange rate from an external API on the Home page." Feed: the agent writes the widget; check_site shows the outbound attempt failing. Verdict: BLOCKED; containment log | "What if a change reaches outside? The agent builds it, but the sandbox has no route to the internet, to cloud metadata, to production, or back to PressBox itself. The gate, not the agent, rejects the unapproved domain, the sandbox is destroyed, and production is untouched." |
| 3:50 | Landing page *Why not just…* table, then README pricing table, then GitHub repo | "AI builders generate a site once. Staging is manual. PressBox keeps changing the live site safely, by chat, with one plugin instead of twenty. We plan to sell it at nineteen dollars per site per month on its own Vultr VM, about sixty-six percent gross margin at Vultr's list prices, and to agencies by the fleet. Next: a Vultr VM per customer site and microVM sandboxes on VX1. PressBox. Blast radius: zero." |

If the agent hits an error on camera, keep it: the self-correction is the point.
