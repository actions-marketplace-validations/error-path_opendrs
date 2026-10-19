import { describe, expect, it } from "vitest";
import { addedPackages } from "../../src/architecture/manifests.js";

describe("addedPackages: package.json", () => {
  const base = JSON.stringify({ dependencies: { foo: "^1.0.0" }, devDependencies: { eslint: "^8.0.0" } });

  it("a new dependencies name is runtime", () => {
    const head = JSON.stringify({ dependencies: { foo: "^1.0.0", jsonwebtoken: "^9.0.0" }, devDependencies: { eslint: "^8.0.0" } });
    expect(addedPackages("package.json", base, head)).toEqual({ runtime: ["jsonwebtoken"], dev: [] });
  });

  it("a new devDependencies name is dev", () => {
    const head = JSON.stringify({ dependencies: { foo: "^1.0.0" }, devDependencies: { eslint: "^8.0.0", vitest: "^2.0.0" } });
    expect(addedPackages("package.json", base, head)).toEqual({ runtime: [], dev: ["vitest"] });
  });

  it("a version bump is not an addition", () => {
    const head = JSON.stringify({ dependencies: { foo: "^2.0.0" }, devDependencies: { eslint: "^8.0.0" } });
    expect(addedPackages("package.json", base, head)).toEqual({ runtime: [], dev: [] });
  });

  it("invalid JSON yields an error", () => {
    const result = addedPackages("package.json", base, "{ not json");
    expect(result).toHaveProperty("error");
  });
});

describe("addedPackages: go.mod", () => {
  const base = "module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n)\n";
  const head = "module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n\tgithub.com/baz/qux v0.1.0\n)\n";

  it("a new require entry is runtime", () => {
    expect(addedPackages("go.mod", base, head)).toEqual({ runtime: ["github.com/baz/qux"], dev: [] });
  });
});

describe("addedPackages: requirements.txt", () => {
  const base = "flask==2.0.0\n# a comment\n\nrequests>=2.0\n";
  const head = "flask==2.0.0\n# a comment\n\nrequests>=2.0\npyjwt==2.8.0\n";

  it("a new line is runtime, ignoring comments and blank lines", () => {
    expect(addedPackages("requirements.txt", base, head)).toEqual({ runtime: ["pyjwt"], dev: [] });
  });
});

describe("addedPackages: pyproject.toml", () => {
  const base = '[project]\nname = "app"\ndependencies = [\n  "flask>=2.0",\n]\n\n[project.optional-dependencies]\ntest = ["pytest>=7"]\n';
  const head =
    '[project]\nname = "app"\ndependencies = [\n  "flask>=2.0",\n  "pyjwt>=2.0",\n]\n\n[project.optional-dependencies]\ntest = ["pytest>=7", "coverage>=6"]\n';

  it("a new [project] dependency is runtime; a new optional-dependencies entry is dev", () => {
    expect(addedPackages("pyproject.toml", base, head)).toEqual({ runtime: ["pyjwt"], dev: ["coverage"] });
  });

  it("an unclosed table header yields an error", () => {
    const result = addedPackages("pyproject.toml", base, '[project\nname = "app"\n');
    expect(result).toHaveProperty("error");
  });
});

describe("addedPackages: Cargo.toml", () => {
  const base = '[dependencies]\nserde = "1.0"\n\n[dev-dependencies]\nmockall = "0.11"\n';
  const head = '[dependencies]\nserde = "1.0"\njsonwebtoken = "9.0"\n\n[dev-dependencies]\nmockall = "0.11"\nproptest = "1.0"\n';

  it("a new [dependencies] entry is runtime; a new [dev-dependencies] entry is dev", () => {
    expect(addedPackages("Cargo.toml", base, head)).toEqual({ runtime: ["jsonwebtoken"], dev: ["proptest"] });
  });
});

describe("addedPackages: pom.xml", () => {
  const base = "<project><dependencies>\n<dependency><groupId>g</groupId><artifactId>foo</artifactId></dependency>\n</dependencies></project>";
  const head =
    "<project><dependencies>\n<dependency><groupId>g</groupId><artifactId>foo</artifactId></dependency>\n" +
    "<dependency><groupId>g</groupId><artifactId>junit</artifactId><scope>test</scope></dependency>\n</dependencies></project>";

  it("a dependency with <scope>test</scope> is dev", () => {
    expect(addedPackages("pom.xml", base, head)).toEqual({ runtime: [], dev: ["junit"] });
  });

  it("mismatched <dependency> tags yield an error", () => {
    const result = addedPackages("pom.xml", base, "<project><dependencies><dependency></dependencies></project>");
    expect(result).toHaveProperty("error");
  });
});

describe("addedPackages: build.gradle.kts", () => {
  const base = 'dependencies {\n    implementation("com.foo:bar:1.0")\n}\n';
  const head = 'dependencies {\n    implementation("com.foo:bar:1.0")\n    testImplementation("org.junit:junit:5.0")\n}\n';

  it("implementation is runtime; testImplementation is dev", () => {
    expect(addedPackages("build.gradle.kts", base, head)).toEqual({ runtime: [], dev: ["org.junit:junit"] });
  });
});

describe("addedPackages: Gemfile", () => {
  const base = 'gem "rails"\n';
  const head = 'gem "rails"\ngem "pry"\n\ngroup :test do\n  gem "rspec"\nend\n';

  it("a top-level gem is runtime; a gem in group :test is dev", () => {
    expect(addedPackages("Gemfile", base, head)).toEqual({ runtime: ["pry"], dev: ["rspec"] });
  });
});

describe("addedPackages: new manifest", () => {
  it("base undefined (new manifest) reports every name as added", () => {
    const head = JSON.stringify({ dependencies: { foo: "^1.0.0" }, devDependencies: { eslint: "^8.0.0" } });
    expect(addedPackages("package.json", undefined, head)).toEqual({ runtime: ["foo"], dev: ["eslint"] });
  });
});
