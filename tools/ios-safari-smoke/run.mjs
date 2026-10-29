// iOS Safari simulator smoke — READ-ONLY against live prod.
//
// Drives real Mobile Safari on a booted iOS Simulator through Appium (xcuitest driver) using the
// plain W3C WebDriver JSON protocol (Node 22 fetch, no client library). Run by
// .github/workflows/ios-safari-smoke.yml (workflow_dispatch only, GitHub-hosted macOS runner).
//
// Per page: navigate, wait for readyState=complete + settle, then record title, final URL,
// scrollWidth vs innerWidth, submit-button heights, Safari console errors, an Appium screenshot
// and a full-device `xcrun simctl io <udid> screenshot` (real Safari chrome / address bar / safe
// area). No logins, no form submits, no clicks, no cart writes.
//
// Env: SIM_UDID (required), SIM_OS (e.g. 26.0), SIM_NAME, BASE_URL, PATHS (comma list),
//      OUT_DIR, APPIUM_URL, WDA_PATH (optional prebuilt WebDriverAgent .app).

import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const env = process.env
const BASE_URL = (env.BASE_URL || "https://www.farmalink.com.tr").replace(/\/$/, "")
const APPIUM = (env.APPIUM_URL || "http://127.0.0.1:4723").replace(/\/$/, "")
const OUT_DIR = env.OUT_DIR || "ios-safari-smoke-out"
const SETTLE_MS = Number(env.SETTLE_MS || 4000)
// /en/tpd2026 stays LAST: visiting a prefixed locale sets the locale cookie, which would
// redirect the later un-prefixed (Turkish) pages to /en.
const DEFAULT_PATHS = [
	"/tpd2026",
	"/register?type=doctor",
	"/comfort-kit",
	"/products/comfort-kit-implant-surgery",
	"/checkout",
	"/en/tpd2026",
]
const PATHS = (env.PATHS || "")
	.split(",")
	.map((p) => p.trim())
	.filter(Boolean)
const pages = PATHS.length ? PATHS : DEFAULT_PATHS

const log = (msg) => process.stdout.write(`[ios-smoke] ${msg}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slug = (p) => p.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "home"

async function wd(method, path, body) {
	const res = await fetch(`${APPIUM}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const json = await res.json().catch(() => ({}))
	if (!res.ok || (json.value && json.value.error)) {
		const err = json.value && json.value.error ? `${json.value.error}: ${json.value.message}` : `HTTP ${res.status}`
		throw new Error(`${method} ${path} → ${err}`)
	}
	return json.value
}

async function createSession() {
	const caps = {
		platformName: "iOS",
		browserName: "Safari",
		"appium:automationName": "XCUITest",
		"appium:udid": env.SIM_UDID,
		"appium:deviceName": env.SIM_NAME || "iPhone",
		"appium:platformVersion": env.SIM_OS,
		"appium:showSafariConsoleLog": true,
		"appium:safariInitialUrl": "about:blank",
		"appium:wdaLaunchTimeout": 240000,
		"appium:wdaConnectionTimeout": 240000,
		"appium:newCommandTimeout": 300,
		"appium:noReset": true,
	}
	if (env.WDA_PATH) {
		caps["appium:usePreinstalledWDA"] = true
		caps["appium:prebuiltWDAPath"] = env.WDA_PATH
	}
	const value = await wd("POST", "/session", { capabilities: { alwaysMatch: caps, firstMatch: [{}] } })
	return value.sessionId
}

const exec = (sid, script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args })

const MEASURE = `
	const de = document.documentElement;
	const btns = Array.from(document.querySelectorAll('button[type="submit"], form button:not([type])'))
		.filter((b) => b.offsetParent !== null)
		.map((b) => ({ text: (b.innerText || '').trim().slice(0, 40), height: Math.round(b.getBoundingClientRect().height) }));
	return {
		title: document.title,
		url: location.href,
		lang: de.lang,
		dir: de.dir,
		scrollWidth: de.scrollWidth,
		innerWidth: window.innerWidth,
		innerHeight: window.innerHeight,
		devicePixelRatio: window.devicePixelRatio,
		userAgent: navigator.userAgent,
		h1: Array.from(document.querySelectorAll('h1')).map((h) => (h.innerText || '').trim().slice(0, 80)),
		submitButtons: btns,
		visibleText404: /404|bulunamad/i.test(document.title),
	};
`

async function readConsole(sid) {
	try {
		const entries = await wd("POST", `/session/${sid}/se/log`, { type: "safariConsole" })
		return Array.isArray(entries) ? entries : []
	} catch (e) {
		return [{ level: "SMOKE", message: `safariConsole log unavailable: ${e.message}` }]
	}
}

async function main() {
	if (!env.SIM_UDID) throw new Error("SIM_UDID is required")
	mkdirSync(OUT_DIR, { recursive: true })
	const summary = { baseUrl: BASE_URL, simulator: { udid: env.SIM_UDID, name: env.SIM_NAME, os: env.SIM_OS }, startedAt: new Date().toISOString(), pages: [] }

	log(`creating Appium Safari session on ${env.SIM_NAME} iOS ${env.SIM_OS}`)
	const sid = await createSession()
	log(`session ${sid}`)
	await readConsole(sid) // drain anything from about:blank

	for (const path of pages) {
		const name = slug(path)
		const row = { path, ok: false }
		const t0 = Date.now()
		try {
			await wd("POST", `/session/${sid}/url`, { url: `${BASE_URL}${path}` })
			for (let i = 0; i < 40; i++) {
				const state = await exec(sid, "return document.readyState")
				if (state === "complete") break
				await sleep(500)
			}
			row.loadMs = Date.now() - t0
			await sleep(SETTLE_MS)
			Object.assign(row, await exec(sid, MEASURE))
			row.horizontalOverflow = row.scrollWidth > row.innerWidth
			const consoleEntries = await readConsole(sid)
			row.consoleErrors = consoleEntries.filter((e) => /error|severe/i.test(String(e.level))).map((e) => String(e.message).slice(0, 300))
			row.consoleCount = consoleEntries.length

			const shot = await wd("GET", `/session/${sid}/screenshot`)
			writeFileSync(join(OUT_DIR, `${name}__appium.png`), Buffer.from(shot, "base64"))
			execFileSync("xcrun", ["simctl", "io", env.SIM_UDID, "screenshot", "--type=png", join(OUT_DIR, `${name}__device.png`)], { stdio: "ignore" })
			row.ok = true
			log(`${path} → "${row.title}" sw=${row.scrollWidth}/${row.innerWidth} errors=${row.consoleErrors.length} ${row.loadMs}ms`)
		} catch (e) {
			row.error = e.message
			log(`${path} FAILED: ${e.message}`)
			try {
				execFileSync("xcrun", ["simctl", "io", env.SIM_UDID, "screenshot", "--type=png", join(OUT_DIR, `${name}__device_failed.png`)], { stdio: "ignore" })
			} catch {
				// best effort only — the failure itself is already recorded in row.error
			}
		}
		summary.pages.push(row)
	}

	await wd("DELETE", `/session/${sid}`).catch(() => undefined)
	summary.finishedAt = new Date().toISOString()
	writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2))
	const failed = summary.pages.filter((p) => !p.ok)
	log(`done: ${summary.pages.length - failed.length}/${summary.pages.length} pages captured`)
	if (failed.length) process.exitCode = 1
}

main().catch((e) => {
	process.stderr.write(`[ios-smoke] fatal: ${e.stack || e.message}\n`)
	process.exit(1)
})
