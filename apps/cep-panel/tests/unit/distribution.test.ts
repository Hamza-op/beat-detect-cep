import { describe, expect, it } from "vitest";
import { selectDistributedBeats } from "../../src/panel/markers/distribution";

const beats = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    time: index * 0.5,
    score: 0.5 + (index % 5) * 0.1,
    id: index,
  }));

describe("distributed beat selection", () => {
  it("keeps the exact requested percentage", () => {
    expect(selectDistributedBeats(beats(200), 50)).toHaveLength(100);
    expect(selectDistributedBeats(beats(200), 25)).toHaveLength(50);
    expect(selectDistributedBeats(beats(201), 50)).toHaveLength(101);
  });

  it("selects one beat from every equal source window", () => {
    const selected = selectDistributedBeats(beats(20), 25);
    expect(selected).toHaveLength(5);
    selected.forEach((event, slot) => {
      expect(event.id).toBeGreaterThanOrEqual(slot * 4);
      expect(event.id).toBeLessThan((slot + 1) * 4);
    });
  });

  it("favours a strong hit while using the middle to break equal-strength ties", () => {
    const strong = beats(8).map((event) => ({ ...event, score: 0.5 }));
    strong[3].score = 1;
    expect(selectDistributedBeats(strong, 25)[0].id).toBe(3);

    const equal = beats(8).map((event) => ({ ...event, score: 0.5 }));
    expect(selectDistributedBeats(equal, 25).map((event) => event.id)).toEqual([
      1, 5,
    ]);
  });

  it("returns all detector events unchanged at 100 percent", () => {
    const source = beats(12);
    expect(selectDistributedBeats(source, 100)).toEqual(source);
  });
});
