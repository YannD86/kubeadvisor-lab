/**
 * Derive the dot-path (a.b[0].c) of the YAML key on a given line, from indentation alone.
 * Good enough for the hint-on-highlight feature; it does not need to be a full parser.
 */
export function pathAtLine(text: string, lineNo: number): string | null {
  const lines = text.split("\n");
  if (lineNo < 0 || lineNo >= lines.length) return null;
  // stack of {indent, key} ; list indices tracked per indent
  type Frame = { indent: number; key: string; isList?: boolean; count: number };
  const stack: Frame[] = [];
  let result: string | null = null;
  for (let i = 0; i <= lineNo; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) { if (i === lineNo) return result; continue; }
    const indent = raw.search(/\S/);
    let body = raw.slice(indent);
    let isItem = false;
    let itemIndent = indent;
    if (body.startsWith("- ") || body === "-") { isItem = true; body = body.slice(2).trimStart(); itemIndent = indent; }
    while (stack.length && stack[stack.length - 1].indent >= indent && !(isItem && stack[stack.length - 1].indent === indent && stack[stack.length - 1].isList)) stack.pop();
    if (isItem) {
      // list item under the parent key at a smaller (or equal, for "key:\n- a" style) indent
      let parent = stack[stack.length - 1];
      if (!parent || !parent.isList) {
        // mark the parent as a list container
        if (parent) { parent.isList = true; parent.count = parent.count ?? 0; }
        else { stack.push({ indent: -1, key: "", isList: true, count: 0 }); parent = stack[stack.length - 1]; }
      }
      const idx = parent.count++;
      // push a virtual frame for the item so nested keys attach to [idx]
      stack.push({ indent: itemIndent, key: `[${idx}]`, count: 0 });
      // the item may itself start with "key: value"
      const m = body.match(/^([^:\s][^:]*?):(\s|$)/);
      if (m) {
        stack.push({ indent: itemIndent + 2, key: m[1].trim(), count: 0 });
        if (i === lineNo) { result = build(stack); return result; }
        continue;
      }
      if (i === lineNo) { result = build(stack); return result; }
      continue;
    }
    const m = body.match(/^([^:\s][^:]*?):(\s|$)/);
    if (m) {
      stack.push({ indent, key: m[1].trim(), count: 0 });
      if (i === lineNo) { result = build(stack); return result; }
    } else if (i === lineNo) {
      result = build(stack);
      return result;
    }
  }
  return result;
}

function build(stack: { key: string }[]): string {
  let out = "";
  for (const f of stack) {
    if (!f.key) continue;
    if (f.key.startsWith("[")) out += f.key;
    else out += (out ? "." : "") + f.key;
  }
  return out;
}

/** Find the step whose path best matches the cursor path (exact, else longest prefix either way). */
export function matchStep(paths: string[], cursorPath: string | null): number {
  if (!cursorPath) return -1;
  const exact = paths.indexOf(cursorPath);
  if (exact >= 0) return exact;
  let best = -1, bestLen = 0;
  paths.forEach((p, i) => {
    const a = p, b = cursorPath;
    if (b.startsWith(a + ".") || b.startsWith(a + "[") || a.startsWith(b + ".") || a.startsWith(b + "[")) {
      const l = Math.min(a.length, b.length);
      if (l > bestLen) { bestLen = l; best = i; }
    }
  });
  return best;
}
