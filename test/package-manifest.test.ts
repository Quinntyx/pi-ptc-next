const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

test("pi-sock is a pinned runtime dependency, not an optional or peer dependency", () => {
  assert.match(
    manifest.dependencies["pi-sock"],
    /^https:\/\/codeload\.github\.com\/Quinntyx\/pi-sock\/tar\.gz\/[a-f0-9]{40}$/,
  );
  assert.equal(manifest.peerDependencies?.["pi-sock"], undefined);
  assert.equal(manifest.optionalDependencies?.["pi-sock"], undefined);
});

test("Pi loads pi-sock from the dependency and npm bundles it for publication", () => {
  const socketExtension = "./node_modules/pi-sock/index.ts";
  assert.ok(manifest.pi.extensions.includes(socketExtension));
  assert.ok(manifest.pi.extensions.includes("./src/index.ts"));
  assert.ok(manifest.bundledDependencies.includes("pi-sock"));
});

test("the lockfile records the bundled pi-sock dependency and matches the manifest", () => {
  assert.equal(lock.name, manifest.name);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  const socketPackage = lock.packages["node_modules/pi-sock"];
  assert.ok(socketPackage);
  assert.equal(socketPackage.resolved, manifest.dependencies["pi-sock"]);
  assert.match(socketPackage.integrity, /^sha512-/);
  assert.equal(socketPackage.inBundle, true);
});
