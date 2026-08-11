#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const take = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const debugPort = Number(take("--debug-port", "9223"));
const timeoutMs = Number(take("--timeout-ms", "300000"));
const screenshotPath = take("--screenshot");
if (!Number.isInteger(debugPort) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("usage: browser-smoke.mjs [--debug-port N] [--timeout-ms N]");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function findPage() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = pages.find((candidate) => candidate.type === "page" && candidate.url.includes("autorun=1"));
      if (page !== undefined) return page;
    } catch {
      // Chrome may not have opened its debugging endpoint yet.
    }
    await delay(100);
  }
  throw new Error("Chrome debugging page did not become available");
}

const page = await findPage();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (request === undefined) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

await command("Runtime.enable");
const deadline = Date.now() + timeoutMs;
let status = null;
while (Date.now() < deadline) {
  status = await evaluate("document.documentElement.dataset.runStatus || null");
  if (status === "complete" || status === "failed") break;
  await delay(250);
}
if (status !== "complete" && status !== "failed") throw new Error(`browser run timed out after ${timeoutMs} ms`);

const evidence = await evaluate(`({
  status: document.documentElement.dataset.runStatus,
  summary: document.querySelector('#status').textContent,
  isolated: crossOriginIsolated,
  rows: [...document.querySelectorAll('#backend-rows tr')].map((row) =>
    [...row.cells].map((cell) => cell.textContent.trim()))
})`);
console.log(JSON.stringify(evidence, null, 2));
if (screenshotPath !== null) {
  const screenshot = await command("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
}
socket.close();
if (status !== "complete") process.exitCode = 1;
