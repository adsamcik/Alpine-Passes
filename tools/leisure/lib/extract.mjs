export function extractAssignedArray(source, names) {
  const searchNames = Array.isArray(names) ? names : [names];
  let start = -1;
  let chosenName = null;

  for (const name of searchNames.filter(Boolean)) {
    const assignment = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*\\[`, "m");
    const match = assignment.exec(source);
    if (match) {
      start = source.indexOf("[", match.index);
      chosenName = name;
      break;
    }
  }

  if (start < 0) {
    const generic = /(?:const|let|var)\s+([A-Z0-9_]+_POIS|ALPS_RAW)\s*=\s*\[/m.exec(source);
    if (generic) {
      start = source.indexOf("[", generic.index);
      chosenName = generic[1];
    }
  }

  if (start < 0) {
    throw new Error(`Could not find array assignment for ${searchNames.join(", ")}`);
  }

  const end = findMatchingBracket(source, start);
  const literal = source.slice(start, end + 1);
  return {
    name: chosenName,
    value: parseArrayLiteral(literal),
  };
}

function parseArrayLiteral(literal) {
  const jsonish = stripJsComments(literal).replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(jsonish);
  } catch (jsonError) {
    try {
      return Function(`"use strict"; return (${literal});`)();
    } catch (jsError) {
      jsError.message = `${jsError.message}; JSON parse failed with: ${jsonError.message}`;
      throw jsError;
    }
  }
}

function findMatchingBracket(source, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];

    if (lineComment) {
      if (c === "\n" || c === "\r") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (c === "*" && n === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }

    if (c === "/" && n === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "[") depth += 1;
    if (c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error("Unterminated array literal");
}

function stripJsComments(source) {
  let out = "";
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];

    if (lineComment) {
      if (c === "\n" || c === "\r") {
        lineComment = false;
        out += c;
      }
      continue;
    }

    if (blockComment) {
      if (c === "*" && n === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }

    if (quote) {
      out += c;
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }

    if (c === "/" && n === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      quote = c;
    }
    out += c;
  }

  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
