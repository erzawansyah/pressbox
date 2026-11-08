# WordPress Agent Skills (third-party)

These files are copied unmodified from the official **WordPress/agent-skills** repository
(https://github.com/WordPress/agent-skills, commit `7374e6f`), Copyright (C) 2026 WordPress Contributors,
licensed under the GNU General Public License (see `LICENSE` in this folder).

PressBox ships them as separate, unmodified documents that its agent reads at runtime through the
`wp_guide` tool. They are not compiled into or merged with PressBox's own (MIT-licensed) code.

Included subset:

- `plugin-development/` (from `wp-plugin-development`): SKILL.md, security, structure, lifecycle, data-and-cron, settings-api, debugging
- `wpcli-and-ops/` (from `wp-wpcli-and-ops`): SKILL.md, safety, cron-and-cache, debugging
- `block-themes/` (from `wp-block-themes`): SKILL.md, patterns, templates-and-parts, theme-json
- `block-development/` (from `wp-block-development`): dynamic-rendering, registration

Note: procedures in the SKILL.md files mention helper scripts (`node skills/...`). The PressBox agent has no
shell; it follows the guidance through its own tools (write_file, run_wp, check_site).
