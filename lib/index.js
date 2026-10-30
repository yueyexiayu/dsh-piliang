export const name = "dsh-piliang";
export const inject = ["loader", "tools", "fs", "workingDirectory"];
export const VERSION = "0.1.3";

function normalizeLineEndings(content) {
  return content.replaceAll("\r\n", "\n");
}

function countOccurrences(content, needle) {
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function applyLiteralEdit(FsError, content, oldString, newString, replaceAll, displayPath) {
  const oldNorm = normalizeLineEndings(oldString);
  if (oldNorm.length === 0) throw new FsError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
  const newNorm = normalizeLineEndings(newString);
  const replacements = countOccurrences(content, oldNorm);
  if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND");
  if (!replaceAll && replacements > 1) {
    throw new FsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      "FS_AMBIGUOUS_EDIT",
    );
  }
  return {
    content: content.split(oldNorm).join(newNorm),
    replacements,
  };
}

function computeHunkDiffs(structuredPatch, path, before, after) {
  if (typeof structuredPatch !== "function") {
    if (before === after) return [];
    return [{
      path,
      oldText: before.length > 0 ? before : null,
      newText: after,
    }];
  }
  const patch = structuredPatch("", "", before, after, undefined, undefined, { context: 3 });
  const diffs = [];
  for (const hunk of patch.hunks) {
    const oldLines = [];
    const newLines = [];
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      const text = line.slice(1);
      if (line.startsWith("-")) oldLines.push(text);
      else if (line.startsWith("+")) newLines.push(text);
      else {
        oldLines.push(text);
        newLines.push(text);
      }
    }
    diffs.push({
      path,
      oldText: oldLines.length > 0 ? oldLines.join("\n") : null,
      newText: newLines.join("\n"),
    });
  }
  return diffs;
}

function isFileDiff(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { path, oldText, newText } = value;
  return typeof path === "string" && (oldText === null || typeof oldText === "string") && typeof newText === "string";
}

function diffsFromMeta(meta) {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const diffs = meta.diffs;
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined;
  return diffs;
}

function remediateFsError(error, displayPath) {
  if (error == null || typeof error !== "object" || typeof error.code !== "string") return error;
  if (error.code === "FS_NOT_OBSERVED") {
    const wrapped = new error.constructor(`cannot modify "${displayPath}": file has not been read — read the file, then retry`, error.code, { cause: error });
    return wrapped;
  }
  if (error.code === "FS_STALE_VERSION") {
    return new error.constructor(`${error.message} — re-read the file, then retry`, error.code, { cause: error });
  }
  return error;
}

function mutationResult(ctx, target, outcome, exec) {
  const { version, ...result } = outcome;
  ctx.emit("fs/observed", target, { kind: "present", version }, exec);
  return {
    path: ctx.fs.processPath(target),
    ...result,
  };
}

async function sessionResolveOptions(ctx, exec) {
  const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  };
}

function parseMultiEditArgs(args) {
  if (typeof args.file_path !== "string" || args.file_path.trim().length === 0) {
    throw new Error("file_path must be a non-empty string");
  }
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    throw new Error("edits must be a non-empty array");
  }
  return {
    filePath: args.file_path,
    edits: args.edits.map((item, index) => {
      const n = index + 1;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`item ${n}: edit must be an object`);
      }
      if (typeof item.old_string !== "string" || item.old_string.length === 0) {
        throw new Error(`item ${n}: old_string must be a non-empty string`);
      }
      if (typeof item.new_string !== "string") {
        throw new Error(`item ${n}: new_string must be a string`);
      }
      if (item.old_string === item.new_string) {
        throw new Error(`item ${n}: old_string and new_string must differ`);
      }
      return {
        oldString: item.old_string,
        newString: item.new_string,
        replaceAll: item.replace_all ?? false,
      };
    }),
  };
}

function prefixItemError(FsError, error, itemNumber) {
  const prefix = `item ${itemNumber}: `;
  if (error instanceof FsError) {
    return new FsError(`${prefix}${error.message}`, error.code, { cause: error });
  }
  if (error instanceof Error) {
    error.message = `${prefix}${error.message}`;
    return error;
  }
  return new Error(`${prefix}${String(error)}`);
}

function createSandboxController(ctx, sandboxApi) {
  const defaultMode = ctx.fs.sandboxMode;
  const escalationModes = defaultMode === undefined || sandboxApi == null ? [] : sandboxApi.ESCALATION_TARGETS;
  const policy = defaultMode === undefined ? undefined : ctx.get("sandboxPolicy");
  if (defaultMode !== undefined && policy === undefined) {
    throw new Error("dsh-piliang: the mounted filesystem confines but ctx.sandboxPolicy is missing");
  }
  return {
    escalationModes,
    schemaFields() {
      return {
        sandbox_permissions: {
          type: "string",
          enum: [...escalationModes],
          description: sandboxApi.sandboxPermissionsDescription("operation"),
        },
        justification: {
          type: "string",
          description: "Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access. Use the language of the user’s current request.",
        },
      };
    },
    async resolvePolicy(toolName, args, exec) {
      if (sandboxApi != null) {
        sandboxApi.validateEscalationArgs(args.sandbox_permissions, args.justification);
      } else if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
        throw new Error("sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)");
      }
      const standingPolicy = policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} });
      if (args.sandbox_permissions === undefined || args.justification === undefined) return standingPolicy;
      if (escalationModes.length === 0 || sandboxApi == null) {
        throw new Error("sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)");
      }
      const approvedMode = await sandboxApi.approveEscalation({
        requestedMode: args.sandbox_permissions,
        justification: args.justification,
        effectiveMode: standingPolicy.mode,
        subject: "operation",
      }, {
        approver: ctx.get("approval"),
        agent: exec.agent,
        callId: exec.callId,
        toolName,
        signal: exec.signal,
      });
      return {
        ...standingPolicy,
        mode: approvedMode,
      };
    },
    mapError(error, sandboxPolicy) {
      if (error == null || typeof error !== "object" || error.code !== "FS_SANDBOX_DENIED") return error;
      if (sandboxApi == null) return error;
      const mode = sandboxPolicy.mode;
      return new error.constructor(
        `${sandboxApi.sandboxDenialMarker(mode)}\n${sandboxApi.escalationHintMarker("operation")}`,
        "FS_SANDBOX_DENIED",
        { cause: error },
      );
    },
  };
}

async function readLfBasis(ctx, target, signal, FsError) {
  const bytes = await ctx.fs.readBytes(target, signal, Number.MAX_SAFE_INTEGER);
  if (bytes.includes(0)) throw new FsError(`cannot edit "${target.displayPath}": binary file`, "FS_NOT_TEXT");
  let raw;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new FsError(`cannot edit "${target.displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT");
  }
  return normalizeLineEndings(raw);
}

async function importOptional(loader, spec) {
  try {
    return await loader.import(spec);
  } catch {
    return null;
  }
}

export async function apply(ctx) {
  const { defineTool } = await ctx.loader.import("@deepseek-ai/dsh-tools");
  const { FsError } = await ctx.loader.import("@deepseek-ai/dsh-fs");
  const sandboxApi = await importOptional(ctx.loader, "@deepseek-ai/dsh-sandbox");
  const diffMod = await importOptional(ctx.loader, "diff");
  const structuredPatch = diffMod?.structuredPatch;
  const sandbox = createSandboxController(ctx, sandboxApi);

  const parameters = {
    file_path: {
      type: "string",
      required: true,
      description: "Path to edit, resolved by the filesystem backend. Provide `file_path` before `edits` in the arguments.",
    },
    edits: {
      type: "array",
      required: true,
      description: "Ordered literal replacements in one file. Later items see earlier replacements. Prefer multi_edit over repeated edit for several spans in the same already-read file. The whole call writes once; if any item fails, the file is left unchanged.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          old_string: {
            type: "string",
            required: true,
            description: "Literal text to replace.",
          },
          new_string: {
            type: "string",
            required: true,
            description: "Literal replacement text. Use an empty string to delete the match.",
          },
          replace_all: {
            type: "boolean",
            description: "Replace all matches. Defaults to false; when false, old_string must appear exactly once.",
          },
        },
      },
    },
    ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
  };

  ctx.tools.register(defineTool({
    name: "multi_edit",
    description: "Apply several ordered literal replacements to one already-read UTF-8 file in a single call. Prefer multi_edit over repeated edit when changing multiple spans in the same file. Items run in order so later old_string values match the text after earlier items. If any item fails, nothing is written. Based on the latest read content.",
    parameters,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            required: true,
            description: "Canonical absolute path in the filesystem execution world.",
          },
          before: {
            type: "string",
            required: true,
          },
          after: {
            type: "string",
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `The file ${value.path} has been updated successfully.`,
      }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        diffs: computeHunkDiffs(structuredPatch, value.path, value.before, value.after).map(({ path, oldText, newText }) => ({
          path,
          oldText,
          newText,
        })),
      }),
    },
    async execute(args, exec) {
      const input = parseMultiEditArgs(args);
      const sandboxPolicy = await sandbox.resolvePolicy("multi_edit", args, exec);
      const target = await ctx.fs.resolve(input.filePath, await sessionResolveOptions(ctx, exec));
      let outcome;
      try {
        if (typeof ctx.fs.checkedTarget === "function") {
          await ctx.fs.checkedTarget(target, sandboxPolicy);
        }
        const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => undefined);
        let originalLf;
        try {
          originalLf = await readLfBasis(ctx, target, exec.signal, FsError);
        } catch (previewError) {
          const code = previewError && typeof previewError === "object" ? previewError.code : undefined;
          if (code === "FS_NOT_FOUND" || code === "FS_NOT_REGULAR_FILE") {
            if (input.edits.length !== 1) {
              throw previewError;
            }
            const only = input.edits[0];
            outcome = await ctx.fs.editText(target, {
              oldString: only.oldString,
              newString: only.newString,
              replaceAll: only.replaceAll,
            }, intent, exec.signal, sandboxPolicy);
            return mutationResult(ctx, target, outcome, exec);
          }
          throw previewError;
        }
        if (originalLf.length === 0) {
          throw new FsError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
        }
        let current = originalLf;
        for (let index = 0; index < input.edits.length; index++) {
          const item = input.edits[index];
          try {
            current = applyLiteralEdit(
              FsError,
              current,
              item.oldString,
              item.newString,
              item.replaceAll,
              target.displayPath,
            ).content;
          } catch (itemError) {
            throw prefixItemError(FsError, itemError, index + 1);
          }
        }
        outcome = await ctx.fs.editText(target, {
          oldString: originalLf,
          newString: current,
          replaceAll: false,
        }, intent, exec.signal, sandboxPolicy);
      } catch (error) {
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath);
      }
      return mutationResult(ctx, target, outcome, exec);
    },
    presentCall(args) {
      return {
        card: "diff",
        title: `Edit ${args.file_path}`,
        diffs: (args.edits ?? []).map((item) => ({
          path: args.file_path,
          oldText: item.old_string || null,
          newText: item.new_string,
        })),
        locations: [{ path: args.file_path }],
      };
    },
    presentResult(args, result) {
      if (result.isError) return undefined;
      const diffs = diffsFromMeta(result.meta);
      if (diffs === undefined) return undefined;
      return {
        card: "diff",
        title: `Edit ${args.file_path}`,
        diffs,
      };
    },
  }));
}
