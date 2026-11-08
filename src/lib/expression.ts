/**
 * Tiny, safe math-expression compiler for surface graphs h(x, z).
 * No eval/Function: the input is parsed into a tree of closures.
 *
 * Supports: numbers, x, z, pi, e, + - * / ^ (or **), parentheses,
 * implicit multiplication ("2x", "3sin(x)", "x z"), and the functions
 * sin cos tan asin acos atan sinh cosh tanh abs sqrt exp ln log log10
 * floor ceil round sign min max pow atan2 mod.
 */

export type SurfaceFn = (x: number, z: number) => number;
export type CompileResult =
  | { ok: true; fn: SurfaceFn }
  | { ok: false; error: string };

type Node = (x: number, z: number) => number;
type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const FUNCS1: Record<string, (a: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp,
  ln: Math.log, log: Math.log, log10: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
};
const FUNCS2: Record<string, (a: number, b: number) => number> = {
  min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2,
  mod: (a, b) => ((a % b) + b) % b,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const re =
    /\s+|(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|(\*\*|[-+*/^(),])/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`unexpected "${src[i]}"`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2].toLowerCase() });
    else if (m[3] !== undefined) out.push({ t: "op", v: m[3] === "**" ? "^" : m[3] });
  }
  return out;
}

function parse(tokens: Token[]): Node {
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const startsPrimary = () => {
    const k = peek();
    return !!k && (k.t === "num" || k.t === "id" || (k.t === "op" && k.v === "("));
  };

  function expr(): Node {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const plus = (tokens[p++] as { v: string }).v === "+";
      const l = left, r = term();
      left = plus ? (x, z) => l(x, z) + r(x, z) : (x, z) => l(x, z) - r(x, z);
    }
    return left;
  }

  function term(): Node {
    let left = unary();
    for (;;) {
      let op: string;
      if (isOp("*") || isOp("/")) op = (tokens[p++] as { v: string }).v;
      else if (startsPrimary()) op = "*"; // implicit multiplication
      else break;
      const l = left, r = unary();
      left = op === "*" ? (x, z) => l(x, z) * r(x, z) : (x, z) => l(x, z) / r(x, z);
    }
    return left;
  }

  function unary(): Node {
    if (isOp("-")) {
      p++;
      const a = unary();
      return (x, z) => -a(x, z);
    }
    if (isOp("+")) {
      p++;
      return unary();
    }
    return power();
  }

  function power(): Node {
    const base = primary();
    if (isOp("^")) {
      p++;
      const e = unary(); // right-associative, allows 2^-1
      return (x, z) => Math.pow(base(x, z), e(x, z));
    }
    return base;
  }

  function primary(): Node {
    const k = tokens[p++];
    if (!k) throw new Error("expression ended unexpectedly");
    if (k.t === "num") {
      const v = k.v;
      return () => v;
    }
    if (k.t === "op") {
      if (k.v !== "(") throw new Error(`unexpected "${k.v}"`);
      const inner = expr();
      if (!isOp(")")) throw new Error('missing ")"');
      p++;
      return inner;
    }
    // identifier
    const name = k.v;
    if (isOp("(") && (name in FUNCS1 || name in FUNCS2)) {
      p++;
      const args = [expr()];
      while (isOp(",")) {
        p++;
        args.push(expr());
      }
      if (!isOp(")")) throw new Error('missing ")"');
      p++;
      if (name in FUNCS1) {
        if (args.length !== 1) throw new Error(`${name}() takes 1 argument`);
        const f = FUNCS1[name], a = args[0];
        return (x, z) => f(a(x, z));
      }
      if (args.length !== 2) throw new Error(`${name}() takes 2 arguments`);
      const f = FUNCS2[name], [a, b] = args;
      return (x, z) => f(a(x, z), b(x, z));
    }
    if (name in FUNCS1) {
      // calculator style: "sin x", "sin x^2", "sin -x" (argument binds like a unary term)
      if (startsPrimary() || isOp("-") || isOp("+")) {
        const f = FUNCS1[name], a = unary();
        return (x, z) => f(a(x, z));
      }
    }
    if (name === "x") return (x) => x;
    if (name === "z") return (_x, z) => z;
    if (name in CONSTS) {
      const v = CONSTS[name];
      return () => v;
    }
    if (/^[xz]+$/.test(name)) {
      // "xz" -> x*z, "xx" -> x*x
      const chars = [...name];
      return (x, z) => chars.reduce((acc, c) => acc * (c === "x" ? x : z), 1);
    }
    if (name in FUNCS1 || name in FUNCS2) throw new Error(`${name} needs parentheses, e.g. ${name}(x)`);
    throw new Error(`unknown name "${name}" (use x and z)`);
  }

  const root = expr();
  if (p < tokens.length) {
    const k = tokens[p];
    throw new Error(`unexpected "${k.t === "num" ? k.v : k.v}"`);
  }
  return root;
}

/** Accept the symbols people paste or type: π, ², ×, ÷, ·, unicode minus, trailing ";". */
function normalize(src: string) {
  return src
    .replace(/π/g, " pi ")
    .replace(/[×·∗]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–]/g, "-")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/[;\s]+$/, "");
}

/** Compile "0.2*sin(5x)*cos(5z)" (optionally written "y = ..." / "h(x,z) = ...") into a function. */
export function compileSurface(source: string): CompileResult {
  let src = normalize(source.trim());
  if (src.includes("=")) src = src.slice(src.lastIndexOf("=") + 1);
  if (!src.trim()) return { ok: false, error: "enter an expression in x and z" };
  try {
    const node = parse(tokenize(src));
    // reject expressions that never produce a usable number over the tank footprint
    let finite = 0;
    for (let i = 0; i <= 8; i++)
      for (let k = 0; k <= 8; k++) {
        if (Number.isFinite(node(i * 12.5, k * 12.5))) finite++;
      }
    if (finite === 0) return { ok: false, error: "expression has no valid values over the tank" };
    return { ok: true, fn: node };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid expression" };
  }
}
