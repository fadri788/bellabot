const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

const port = Number(process.argv[2] || 5002);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const output = path.resolve(__dirname, "../../.demo-output/control");
const report = { evidence: "Bundled bridge simulation only; no real robot commands.", checks: [], errors: [], requests: [] };

(async () => {
    await fs.mkdir(output, { recursive: true });
    const status = await (await fetch(origin + "/robot/status")).json();
    const bridge = await (await fetch("http://127.0.0.1:3443/state")).json();
    assert.equal(status.mode, "bridge-simulation");
    assert.equal(status.simulated, true);
    assert.equal(bridge.bridgeProtocol, "bellabot-dashboard-v1");
    assert.equal(bridge.simulated, true);
    assert.equal(bridge.control.active, null, "Start with a fresh simulation");
    const browser = await chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: "msedge" }) });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
        let offline = false;
        await context.route("**/*", route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== origin) {
                report.errors.push("Unexpected external request");
                return route.abort();
            }
            if (offline && url.pathname === "/robot/status") return route.abort();
            if (request.method() === "POST") report.requests.push({ path: url.pathname, body: request.postDataJSON() });
            return route.continue();
        });
        const page = await context.newPage();
        page.on("pageerror", error => report.errors.push(error.message));
        const check = name => report.checks.push(name);
        const wait = predicate => page.waitForFunction(predicate, null, { timeout: 12000 });
        const confirm = async (locator, accept = true) => {
            page.once("dialog", dialog => accept ? dialog.accept() : dialog.dismiss());
            await locator.click();
        };
        const clear = async () => {
            await wait(() => document.querySelector("#btn-pause").textContent === "Aufgabe prüfen" && !document.querySelector("#btn-pause").disabled);
            await confirm(page.locator("#btn-pause"));
            await wait(() => !document.querySelector("#punkte-liste button").disabled);
        };
        await page.goto(origin + "/?mode=bridge-simulation");
        await wait(() => document.querySelectorAll("#punkte-liste button").length === 3 && !document.querySelector("#punkte-liste button").disabled);
        assert.equal(await page.locator(".marker").count(), 2);
        assert.match(await page.title(), /Simulation/);
        check("Fresh destinations load; unknown schematic positions stay in the list only");

        const kitchen = page.getByRole("button", { name: "Kitchen", exact: true });
        await confirm(kitchen, false);
        assert.equal(report.requests.length, 0);
        check("Dismissing confirmation sends nothing");
        await confirm(kitchen);
        await wait(() => document.querySelector("#zustand").textContent === "delivering");
        assert.equal(report.requests.length, 1);
        assert.equal(report.requests[0].body.point, "Kitchen");
        assert.equal(report.requests[0].body.confirmation.besideRobot, true);
        assert.ok(report.requests[0].body.mapId);
        assert.match(report.requests[0].body.id, /^[0-9a-f-]{36}$/);
        assert.equal(await kitchen.isDisabled(), true);
        await page.locator('.marker[data-punkt="VR"]').click();
        assert.equal(report.requests.length, 1);
        check("One confirmed trip is sent; extra map clicks cannot replace it");
        await page.screenshot({ path: path.join(output, "dashboard-control.png"), fullPage: true });
        await clear();
        assert.equal(report.requests[1].body.action, "reconcile");
        assert.equal(report.requests[1].body.confirmation.robotTaskCleared, true);
        check("Arrival stays locked until the operator checks and clears the task");

        await confirm(page.locator('.marker[data-punkt="VR"]'));
        await wait(() => document.querySelector("#zustand").textContent === "delivering");
        await confirm(page.locator("#btn-pause"));
        assert.equal(report.requests.at(-1).body.action, "cancel");
        await clear();
        check("Map selection, separate cancellation and operator reconciliation work");

        await confirm(page.locator("#btn-zurueck"));
        await wait(() => document.querySelector("#zustand").textContent === "returning");
        assert.equal(report.requests.at(-1).body.action, "return");
        await clear();
        const afterReturn = await (await fetch(origin + "/robot/status")).json();
        assert.equal(afterReturn.state, "idle");
        check("Return targets the configured stop without inventing charging");

        offline = true;
        await wait(() => document.querySelector("#zustand").textContent === "offline");
        assert.equal(await kitchen.isDisabled(), true);
        assert.equal(await page.locator("#btn-pause").isDisabled(), true);
        const before = report.requests.length;
        await page.locator('.marker[data-punkt="VR"]').click();
        assert.equal(report.requests.length, before);
        offline = false;
        await wait(() => document.querySelector("#zustand").textContent === "idle");
        assert.equal(report.requests.length, before);
        check("Connection loss disables commands; recovery never starts a trip");
        assert.equal(new Set(report.requests.map(item => item.body.id)).size, report.requests.length);
        assert.deepEqual(report.errors, []);
        check("Unique command IDs, no page errors and no external browser requests");
        await page.screenshot({ path: path.join(output, "dashboard-ready.png"), fullPage: true });
    } finally {
        await browser.close();
        report.checkedAt = new Date().toISOString();
        await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify({ checks: report.checks, errors: report.errors, commands: report.requests.length }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
