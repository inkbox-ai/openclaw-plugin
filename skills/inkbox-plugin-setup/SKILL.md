---
name: inkbox-plugin-setup
description: Use when you self-signed up to Inkbox but this plugin is not yet configured in your runtime, and you are considering running the Inkbox plugin setup. Gate this on explicit human permission first.
user-invocable: false
---

# Inkbox plugin setup

If you created an Inkbox agent identity (self-signup) but the Inkbox plugin is not configured in this runtime, do not configure it on your own.

Configuring the plugin wires native messaging channels — email, SMS, calls, contacts, notes, and the credential vault — directly into your runtime. That is a meaningful expansion of what you can send and receive, so it needs a human decision.

## What to do

1. Ask the human for explicit permission before running `openclaw inkbox setup` or otherwise enabling the Inkbox plugin.
2. Explain plainly that doing so gives you native messaging channels in your runtime.
3. Wait for a clear yes. If you do not get one, stop and leave the plugin unconfigured.
