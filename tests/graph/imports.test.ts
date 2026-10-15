import { describe, expect, it } from "vitest";
import { extractImports, languageOf } from "../../src/graph/imports.js";

const sorted = (xs: string[]) => [...xs].sort();

describe("languageOf", () => {
  it.each([
    ["a/b.ts", "js"],
    ["a/b.tsx", "js"],
    ["a/b.d.ts", "js"],
    ["b.jsx", "js"],
    ["b.mjs", "js"],
    ["b.cjs", "js"],
    ["b.js", "js"],
    ["x.py", "python"],
    ["x.go", "go"],
    ["X.java", "java"],
    ["X.kt", "kotlin"],
    ["build.gradle.kts", "kotlin"],
    ["lib.rs", "rust"],
    ["x.rb", "ruby"],
    ["README.md", undefined],
    ["Makefile", undefined],
    ["main.c", undefined],
  ])("%s -> %s", (path, lang) => {
    expect(languageOf(path)).toBe(lang);
  });
});

describe("extractImports: TS/JS", () => {
  it("finds static, side-effect, type, re-export, dynamic and require imports", () => {
    const src = `
import a from "./a";
import { b,
  c as d } from './b.js';
import * as ns from "@scope/pkg/sub";
import type { T } from "./types";
import "./side-effect";
export * from "./reexport";
export { x } from "./reexport2";
const lazy = await import("./lazy");
const cjs = require('./cjs');
`;
    expect(sorted(extractImports("src/x.ts", src))).toEqual(
      sorted(["./a", "./b.js", "@scope/pkg/sub", "./types", "./side-effect", "./reexport", "./reexport2", "./lazy", "./cjs"]),
    );
  });

  it("ignores imports inside comments, strings and regex literals", () => {
    const src = `
// import a from "./commented";
/* import b from "./block";
   require("./block2") */
const s = "import c from './in-string'";
const t = \`require("./in-template")\`;
const re = /import d from '.\\/in-regex'/;
const q = /['"]/g; import e from "./real";
`;
    expect(extractImports("x.js", src)).toEqual(["./real"]);
  });

  it("does not treat division as a regex", () => {
    const src = `const r = a / b; const s = c / d;\nimport x from "./after-division";`;
    expect(extractImports("x.ts", src)).toEqual(["./after-division"]);
  });
});

describe("extractImports: Python", () => {
  it("handles import, from-import, relative dots and parenthesised lists", () => {
    const src = `
import os
import a.b as ab, c
from .x import y
from .. import sibling
from pkg.mod import (
    one,
    two as deux,
)
def f():
    import lazy.mod
`;
    expect(sorted(extractImports("p/q.py", src))).toEqual(
      sorted([
        "os",
        "a.b",
        "c",
        ".x",
        ".x.y",
        "..",
        "..sibling",
        "pkg.mod",
        "pkg.mod.one",
        "pkg.mod.two",
        "lazy.mod",
      ]),
    );
  });

  it("ignores commented imports and imports inside docstrings", () => {
    const src = `
# import commented
"""
import in_docstring
from also import nothing
"""
x = "import in_string"
import real  # import trailing
`;
    expect(extractImports("m.py", src)).toEqual(["real"]);
  });

  it("ignores star in from-import and keeps the module", () => {
    expect(extractImports("m.py", "from pkg.mod import *\n")).toEqual(["pkg.mod"]);
  });
});

describe("extractImports: Go", () => {
  it("handles single, aliased and grouped imports", () => {
    const src = `package main

import "fmt"
import alias "example.com/m/pkg/a"
import (
	"os"
	b "example.com/m/pkg/b"
	_ "example.com/m/pkg/c" // side effect
	// "example.com/m/pkg/commented"
)
`;
    expect(sorted(extractImports("main.go", src))).toEqual(
      sorted(["fmt", "example.com/m/pkg/a", "os", "example.com/m/pkg/b", "example.com/m/pkg/c"]),
    );
  });

  it("ignores imports in raw strings and block comments", () => {
    const src = "package x\n/*\nimport \"bad/one\"\n*/\nvar s = `\nimport \"bad/two\"\n`\nimport \"good\"\n";
    expect(extractImports("x.go", src)).toEqual(["good"]);
  });
});

describe("extractImports: Java/Kotlin", () => {
  it("handles class, wildcard and static imports in Java", () => {
    const src = `package com.acme.app;

import com.acme.util.Strings;
import com.acme.model.*;
import static com.acme.util.Math.max;
// import com.acme.commented.Nope;
/* import com.acme.block.Nope; */
`;
    expect(sorted(extractImports("App.java", src))).toEqual(
      sorted(["com.acme.util.Strings", "com.acme.model.*", "com.acme.util.Math.max"]),
    );
  });

  it("handles Kotlin imports with aliases", () => {
    const src = `package com.acme
import com.acme.util.Strings as S
import com.acme.model.*
`;
    expect(sorted(extractImports("App.kt", src))).toEqual(sorted(["com.acme.util.Strings", "com.acme.model.*"]));
  });
});

describe("extractImports: Rust", () => {
  it("handles mod declarations, crate/super/self uses and brace groups", () => {
    const src = `
mod parser;
pub mod lexer;
pub(crate) mod util;
mod inline { fn f() {} }
use crate::a::b;
use super::sibling::Thing;
use self::parser::{parse, Parser as P, nested::{deep, other}};
use std::collections::HashMap;
// use crate::commented;
/* mod block_commented; */
fn lifetimes<'a>(x: &'a str) -> &'a str { let c = '"'; x }
`;
    expect(sorted(extractImports("src/lib.rs", src))).toEqual(
      sorted([
        "mod:parser",
        "mod:lexer",
        "mod:util",
        "crate::a::b",
        "super::sibling::Thing",
        "self::parser::parse",
        "self::parser::Parser",
        "self::parser::nested::deep",
        "self::parser::nested::other",
        "std::collections::HashMap",
      ]),
    );
  });
});

describe("extractImports: Ruby", () => {
  it("handles require and require_relative, ignoring comments", () => {
    const src = `
require "json"
require_relative "helpers/format"
require_relative '../lib/thing'
# require_relative "commented"
x = "require 'in_string'"
`;
    expect(sorted(extractImports("app/x.rb", src))).toEqual(sorted(["json", "./helpers/format", "../lib/thing"]));
  });
});

describe("extractImports: unsupported", () => {
  it("returns nothing for unknown languages", () => {
    expect(extractImports("README.md", "import x from './y'")).toEqual([]);
  });
});
