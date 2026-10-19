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
    // Ruby: no cross-line visibility tracking, so this is an approximation (documented in
    // public-decl.ts): top-level class/module, top-level def, and def self.x (unaffected by a
    // bare `private` call). An ordinary indented instance method is not counted.
    ["x.rb", "class Foo", true],
    ["x.rb", "module Foo", true],
    ["x.rb", "  class Nested", false],
    ["x.rb", "def self.create", true],
    ["x.rb", "  def self.create", true],
    ["x.rb", "def anything", true],
    ["x.rb", "  def anything", false],
    ["x.rb", "  private", false],
    // Swift: requires the explicit public/open keyword (Swift's default access level is internal).
    ["x.swift", "public func foo() {}", true],
    ["x.swift", "open class Foo {}", true],
    ["x.swift", "public class Bar {}", true],
    ["x.swift", "public struct S {}", true],
    ["x.swift", "public enum E {}", true],
    ["x.swift", "public protocol P {}", true],
    ["x.swift", "public var x: Int", true],
    ["x.swift", "public let y: Int", true],
    ["x.swift", "public typealias T = Int", true],
    ["x.swift", "public init(x: Int) {}", true],
    ["x.swift", "public static func foo() {}", true],
    ["x.swift", "  public func nested() {}", true],
    ["x.swift", "internal func foo() {}", false],
    ["x.swift", "private func foo() {}", false],
    ["x.swift", "func foo() {}", false],
    ["README.md", "export function f() {}", false],
  ])("%s: %s -> %s", (path, line, expected) => {
    expect(isPublicDeclaration(path, line)).toBe(expected);
  });
});
