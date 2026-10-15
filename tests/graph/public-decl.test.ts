import { describe, expect, it } from "vitest";
import { isPublicDeclaration } from "../../src/graph/public-decl.js";

describe("isPublicDeclaration", () => {
  it.each([
    ["a.ts", "export function f() {}", true],
    ["a.ts", "  export const x = 1;", true],
    ["a.ts", "export default class A {}", true],
    ["a.js", "module.exports = { f };", true],
    ["a.js", "exports.f = f;", true],
    ["a.ts", "function internal() {}", false],
    ["a.ts", "const exported = 1;", false],
    ["m.py", "def handler(req):", true],
    ["m.py", "async def fetch():", true],
    ["m.py", "class Service:", true],
    ["m.py", "def _private():", false],
    ["m.py", "    def method(self):", false],
    ["x.go", "func Exported() {}", true],
    ["x.go", "func (s *Server) Serve() error {", true],
    ["x.go", "type Config struct {", true],
    ["x.go", "var Default = 1", true],
    ["x.go", "const MaxSize = 10", true],
    ["x.go", "func helper() {}", false],
    ["x.go", "func (s *Server) handle() {", false],
    ["X.java", "public class X {", true],
    ["X.java", "    public void run() {", true],
    ["X.java", "    private void run() {", false],
    ["X.java", "    void pkgPrivate() {", false],
    ["X.kt", "fun topLevel() = 1", true],
    ["X.kt", "data class User(val id: Int)", true],
    ["X.kt", "    public fun member() = 1", true],
    ["X.kt", "private fun hidden() = 1", false],
    ["X.kt", "internal class Hidden", false],
    ["X.kt", "    val local = 1", false],
    ["lib.rs", "pub fn parse() {}", true],
    ["lib.rs", "    pub(crate) struct S;", true],
    ["lib.rs", "fn private() {}", false],
    ["x.rb", "def anything", false],
    ["README.md", "export function f() {}", false],
  ])("%s: %s -> %s", (path, line, expected) => {
    expect(isPublicDeclaration(path, line)).toBe(expected);
  });
});
