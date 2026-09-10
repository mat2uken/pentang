---
name: pentang-lab-setup
description: Use when preparing or diagnosing the pentang validation host, toolchains, connected devices, or repeatable local lab state.
---

# pentang lab setup

Use the repository runner as the single entry point for setup and diagnosis:

```sh
npm run lab -- doctor --target all --phase tools
npm run lab -- setup --apply --target all
npm run lab -- targets list
```

Keep setup idempotent. `setup --apply` may run `npm ci` when dependencies are absent and records the result under ignored `.lab-state/`; it must not silently install an SDK, accept a license, unlock a device, or change signing credentials. Report missing tools as `BLOCKED` with the exact remedy.

Before a device run, select a serial or UDID explicitly. A connected or paired row only proves discovery; the device must also be unlocked, reachable, and pass the product checks. Redact identifiers in reports unless an operator supplied `--show-identifiers` for local diagnosis.

Ask the operator only for an unavoidable first-time OS action such as trust, unlock, permission, login, or cable/network setup. Once that prerequisite is satisfied, rerun the same command without asking for routine taps.
