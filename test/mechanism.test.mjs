import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyPiliang } from "../lib/index.js";
import { apply as applyBingxing } from "../../dsh-bingxing/lib/index.js";
import { runScheduledCalls } from "./scheduler.mjs";

const installedBase = "file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/";
const asarNode = "file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/";
const installed = (name) => import(`${installedBase}${name}/lib/index.js`);

let callSeq = 0;

function textOf(result) {
  return (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function errorCode(result) {
  return result.error?.info?.code ?? result.error?.code ?? null;
}

async function runTool(h, name, args) {
  callSeq += 1;
  const signal = new AbortController().signal;
  const committed = await runScheduledCalls(h.ctx, h.agent, [{
    id: `${name}-${callSeq}`,
    name,
    arguments: args,
  }], signal);
  assert.equal(committed.length, 1);
  return committed[0].result;
}

async function observe(h, filePath) {
  const result = await runTool(h, "read", { file_path: filePath });
  assert.notEqual(result.isError, true, textOf(result));
  return result;
}

function wrapEditText(ctx) {
  const original = ctx.fs.editText.bind(ctx.fs);
  const calls = [];
  ctx.fs.editText = async (...args) => {
    calls.push(args[1]);
    return original(...args);
  };
  return calls;
}

async function createHarness(t, {
  sandboxMode,
  bingxing = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-piliang-"));
  const names = [
    "cordis", "dsh-session", "dsh-session-projection", "dsh-token-meter", "dsh-session-query",
    "dsh-agent", "dsh-llm", "dsh-system-prompt", "dsh-tools", "dsh-agent-loop", "dsh-fs-local", "dsh-tool-executor-native",
    "dsh-fs-sandbox", "dsh-working-directory", "dsh-subprocess-local", "dsh-spill-local", "dsh-tool-fs",
    "dsh-tool-fs-search", "dsh-fs-observation-policy",
  ];
  const mods = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await installed(name)])));
  const tokenClient = await import(`${installedBase}dsh-token-meter/lib/types/client.js`);
  const ctx = new mods.cordis.Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  await ctx.plugin(mods["dsh-session"].SessionStore);
  await ctx.plugin(mods["dsh-session-projection"].SessionProjectionRegistry);
  await ctx.plugin(mods["dsh-token-meter"].TokenMeter, {});
  await ctx.plugin(mods["dsh-session-query"].SessionQueryEngine);
  await ctx.plugin(mods["dsh-agent"].AgentRegistry);
  await ctx.plugin(mods["dsh-llm"].LlmRuntime);
  await ctx.plugin(mods["dsh-system-prompt"].SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await ctx.plugin(mods["dsh-tools"].ToolRuntime);
  await ctx.plugin(mods["dsh-tool-executor-native"]);
  if (sandboxMode) {
    ctx.provide("sandboxPolicy", {
      defaultMode: sandboxMode,
      resolve: () => ({ mode: sandboxMode, workspaceRoot: dir }),
    });
    await ctx.plugin(mods["dsh-fs-sandbox"].default, { cwd: dir, diffBasisMaxBytes: 1_000_000 });
  } else {
    await ctx.plugin(mods["dsh-fs-local"].default, { cwd: dir, diffBasisMaxBytes: 1_000_000 });
  }
  await ctx.plugin(mods["dsh-working-directory"].WorkingDirectoryService, { defaultDirectory: dir });
  await ctx.plugin(mods["dsh-agent-loop"].default, { agents: [], maxParallelToolCalls: 1 });
  await ctx.plugin(mods["dsh-subprocess-local"].default, {});
  await ctx.plugin(mods["dsh-spill-local"].default, {});
  await ctx.plugin(mods["dsh-fs-observation-policy"]);
  await ctx.plugin(mods["dsh-tool-fs"], { readImage: false });
  await ctx.plugin(mods["dsh-tool-fs-search"], { sampleOverCapGlobResults: false });
  ctx.provide("loader", {
    import: async (spec) => {
      if (spec === "@deepseek-ai/dsh-token-meter/client") return tokenClient;
      if (spec === "diff") return import(`${asarNode}diff/libesm/index.js`);
      if (spec.startsWith("@deepseek-ai/")) return installed(spec.replace("@deepseek-ai/", ""));
      return import(spec);
    },
  });
  const editTextCalls = wrapEditText(ctx);
  await ctx.plugin({
    name: "dsh-piliang",
    inject: ["loader", "tools", "fs", "workingDirectory"],
    apply: applyPiliang,
  });
  if (bingxing) {
    await ctx.plugin({ name: "dsh-bingxing", inject: ["tools", "agents"], apply: applyBingxing });
  }
  const handle = await ctx.agents.create({ sessionId: `piliang-${Date.now()}-${Math.random().toString(16).slice(2)}`, meta: { cwd: dir } });
  return { ctx, dir, agent: handle.agent, editTextCalls, mods };
}

test("multi_edit is registered, edit remains, not concurrency-safe", async (t) => {
  const h = await createHarness(t);
  const multi = h.ctx.tools.get("multi_edit", h.agent);
  const edit = h.ctx.tools.get("edit", h.agent);
  assert.ok(multi);
  assert.ok(edit);
  assert.equal(Object.hasOwn(multi, "isConcurrencySafe"), false);
  assert.equal(edit.isConcurrencySafe, undefined);
});

test("success bytes equal sequential edit, including CRLF, one editText publish", async (t) => {
  const h = await createHarness(t);
  const sequentialPath = join(h.dir, "seq.txt");
  const multiPath = join(h.dir, "multi.txt");
  const initial = Buffer.from("alpha\r\nbeta\r\ngamma\r\n", "utf8");
  await writeFile(sequentialPath, initial);
  await writeFile(multiPath, initial);
  await observe(h, sequentialPath);
  const e1 = await runTool(h, "edit", { file_path: sequentialPath, old_string: "alpha", new_string: "ALPHA" });
  assert.notEqual(e1.isError, true, textOf(e1));
  const e2 = await runTool(h, "edit", { file_path: sequentialPath, old_string: "beta", new_string: "BETA" });
  assert.notEqual(e2.isError, true, textOf(e2));
  const e3 = await runTool(h, "edit", { file_path: sequentialPath, old_string: "gamma", new_string: "GAMMA" });
  assert.notEqual(e3.isError, true, textOf(e3));
  const expected = await readFile(sequentialPath);
  h.editTextCalls.length = 0;
  await observe(h, multiPath);
  const multi = await runTool(h, "multi_edit", {
    file_path: multiPath,
    edits: [
      { old_string: "alpha", new_string: "ALPHA" },
      { old_string: "beta", new_string: "BETA" },
      { old_string: "gamma", new_string: "GAMMA" },
    ],
  });
  assert.notEqual(multi.isError, true, textOf(multi));
  assert.equal(h.editTextCalls.length, 1);
  assert.equal(h.editTextCalls[0].oldString.includes("ALPHA"), false);
  assert.equal(h.editTextCalls[0].newString.includes("ALPHA"), true);
  assert.equal(h.editTextCalls[0].newString.includes("BETA"), true);
  const actual = await readFile(multiPath);
  assert.deepEqual(actual, expected);
  assert.match(textOf(multi), /updated successfully/i);
  assert.equal(textOf(multi).includes(h.editTextCalls[0].newString), false);
});

test("later items see earlier replacements", async (t) => {
  const h = await createHarness(t);
  const sequentialPath = join(h.dir, "seq-dep.txt");
  const multiPath = join(h.dir, "multi-dep.txt");
  const initial = "foo = 1;\nbar = foo;\n";
  await writeFile(sequentialPath, initial);
  await writeFile(multiPath, initial);
  await observe(h, sequentialPath);
  assert.notEqual((await runTool(h, "edit", { file_path: sequentialPath, old_string: "foo = 1;", new_string: "foo = 2;" })).isError, true);
  assert.notEqual((await runTool(h, "edit", { file_path: sequentialPath, old_string: "bar = foo;", new_string: "bar = foo * 2;" })).isError, true);
  const expected = await readFile(sequentialPath);
  await observe(h, multiPath);
  const multi = await runTool(h, "multi_edit", {
    file_path: multiPath,
    edits: [
      { old_string: "foo = 1;", new_string: "foo = 2;" },
      { old_string: "bar = foo;", new_string: "bar = foo * 2;" },
    ],
  });
  assert.notEqual(multi.isError, true, textOf(multi));
  assert.deepEqual(await readFile(multiPath), expected);
});

test("replace_all matches sequential edit", async (t) => {
  const h = await createHarness(t);
  const sequentialPath = join(h.dir, "seq-all.txt");
  const multiPath = join(h.dir, "multi-all.txt");
  const initial = "x x x\nkeep\n";
  await writeFile(sequentialPath, initial);
  await writeFile(multiPath, initial);
  await observe(h, sequentialPath);
  assert.notEqual((await runTool(h, "edit", { file_path: sequentialPath, old_string: "x", new_string: "y", replace_all: true })).isError, true);
  const expected = await readFile(sequentialPath);
  await observe(h, multiPath);
  const multi = await runTool(h, "multi_edit", {
    file_path: multiPath,
    edits: [{ old_string: "x", new_string: "y", replace_all: true }],
  });
  assert.notEqual(multi.isError, true, textOf(multi));
  assert.deepEqual(await readFile(multiPath), expected);
});

test("item failure leaves file unchanged and names 1-based item", async (t) => {
  const h = await createHarness(t);
  const path = join(h.dir, "fail.txt");
  const initial = Buffer.from("one\ntwo\nthree\n", "utf8");
  await writeFile(path, initial);
  await observe(h, path);
  h.editTextCalls.length = 0;
  const multi = await runTool(h, "multi_edit", {
    file_path: path,
    edits: [
      { old_string: "one", new_string: "ONE" },
      { old_string: "missing", new_string: "nope" },
      { old_string: "three", new_string: "THREE" },
    ],
  });
  assert.equal(multi.isError, true);
  assert.equal(errorCode(multi), "FS_EDIT_NOT_FOUND");
  assert.match(textOf(multi), /item 2/);
  assert.equal(h.editTextCalls.length, 0);
  assert.deepEqual(await readFile(path), initial);
});

test("non-unique match reports item number and does not write", async (t) => {
  const h = await createHarness(t);
  const sequentialPath = join(h.dir, "seq-amb.txt");
  const multiPath = join(h.dir, "multi-amb.txt");
  const initial = "aa\naa\n";
  await writeFile(sequentialPath, initial);
  await writeFile(multiPath, initial);
  await observe(h, sequentialPath);
  const seq = await runTool(h, "edit", { file_path: sequentialPath, old_string: "aa", new_string: "bb" });
  assert.equal(seq.isError, true);
  const seqCode = errorCode(seq);
  await observe(h, multiPath);
  const before = await readFile(multiPath);
  const multi = await runTool(h, "multi_edit", {
    file_path: multiPath,
    edits: [{ old_string: "aa", new_string: "bb" }],
  });
  assert.equal(multi.isError, true);
  assert.equal(errorCode(multi), seqCode);
  assert.equal(errorCode(multi), "FS_AMBIGUOUS_EDIT");
  assert.match(textOf(multi), /item 1/);
  assert.deepEqual(await readFile(multiPath), before);
});

test("unread file: same FS_NOT_OBSERVED code and visible hint as edit", async (t) => {
  const h = await createHarness(t);
  const path = join(h.dir, "unread.txt");
  await writeFile(path, "hello\n");
  const seq = await runTool(h, "edit", { file_path: path, old_string: "hello", new_string: "hi" });
  const multi = await runTool(h, "multi_edit", {
    file_path: path,
    edits: [{ old_string: "hello", new_string: "hi" }],
  });
  assert.equal(seq.isError, true);
  assert.equal(multi.isError, true);
  assert.equal(errorCode(seq), "FS_NOT_OBSERVED");
  assert.equal(errorCode(multi), errorCode(seq));
  assert.equal(textOf(multi).includes("has not been read"), true);
  assert.equal(textOf(seq).includes("has not been read"), true);
});

test("missing file after read: same FS_STALE_VERSION as edit", async (t) => {
  const h = await createHarness(t);
  const seqPath = join(h.dir, "gone-seq.txt");
  const multiPath = join(h.dir, "gone-multi.txt");
  await writeFile(seqPath, "hello\n");
  await writeFile(multiPath, "hello\n");
  await observe(h, seqPath);
  await rm(seqPath);
  const seq = await runTool(h, "edit", { file_path: seqPath, old_string: "hello", new_string: "hi" });
  await observe(h, multiPath);
  await rm(multiPath);
  const multi = await runTool(h, "multi_edit", {
    file_path: multiPath,
    edits: [{ old_string: "hello", new_string: "hi" }],
  });
  assert.equal(seq.isError, true);
  assert.equal(multi.isError, true);
  assert.equal(errorCode(seq), "FS_STALE_VERSION");
  assert.equal(errorCode(multi), errorCode(seq));
  assert.match(textOf(seq), /changed since it was read/);
  assert.match(textOf(multi), /changed since it was read/);
});

test("preview read failure with multiple edits does not publish edits[0]", async (t) => {
  const h = await createHarness(t);
  const path = join(h.dir, "gone-multi-items.txt");
  await writeFile(path, "hello\nworld\n");
  await observe(h, path);
  await rm(path);
  h.editTextCalls.length = 0;
  const first = { old_string: "hello", new_string: "HELLO" };
  const multi = await runTool(h, "multi_edit", {
    file_path: path,
    edits: [
      first,
      { old_string: "world", new_string: "WORLD" },
    ],
  });
  assert.equal(multi.isError, true);
  assert.equal(
    h.editTextCalls.some((call) => call.oldString === first.old_string && call.newString === first.new_string),
    false,
    "editText must not be called with only edits[0] when the preview read fails for a multi-item batch",
  );
  await assert.rejects(() => readFile(path), { code: "ENOENT" });
});

test("external modify after read: same FS_STALE_VERSION as edit", async (t) => {
  const h = await createHarness(t);
  const seqPath = join(h.dir, "stale-seq.txt");
  const multiPath = join(h.dir, "stale-multi.txt");
  await writeFile(seqPath, "hello\n");
  await writeFile(multiPath, "hello\n");
  await observe(h, seqPath);
  await writeFile(seqPath, "hello\nworld\n");
  const seq = await runTool(h, "edit", { file_path: seqPath, old_string: "hello", new_string: "hi" });
  await observe(h, multiPath);
  await writeFile(multiPath, "hello\nworld\n");
  const before = await readFile(multiPath);
  const multi = await runTool(h, "multi_edit", {
    file_path: multiPath,
    edits: [{ old_string: "hello", new_string: "hi" }],
  });
  assert.equal(seq.isError, true);
  assert.equal(multi.isError, true);
  assert.equal(errorCode(seq), "FS_STALE_VERSION");
  assert.equal(errorCode(multi), errorCode(seq));
  assert.deepEqual(await readFile(multiPath), before);
});

test("nonexistent path: same code as edit", async (t) => {
  const h = await createHarness(t);
  const missing = join(h.dir, "no-such.txt");
  const seq = await runTool(h, "edit", { file_path: missing, old_string: "a", new_string: "b" });
  const multi = await runTool(h, "multi_edit", {
    file_path: missing,
    edits: [{ old_string: "a", new_string: "b" }],
  });
  assert.equal(seq.isError, true);
  assert.equal(multi.isError, true);
  assert.equal(errorCode(multi), errorCode(seq));
});

test("read-only sandbox denial matches edit, including when item would not match", async (t) => {
  const h = await createHarness(t, { sandboxMode: "read-only" });
  const path = join(h.dir, "ro.txt");
  await writeFile(path, "hello\n");
  await observe(h, path);
  const seq = await runTool(h, "edit", { file_path: path, old_string: "hello", new_string: "hi" });
  const multi = await runTool(h, "multi_edit", {
    file_path: path,
    edits: [{ old_string: "missing", new_string: "hi" }],
  });
  assert.equal(seq.isError, true);
  assert.equal(multi.isError, true);
  assert.equal(errorCode(seq), "FS_SANDBOX_DENIED");
  assert.equal(errorCode(multi), errorCode(seq));
  assert.match(textOf(seq), /sandbox: file access denied under read-only mode/);
  assert.match(textOf(multi), /sandbox: file access denied under read-only mode/);
  assert.equal(await readFile(path, "utf8"), "hello\n");
});

test("workspace-write denies outside workspace like edit", async (t) => {
  const h = await createHarness(t, { sandboxMode: "workspace-write" });
  const outsideDir = join(new URL("..", import.meta.url).pathname, ".tmp-outside");
  await mkdir(outsideDir, { recursive: true });
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const path = join(outsideDir, "out.txt");
  await writeFile(path, "hello\n");
  await observe(h, path);
  const seq = await runTool(h, "edit", { file_path: path, old_string: "hello", new_string: "hi" });
  const multi = await runTool(h, "multi_edit", {
    file_path: path,
    edits: [{ old_string: "hello", new_string: "hi" }],
  });
  assert.equal(errorCode(seq), "FS_SANDBOX_DENIED");
  assert.equal(errorCode(multi), errorCode(seq));
  assert.match(textOf(multi), /workspace-write/);
  assert.equal(await readFile(path, "utf8"), "hello\n");
});

test("empty old_string is rejected without write, like edit", async (t) => {
  const h = await createHarness(t);
  const path = join(h.dir, "empty-old.txt");
  await writeFile(path, "hello\n");
  await observe(h, path);
  const before = await readFile(path);
  const seq = await runTool(h, "edit", { file_path: path, old_string: "", new_string: "x" });
  h.editTextCalls.length = 0;
  const multi = await runTool(h, "multi_edit", {
    file_path: path,
    edits: [{ old_string: "", new_string: "x" }],
  });
  assert.equal(seq.isError, true);
  assert.equal(multi.isError, true);
  assert.match(textOf(multi), /old_string must be a non-empty string/);
  assert.equal(h.editTextCalls.length, 0);
  assert.deepEqual(await readFile(path), before);
});

test("empty file does not write", async (t) => {
  const h = await createHarness(t);
  const path = join(h.dir, "empty.txt");
  await writeFile(path, "");
  await observe(h, path);
  h.editTextCalls.length = 0;
  const multi = await runTool(h, "multi_edit", {
    file_path: path,
    edits: [{ old_string: "a", new_string: "b" }],
  });
  assert.equal(multi.isError, true);
  assert.equal(h.editTextCalls.length, 0);
  assert.deepEqual(await readFile(path), Buffer.alloc(0));
});

test("bingxing and multi_edit coexist; render is text-only", async (t) => {
  const h = await createHarness(t, { bingxing: true });
  assert.ok(h.ctx.tools.get("multi_edit", h.agent));
  assert.ok(h.ctx.tools.get("edit", h.agent));
  assert.ok(h.ctx.tools.get("grep", h.agent));
  const path = join(h.dir, "coexist.txt");
  await writeFile(path, "a\nb\n");
  await observe(h, path);
  const multi = await runTool(h, "multi_edit", {
    file_path: path,
    edits: [
      { old_string: "a", new_string: "A" },
      { old_string: "b", new_string: "B" },
    ],
  });
  assert.notEqual(multi.isError, true, textOf(multi));
  const blocks = multi.content ?? [];
  assert.equal(blocks.every((block) => block.type === "text"), true);
});
