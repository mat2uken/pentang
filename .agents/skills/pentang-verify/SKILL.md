---
name: pentang-verify
description: Use when running pentang regression profiles, selecting checks from changed files, or interpreting saved lab evidence.
---

# pentang verification

Run the smallest profile that proves the change, then widen it when the change classification requires it:

```sh
npm run lab -- run --profile fast
npm run lab -- run --profile affected --changed
npm run lab -- run --profile full --android-serial <serial> --ios-udid <udid> --preview-host <lan-host>
npm run lab -- report --run <run-id>
```

The runner records branch, HEAD, dirty state, source hash, commands, timings, output files, leases, and manual prerequisites in `.lab-state/runs/<run-id>/`. Keep that record tied to one run. `PASS` requires every selected step to pass; `BLOCKED` means a host/device prerequisite was unavailable; `FAIL` means the check ran and found a defect. Do not turn a failed assertion into an exploratory success.

Use DOM selectors and API assertions for known WebView screens. The packaged desktop profile exercises the debug-only embedded Tauri WebDriver endpoint, while release behavior remains a separate black-box check. Device profiles use explicit Android serials or iOS UDIDs and never guess a shared target.

When a run is interrupted, use `npm run lab -- cancel --run <run-id>` and inspect the saved logs before `resume`. Do not delete run evidence while diagnosing a regression.
