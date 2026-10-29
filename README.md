# ios-safari-smoke

Manual GitHub Actions job: boots an iPhone simulator on a GitHub-hosted macOS runner, opens public pages in real Mobile Safari via Appium (xcuitest), and uploads screenshots + `summary.json`. Read-only: no logins, clicks, or form submits.

Run: `gh workflow run ios-safari-smoke.yml [-f paths=/a,/b]`
