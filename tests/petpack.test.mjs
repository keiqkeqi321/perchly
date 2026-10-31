import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

class Element {
  children = [];
  style = {};
  appendChild(child) { this.children.push(child); child.parent = this; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
}

const players = [];
class FakeVideoPlayer {
  constructor(src) {
    this.src = src;
    this.hidden = false;
    this.destroyed = false;
    players.push(this);
  }
  attach(container) {
    this.element = new Element();
    container.appendChild(this.element);
    return new Promise((resolve) => { this.finishLoading = resolve; });
  }
  setHidden(hidden) { this.hidden = hidden; }
  play() {}
  pause() {}
  destroy() { this.destroyed = true; this.element?.remove(); }
  get durationMs() { return 4000; }
}

globalThis.document = { createElement: () => new Element() };
globalThis.window = { setTimeout: () => 1, clearTimeout: () => {} };
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "test" }, configurable: true });
globalThis.__petVideoPlayer = FakeVideoPlayer;

const source = await readFile(new URL("../src/pet/petpack.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace('import { PetVideoPlayer } from "./video";',
  "const PetVideoPlayer = globalThis.__petVideoPlayer;");
const { PetPackEngine } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const pack = {
  id: "test", layers: { body: { z: 10 }, bg: { z: 5 } },
  assets: { idle: ["idle.webm"], interact: [], fly: ["fly.webm"] },
  backgrounds: { aura: "aura.webm", heart: "heart.webm" },
  triggerRules: [{ when: "drag", bg: "aura", quotes: [] }],
};
const rule = (bg) => ({ when: "test", bg, quotes: [] });
const latest = (name) => players.findLast((p) => p.src.endsWith(name));

test("松手后才加载完成的飞翔动作不会启动光晕", async () => {
  players.length = 0;
  const engine = new PetPackEngine(pack, new Element());
  const start = engine.dragStart();
  const fly = latest("fly.webm");
  engine.dragEnd();
  fly.finishLoading(true);
  await start;
  assert.equal(latest("aura.webm"), undefined);
  engine.dispose();
});

test("松手取消正在加载的光晕，完成后不再显示", async () => {
  players.length = 0;
  const engine = new PetPackEngine(pack, new Element());
  const start = engine.dragStart();
  latest("fly.webm").finishLoading(true);
  await start;
  const aura = latest("aura.webm");
  assert.equal(aura.hidden, true);
  engine.dragEnd();
  aura.finishLoading(true);
  await Promise.resolve();
  assert.equal(aura.destroyed, true);
  assert.equal(engine.bgPlayer, null);
  engine.dispose();
});

test("切换背景或切换到无背景时，旧背景不会覆盖新状态", async () => {
  players.length = 0;
  const engine = new PetPackEngine(pack, new Element());
  const old = engine.applyRule(rule("aura"));
  const aura = latest("aura.webm");
  const next = engine.applyRule(rule("heart"));
  const heart = latest("heart.webm");
  heart.finishLoading(true);
  await next;
  aura.finishLoading(true);
  await old;
  assert.equal(aura.destroyed, true);
  assert.equal(engine.bgPlayer, heart);
  await engine.applyRule(rule(null));
  assert.equal(heart.destroyed, true);
  assert.equal(engine.bgPlayer, null);
  engine.dispose();
});
