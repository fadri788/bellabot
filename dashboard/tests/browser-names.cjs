const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");

(async () => {
    const browser = await chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: "msedge" }) });
    const posts = [], errors = [];
    const origin = "http://127.0.0.1:65534";
    let points = ["kitchen", "table 2", "VR", "Unknown"];
    try {
        const context = await browser.newContext();
        // Every request is fulfilled here. This test cannot reach a robot or a server.
        await context.route("**/*", async route => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== origin) {
                errors.push("Unexpected origin");
                return route.abort();
            }
            const json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
            if (request.method() === "POST") {
                assert.equal(url.pathname, "/task/delivery");
                posts.push(request.postDataJSON());
                return json({ ok: true, message: "Simulation: Anfrage geprüft" });
            }
            if (url.pathname === "/robot/status") return json({ mode: "bridge-simulation", simulated: true,
                state: "idle", battery: 80, task: "Simulation", mapId: "fixture-map", canGo: true });
            if (url.pathname === "/points") return json({ points });
            if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
            const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
            if (!["index.html", "style.css", "app.js"].includes(name)) return route.abort();
            return route.fulfill({ body: await fs.readFile(path.join(__dirname, "..", name)),
                contentType: name.endsWith("js") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html" });
        });
        const page = await context.newPage();
        page.on("pageerror", error => errors.push(error.message));
        page.on("dialog", dialog => dialog.accept());
        await page.goto(origin + "/");
        await page.waitForFunction(() => document.querySelectorAll(".marker").length === 3);
        assert.equal(await page.locator("#punkte-liste button").count(), 4);
        await page.getByRole("button", { name: "kitchen", exact: true }).click();
        await page.waitForFunction(() => !document.querySelector("#punkte-liste button").disabled);
        await page.locator('.marker[data-punkt="table 2"]').click();
        await page.waitForFunction(() => !document.querySelector("#punkte-liste button").disabled);
        assert.deepEqual(posts.map(body => body.point), ["kitchen", "table 2"]);
        assert.ok(posts.every(body => body.confirmation.besideRobot === true && body.mapId === "fixture-map"));
        points = ["VR", "vr"];
        await page.waitForFunction(() => document.querySelectorAll("#punkte-liste button").length === 2);
        assert.equal(await page.locator(".marker").count(), 0);
        assert.deepEqual(errors, []);
        console.log("Passed: exact command names, schematic aliases, unknown and ambiguous positions, no external requests.");
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
