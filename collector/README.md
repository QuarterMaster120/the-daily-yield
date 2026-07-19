# Local ZIP-gated CD collector

This free collector reads the public Citizens Bank rate feed and uses the installed Microsoft Edge browser on this computer for the Fifth Third and PNC ZIP rate forms. It queries only ZIPs that subscribers have selected and never receives subscriber email addresses.

It reads `RATE_COLLECTION_READ_TOKEN` and `RATE_COLLECTION_WRITE_TOKEN` from this Windows user's environment. Those credentials are intentionally not stored in source control or in the scheduled-task arguments.

Run one manual verification after the tokens are configured:

```powershell
npm run collector:fifth-third -- --dry-run
```

Install the weekday 4:45 AM local task:

```powershell
.\collector\install-rate-collector-task.ps1
```

Use `--headed` only while diagnosing a changed public form. A failed or blocked page is logged and does not replace the last valid observation.
