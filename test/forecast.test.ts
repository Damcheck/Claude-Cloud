import { describe, expect, it } from "vitest";
import { aggregate, brier, weightFor } from "../src/council/forecast";
import { pickCrux } from "../src/council/crux";
import { mostTypical } from "../src/council/diversity";
import { meanPairwiseSimilarity } from "../src/evals/suite";

describe("forecasting", () => {
  it("scores Brier", () => {
    expect(brier([{ p: 1, o: 1 }])).toBe(0);
    expect(brier([{ p: 0.5, o: 0 }, { p: 0.5, o: 1 }])).toBe(0.25);
    expect(brier([])).toBeNull();
  });

  it("weights good forecasters more, and uses domain history when there's enough", () => {
    const sharp = Array.from({ length: 5 }, () => ({ p: 0.9, o: 1, domain: "market" }));
    const coin = Array.from({ length: 5 }, () => ({ p: 0.5, o: 1, domain: "market" }));
    expect(weightFor(sharp, "market")).toBeGreaterThan(weightFor(coin, "market"));
    expect(weightFor([], "market")).toBe(1);
  });

  it("aggregates and extremizes", () => {
    expect(aggregate([{ p: 0.5, w: 1 }])).toBeCloseTo(0.5);
    expect(aggregate([{ p: 0.7, w: 1 }, { p: 0.7, w: 1 }])).toBeGreaterThan(0.7);
    expect(aggregate([{ p: 0.9, w: 3 }, { p: 0.1, w: 1 }])).toBeGreaterThan(0.5);
    expect(aggregate([{ p: 1, w: 1 }])).toBeLessThanOrEqual(0.98);
  });
});

describe("deliberation helpers", () => {
  it("picks the first real crux", () => {
    expect(pickCrux({ positions: [], disagreements: [{ between: ["a", "b"], about: "x", crux: " Do merchants pay? ", empirical: true }] })).toEqual({ crux: "Do merchants pay?", empirical: true });
    expect(pickCrux(null)).toBeNull();
  });

  it("finds the most typical answer and measures similarity", () => {
    const v = [
      [1, 0],
      [0.9, 0.1],
      [0.95, 0.05],
      [0, 1],
    ];
    expect(mostTypical(v)).toBe(1); // closest to all the others, including the outlier
    expect(meanPairwiseSimilarity([[1, 0], [1, 0]])).toBeCloseTo(1);
    expect(meanPairwiseSimilarity([[1, 0], [0, 1]])).toBeCloseTo(0);
  });
});
