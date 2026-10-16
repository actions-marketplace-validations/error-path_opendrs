import { describe, expect, it } from "vitest";
import {
  KAMEI_IDS,
  aucOf,
  bestF1Threshold,
  evaluateModel,
  f1At,
  kameiFeatures,
  parseApacheJit,
  recallAt,
  renderReport,
  CAVEATS,
} from "../../bench/apachejit/lib.js";
import { capturedAt } from "../../src/model/metrics.js";
import { mulberry32 } from "../../src/model/fit.js";

const HEADER = "commit_id,project,buggy,fix,year,author_date,la,ld,nf,nd,ns,ent,ndev,age,nuc,aexp,arexp,asexp";
const ROW = (sha: string, buggy: string) => `${sha},apache/zookeeper,${buggy},False,2017,1500000000,10,2,3,2,1,0.5,4,30.5,6,100,50,20`;
const SHA = "a".repeat(40);

describe("parseApacheJit", () => {
  it("parses rows and maps True/False", () => {
    const [r] = parseApacheJit(`${HEADER}\n${ROW(SHA, "True")}\n`);
    expect(r).toEqual({ sha: SHA, project: "apache/zookeeper", buggy: 1, time: 1500000000,
      kamei: { la: 10, ld: 2, nf: 3, nd: 2, ns: 1, ent: 0.5, ndev: 4, age: 30.5, nuc: 6, aexp: 100, arexp: 50, asexp: 20 } });
  });
  it("accepts CRLF and a trailing blank line", () => {
    expect(parseApacheJit(`${HEADER}\r\n${ROW(SHA, "False")}\r\n\r\n`)).toHaveLength(1);
  });
  it("rejects a wrong header", () => expect(() => parseApacheJit("sha,label\n")).toThrow(/header/));
  it("rejects a malformed row with its line number", () => {
    expect(() => parseApacheJit(`${HEADER}\n${ROW(SHA, "True")}\n${SHA},apache/x,maybe\n`)).toThrow(/line 3/);
  });
});

describe("metrics", () => {
  it("recallAt agrees with opendrs capturedAt, ties included", () => {
    const rand = mulberry32(7);
    const scores = Array.from({ length: 500 }, () => Math.round(rand() * 20) / 20);
    const labels = scores.map(() => (rand() < 0.2 ? 1 : 0));
    for (const k of [5, 10, 30, 50]) expect(recallAt(scores, labels, k)).toBeCloseTo(capturedAt(scores, labels, k), 12);
  });
  it("aucOf is null when a class is absent and 1 for a perfect ranking", () => {
    expect(aucOf([0.1, 0.2], [0, 0])).toBeNull();
    expect(aucOf([0.1, 0.9], [0, 1])).toBe(1);
  });
  it("bestF1Threshold and f1At", () => {
    const scores = [0.9, 0.8, 0.3, 0.1];
    const labels = [1, 1, 0, 0];
    const t = bestF1Threshold(scores, labels);
    expect(f1At(scores, labels, t)).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(f1At(scores, [0, 0, 0, 0], 0.5)).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
  it("bestF1Threshold weighs negatives: a heavier negative weight raises the threshold", () => {
    const scores = [0.9, 0.6, 0.5, 0.4, 0.2];
    const labels = [1, 0, 1, 0, 0];
    expect(bestF1Threshold(scores, labels)).toBe(0.5);
    expect(bestF1Threshold(scores, labels, 10)).toBe(0.9);
  });
  it("evaluateModel on a test set without positives has null AUC, recall and F1", () => {
    const m = evaluateModel({ scores: [0.9, 0.1], labels: [1, 0] }, { scores: [0.5, 0.4], labels: [0, 0] });
    expect(m.auc).toBeNull();
    expect(m.recallAt["10"]).toBeNull();
    expect(m.prf).toBeNull();
    expect(m.positives).toBe(0);
  });
});

it("kameiFeatures applies log1p to counts and leaves ent raw", () => {
  const [r] = parseApacheJit(`${HEADER}\n${ROW(SHA, "True")}\n`);
  const f = kameiFeatures(r!);
  expect(f[KAMEI_IDS.indexOf("la")]).toBeCloseTo(Math.log1p(10));
  expect(f[KAMEI_IDS.indexOf("ent")]).toBe(0.5);
});

it("renderReport shows — for an undefined AUC and includes the caveats", () => {
  const empty = { rows: 2, positives: 0, auc: null, recallAt: { "5": 0, "10": 0, "30": 0, "50": 0 }, prf: { precision: 0, recall: 0, f1: 0 } };
  const md = renderReport({
    meta: { version: "0.1.5", commit: "abc", date: "2026-10-16", hashes: { "apachejit_train.csv": "x" } },
    pooled: [],
    projects: [{ project: "apache/hadoop", coverage: { train: { labelled: 1, replayed: 1 }, test: { labelled: 2, replayed: 2 } }, models: { default: empty }, warnings: [] }],
  });
  expect(md).toContain("—");
  for (const c of CAVEATS) expect(md).toContain(c);
  expect(md).not.toContain("NaN");
});
